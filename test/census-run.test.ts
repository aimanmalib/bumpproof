import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Candidate } from '../src/census.ts';
import {
  applyRun, bumpLabel, controlOutcome, countsOf, nextCandidates, overallControl, readResults, rowFor, upsertRow, type CensusRow,
} from '../src/census-results.ts';
import { appPath, censusJourneys, commitInto, journeysPath, specificFolder } from '../src/census-run.ts';
import { loadConfig } from '../src/config.ts';
import { run } from '../src/proc.ts';
import type { JourneyRun, RunReport } from '../src/report/run.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';

const cfg = loadConfig(tmpdir());

const cand = (repo: string, o: Partial<Candidate> = {}): Candidate => ({
  repo, url: `https://github.com/${repo}`, status: 'eligible', reasons: [],
  pr: { repo, number: 7, title: 'Bump vite from 6.3.5 to 6.4.6', url: `https://github.com/${repo}/pull/7`, created_at: '2026-11-20T00:00:00Z',
    bot: 'dependabot', ci: 'green' },
  license: 'MIT', stars: 3, dir: '', watched: [{ name: 'vite', from: '6.3.5', to: '6.4.6', type: 'minor' }], ...o,
} as Candidate);

const jr = (status: JourneyRun['status'], healed = false): JourneyRun =>
  ({ status, seconds: 10, credits: 5, healed, failed_step: null, remark: null, result_code: null });

test('the control compares the authoring run with the replay on the same base code', () => {
  assert.equal(controlOutcome(jr('passed'), jr('passed')), 'same');
  assert.equal(controlOutcome(jr('passed'), jr('passed', true)), 'same');
  assert.equal(controlOutcome(jr('passed'), jr('failed')), 'false_alarm');
  assert.equal(controlOutcome(jr('passed'), jr('error')), 'inconclusive');
  assert.equal(controlOutcome(jr('passed'), null), 'inconclusive');
  // A journey that never passed on the base says nothing about the tool.
  assert.equal(controlOutcome(jr('failed'), jr('failed')), 'not_run');
  assert.equal(controlOutcome(null, jr('passed')), 'not_run');
  assert.equal(overallControl(['same', 'false_alarm', 'inconclusive']), 'false_alarm');
  assert.equal(overallControl(['same', 'inconclusive']), 'inconclusive');
  assert.equal(overallControl(['same', 'not_run']), 'same');
  assert.equal(overallControl(['not_run']), 'not_run');
});

const report = (verdict: RunReport['verdict']['verdict'], reason: string, credits = 30): RunReport => ({
  run_id: 'r1', credits_consumed: credits, verdict: { verdict, reason, evaluated: 2 },
  journeys: [
    { name: 'home', base: jr('passed'), head: jr('failed'), after_fix: jr('passed'), outcome: 'regression', new_console_errors: [], new_network_errors: [] },
    { name: 'nav', base: jr('failed'), head: null, after_fix: null, outcome: 'baseline_red', new_console_errors: [], new_network_errors: [] },
  ],
} as unknown as RunReport);

test('applyRun fills verdict, control, H3 and credits from the run record and the authoring runs', () => {
  const authored = new Map([['home', jr('passed')], ['nav', jr('passed')], ['specific', jr('failed')]]);
  const kinds = new Map([['home', 'generic' as const], ['nav', 'generic' as const], ['specific', 'specific' as const]]);
  const row = applyRun(rowFor(cand('a/b'), 'now'), report('fixed', 'fixed_regression'), authored, kinds, 12.5);
  assert.equal(row.verdict, 'fixed');
  assert.equal(row.control, 'false_alarm', 'nav passed when authored and failed on the replay');
  assert.deepEqual(row.journeys.map((j) => [j.name, j.kind, j.control, j.head, j.after_fix]), [
    ['home', 'generic', 'same', 'regression', 'passed'],
    ['nav', 'generic', 'false_alarm', 'baseline_red', null],
    ['specific', 'specific', 'not_run', null, null],
  ]);
  assert.equal(row.ci_green_but_broken, true, 'CI green and the head broke (then fixed)');
  assert.equal(row.credits, 42.5);
  const safe = applyRun(rowFor(cand('a/b'), 'now'), report('safe', 'all_same'), authored, kinds, 0);
  assert.equal(safe.ci_green_but_broken, false);
  const red = applyRun(rowFor(cand('a/b', { pr: { ...cand('a/b').pr, ci: 'red' } }), 'now'), report('broken', 'regression'), authored, kinds, 0);
  assert.equal(red.ci_green_but_broken, false, 'CI already said red');
});

test('counts come from the rows only, and rows keep candidate order when replaced', () => {
  let res = readResults(join(tmpdir(), 'no-such-census.json'), 'newest_pr_first', ['home_test.md']);
  const order = ['x/one', 'x/two', 'x/three'];
  const r = (repo: string, o: Partial<CensusRow>): CensusRow => ({ ...rowFor(cand(repo), 'now'), ...o });
  res = upsertRow(res, r('x/three', { verdict: 'unrunnable', reason: 'base_build_failed', duration_s: 60 }), order, 't1');
  res = upsertRow(res, r('x/one', { verdict: 'safe', control: 'same', credits: 10.25, duration_s: 100 }), order, 't2');
  res = upsertRow(res, r('x/two', { verdict: 'broken', control: 'false_alarm', ci_green_but_broken: true, credits: 1 }), order, 't3');
  res = upsertRow(res, r('x/one', { verdict: 'fixed', control: 'same', credits: 20, duration_s: 100 }), order, 't4');
  assert.deepEqual(res.repos.map((x) => x.repo), order);
  assert.deepEqual({ ...res.counts }, {
    run: 3, runnable: 2, safe: 0, fixed: 1, broken: 1, unrunnable: 1, ci_green_but_broken: 1, control_same: 1,
    control_false_alarm: 1, control_inconclusive: 0, credits: 21, duration_s: 160,
  });
  assert.equal(res.generated_at, 't4');
  assert.deepEqual(countsOf([]).run, 0);
});

test('nextCandidates takes eligible candidates without a row, in file order, or the one named', () => {
  const all = [cand('a/1'), cand('a/2', { status: 'excluded' }), cand('a/3'), cand('a/4'), cand('a/5')];
  const done = [rowFor(cand('a/3'), 'now')];
  assert.deepEqual(nextCandidates(all, done, 2).map((c) => c.repo), ['a/1', 'a/4']);
  assert.deepEqual(nextCandidates(all, done, 1, 'A/3').map((c) => c.repo), ['a/3'], 'named: runs again');
  assert.deepEqual(nextCandidates(all, done, 4, 'a/2'), [], 'excluded candidates never run');
  assert.equal(bumpLabel(cand('a/1')), 'vite 6.3.5 → 6.4.6');
});

test('census journeys: generic ones from config with port and path, the app\'s own folder adds or replaces', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bumpproof-census-j-'));
  try {
    const generic = censusJourneys(cfg, cwd, 'o/app');
    assert.ok(generic.length >= 2);
    assert.ok(generic.every((g) => g.kind === 'generic' && g.content.includes(`url: http://127.0.0.1:${cfg.port}/\n`)));
    const own = join(cwd, cfg.census.specific_journeys_dir, specificFolder('o/app'));
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'app.json'), '{ "path": "/sub/" }');
    writeFileSync(join(own, 'specific_test.md'), '---\nurl: http://127.0.0.1:{port}{path}x\n---\n');
    writeFileSync(join(own, `${generic[0]!.file}`), 'replaced');
    const all = censusJourneys(cfg, cwd, 'o/app');
    assert.equal(all.length, generic.length + 1);
    assert.equal(all.find((j) => j.file === generic[0]!.file)?.content, 'replaced');
    assert.equal(all.find((j) => j.file === 'specific_test.md')?.content, `---\nurl: http://127.0.0.1:${cfg.port}/sub/x\n---\n`);
    assert.ok(all.filter((j) => j.kind === 'generic').every((g) => g.content.includes('/sub/')), 'generic journeys follow the app path');
    writeFileSync(join(own, 'app.json'), '{ "path": "javascript:alert(1)" }');
    assert.equal(appPath(own), '/', 'a path that is not a plain URL path is ignored');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('commitInto makes a local commit with the journeys and, later, the recordings (evidence left out)', async () => {
  const repo = makeFixtureRepo();
  const scratch = mkdtempSync(join(tmpdir(), 'bumpproof-census-c-'));
  try {
    writeFileSync(join(repo.dir, '.gitignore'), 'output-*\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '--quiet', '-m', 'ignore outputs');
    const base = repo.git('rev-parse', 'HEAD');
    const path = journeysPath(cfg, 'app');
    assert.equal(path, 'app/.bumpproof/journeys');
    const one = await commitInto({ run }, repo.dir, base, path, { files: [{ file: 'home_test.md', content: 'hi\n', kind: 'generic' }] }, 'journeys');
    assert.equal(repo.git('show', `${one}:app/.bumpproof/journeys/home_test.md`), 'hi');
    assert.equal(repo.git('rev-parse', `${one}^`), base);
    const rec = join(scratch, 'rec');
    mkdirSync(join(rec, 'output-home', '.internal'), { recursive: true });
    mkdirSync(join(rec, '.testmuai', 'evidence'), { recursive: true });
    writeFileSync(join(rec, 'home_test.md'), 'hi\n');
    writeFileSync(join(rec, 'output-home', '.internal', 'meta.json'), '{}');
    writeFileSync(join(rec, '.testmuai', 'evidence', 'x.evidence'), 'raw');
    const two = await commitInto({ run }, repo.dir, one, path, { fromDir: rec }, 'recordings');
    const files = repo.git('ls-tree', '-r', '--name-only', two, '--', path).split('\n');
    assert.deepEqual(files.sort(), ['app/.bumpproof/journeys/home_test.md', 'app/.bumpproof/journeys/output-home/.internal/meta.json']);
    assert.equal(repo.git('rev-parse', 'HEAD'), base, 'the checked-out branch is not moved');
    assert.equal(repo.git('worktree', 'list').split('\n').length, 1, 'no worktree left behind');
    assert.equal(readFileSync(join(repo.dir, 'app', 'package.json'), 'utf8').length > 0, true);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

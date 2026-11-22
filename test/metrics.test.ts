import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, loadConfig } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';
import { buildSite } from '../src/report/html.ts';
import { loopSeconds, measure, median, readCandidates, readLedger, type CensusFacts } from '../src/report/metrics.ts';
import { numbersSection } from '../src/report/numbers.ts';
import { parseRun, type RunReport } from '../src/report/run.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const base = JSON.parse(readFileSync(join(FIXTURE, 'run.json'), 'utf8')) as Record<string, unknown>;
const en = makeTranslator('en');
const ms = makeTranslator('ms');

/** A real (not synthetic) run record built from the fixture, with the parts a test cares about replaced. */
function run(id: string, o: { verdict: string; reason: string; pr?: number | null; credits?: number; fix?: 'fixed' | 'failed' | null;
  attempts?: number; loop?: [number, number] | null; synthetic?: boolean }): RunReport {
  const fix = o.fix === undefined || o.fix === null ? null
    : { ...(base.fix as Record<string, unknown>), status: o.fix, attempts: o.attempts ?? 1 };
  const timeline = o.loop ? [{ at_s: o.loop[0], key: 'fixer_start', vars: {}, tone: 'info' },
    { at_s: o.loop[1], key: 'fixer_done', vars: {}, tone: 'ok' }] : [];
  const pr = o.pr === undefined ? 1 : o.pr;
  return parseRun({ ...base, run_id: id, synthetic: o.synthetic ?? false, credits_consumed: o.credits ?? 1, fix, timeline,
    verdict: { verdict: o.verdict, reason: o.reason, evaluated: 3 },
    source: pr === null ? { repo: null, pr: null, pr_url: null, pr_title: null, ci: null }
      : { ...(base.source as Record<string, unknown>), pr } });
}

const row = (verdict: string, control: string | null, green = false): CensusFacts =>
  ({ verdict, control, ci_green_but_broken: green, run_id: null });

test('median of odd, even and empty lists', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('H1 counts real pull request runs by verdict and reason; local and synthetic runs are left out', () => {
  const m = measure({ census: null, censusRuns: [], candidates: null, ledger: null, runs: [
    run('a', { verdict: 'safe', reason: 'ok' }),
    run('b', { verdict: 'fixed', reason: 'regression', fix: 'fixed' }),
    run('c', { verdict: 'fixed', reason: 'head_build_failed', fix: 'fixed' }),
    run('d', { verdict: 'broken', reason: 'regression' }),
    run('e', { verdict: 'safe', reason: 'ok', pr: null }),
    run('f', { verdict: 'safe', reason: 'ok', synthetic: true }),
  ] });
  assert.deepEqual(m.h1, { prs: 4, safe: 1, fixed_regression: 1, fixed_build: 1, broken: 1, other: 0 });
  assert.equal(m.h2, null);
  assert.equal(m.h3, null);
  assert.equal(m.h4, null);
});

test('H5 loop time is fixer start to fixer done on fixed runs only; credits median over pull request runs', () => {
  assert.equal(loopSeconds(run('a', { verdict: 'fixed', reason: 'regression', fix: 'fixed', loop: [100, 400] })), 300);
  assert.equal(loopSeconds(run('b', { verdict: 'broken', reason: 'regression', fix: 'failed', loop: [100, 400] })), null);
  assert.equal(loopSeconds(run('c', { verdict: 'fixed', reason: 'regression', fix: 'fixed', loop: null })), null);
  const m = measure({ census: null, candidates: null, ledger: null,
    runs: [run('a', { verdict: 'fixed', reason: 'regression', fix: 'fixed', loop: [10, 110], credits: 70 }),
      run('b', { verdict: 'safe', reason: 'ok', credits: 6 }),
      run('c', { verdict: 'safe', reason: 'ok', credits: 4, pr: null })],
    censusRuns: [run('d', { verdict: 'fixed', reason: 'regression', fix: 'fixed', loop: [0, 300] })] });
  assert.equal(m.h5.loops, 2);
  assert.equal(m.h5.loop_median_s, 200);
  assert.equal(m.h5.prs, 2);
  assert.equal(m.h5.pr_credits_median, 38);
  assert.equal(m.h5.ratio, null, 'no ledger, no ratio');
});

test('H5 credit ratio: census authoring runs against census replays; runs outside the census do not count', () => {
  const m = measure({ runs: [], census: null, censusRuns: [], candidates: null, ledger: [
    { id: 'r1-author:base:home:1', credits: 30, census: true },
    { id: 'r1-author:base:nav:1', credits: 10, census: true },
    { id: 'r1:base:home:1', credits: 4, census: true },
    { id: 'r1:head:home:1', credits: 6, census: true },
    { id: 'shop:head:account:1', credits: 99, census: false },
  ] });
  assert.equal(m.h5.author_mean, 20);
  assert.equal(m.h5.replay_mean, 5);
  assert.equal(m.h5.ratio, 4);
});

test('H2–H4 come from the census rows; H6 counts only runs where the fixer ran', () => {
  const m = measure({
    runs: [run('a', { verdict: 'fixed', reason: 'regression', fix: 'fixed' }), run('b', { verdict: 'broken', reason: 'regression' })],
    censusRuns: [run('c', { verdict: 'broken', reason: 'head_build_failed', fix: 'failed', attempts: 2 })],
    candidates: { evaluated: 30, eligible: 6 }, ledger: null,
    census: [row('safe', 'same'), row('broken', 'same', true), row('safe', 'false_alarm'), row('unrunnable', 'not_run'),
      row('safe', 'inconclusive')],
  });
  assert.deepEqual(m.h2, { evaluated: 30, eligible: 6, run: 5, runnable: 4 });
  assert.deepEqual(m.h3, { count: 1, runnable: 4 });
  assert.deepEqual(m.h4, { same: 2, false_alarm: 1, inconclusive: 1, checked: 4 });
  assert.deepEqual(m.h6.demo, { fixed: 1, attempted: 1, attempts: 1 });
  assert.deepEqual(m.h6.census, { fixed: 0, attempted: 1, attempts: 2 });
  assert.deepEqual(m.h6.total, { fixed: 1, attempted: 2, attempts: 3 });
});

test('candidates are counted from the list, not from its summary; the ledger skips malformed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-metrics-'));
  try {
    const cand = join(dir, 'candidates.json');
    writeFileSync(cand, JSON.stringify({ counts: { evaluated: 999, eligible: 999 },
      candidates: [{ status: 'eligible' }, { status: 'excluded' }, { status: 'excluded' }, { status: 'other' }] }));
    assert.deepEqual(readCandidates(cand), { evaluated: 3, eligible: 1 });
    assert.equal(readCandidates(join(dir, 'missing.json')), null);
    assert.equal(readCandidates(undefined), null);
    const led = join(dir, 'ledger.json');
    writeFileSync(led, JSON.stringify({ runs: [{ id: 'x', credits: 2, census: true }, { id: 'y', credits: '3' }, { credits: 1 }] }));
    assert.deepEqual(readLedger(led), [{ id: 'x', credits: 2, census: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the measured block shows each number with its source and a dash when nothing is measured', () => {
  const empty = measure({ runs: [], census: null, censusRuns: [], candidates: null, ledger: null });
  const html = numbersSection(en, empty, 'en');
  assert.equal((html.match(/class="metric"/g) ?? []).length, 6);
  assert.equal((html.match(/metric-none/g) ?? []).length, 6);
  assert.equal((html.match(/Not measured yet\./g) ?? []).length, 6);
  const m = measure({ runs: [run('a', { verdict: 'safe', reason: 'ok' })], censusRuns: [], candidates: { evaluated: 12, eligible: 9 },
    ledger: null, census: [row('safe', 'same'), row('unrunnable', 'not_run')] });
  const out = numbersSection(en, m, 'en');
  assert.match(out, /<p class="metric-n">1 of 2<\/p>/, 'H2: runnable of run');
  assert.match(out, /12 pull requests checked against the rules, 9 eligible, 2 run/);
  assert.match(out, /<p class="metric-n">0 of 1<\/p>/, 'H4: false alarms of checked');
  assert.match(numbersSection(ms, m, 'ms'), /id="measured-ms"/);
  assert.match(numbersSection(ms, m, 'ms'), /1 daripada 2/);
});

test('the overview and census pages carry the numbers, the attribution and the CI-green flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-metrics-site-'));
  try {
    const census = join(dir, 'results.json');
    writeFileSync(census, JSON.stringify({ schema_version: 1, repos: [
      { repo: 'a/one', url: 'https://github.com/a/one', verdict: 'broken', bump: 'x 1 → 2', license: 'MIT', ci: 'green',
        control: 'same', ci_green_but_broken: true, pr_url: 'https://github.com/a/one/pull/3' },
      { repo: 'b/two', verdict: 'unrunnable', control: 'not_run' },
    ] }));
    buildSite(loadConfig(tmpdir()), { outDir: dir, runsDir: join(dir, 'runs'), censusPath: census, version: '9.9.9',
      translators: new Map([['en', en], ['ms', ms]]), secrets: [] });
    const home = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(home, /id="measured"/);
    assert.match(home, /id="measured-ms"/);
    assert.match(home, /Census pull requests where CI was green or absent but Kane CLI found a break: 1 of 1\./);
    const page = readFileSync(join(dir, 'census.html'), 'utf8');
    assert.match(page, /<a href="https:\/\/github.com\/a\/one">a\/one<\/a>/);
    assert.match(page, /<a href="https:\/\/github.com\/a\/one\/pull\/3">x 1 → 2<\/a>/);
    assert.match(page, /CI was green/);
    assert.match(page, /used under the license shown/);
    assert.match(page, /digunakan di bawah lesen/);
    assert.match(page, />Same</);
    assert.match(page, />Not run</);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

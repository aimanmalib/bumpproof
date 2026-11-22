import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { renderFix, verdictExit, writeRunJson } from '../src/check-cli.ts';
import { fixNeeded, journeyObjective, replayOrder, runFixStage } from '../src/check-fix.ts';
import { runJourneyCheck } from '../src/check-journeys.ts';
import { makeTranslator } from '../src/i18n.ts';
import { parseRun } from '../src/report/run.ts';
import type { ProcResult, Runner } from '../src/proc.ts';
import { makePaint } from '../src/ui.ts';
import { fakeDocker, phases, type Step } from './support/fake-docker.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX), 'utf8');
const ok = (stdout: string, code = 0): ProcResult => ({ ok: code === 0, code, stdout, stderr: '' });
const tmp = () => mkdtempSync(join(tmpdir(), 'bumpproof-cf-'));
const PASS = fixture('synthetic-testmd-pass.ndjson');
const FAIL = fixture('synthetic-testmd-regression.ndjson');

/** A repository with two journeys and a lib 1.0.0 → 2.0.0 bump; `headBuild` replaces build.js on the head. */
function bumpRepo(headBuild?: string) {
  const repo = makeFixtureRepo();
  const jd = join(repo.dir, 'app', '.bumpproof', 'journeys');
  mkdirSync(jd, { recursive: true });
  writeFileSync(join(jd, 'cart_test.md'), '---\nurl: http://127.0.0.1:4173/cart\n---\n\n# Cart\n\n## Add\nAdd a tea.\n');
  writeFileSync(join(jd, 'shop_test.md'), '---\nurl: http://127.0.0.1:4173/\n---\n\n# Shop\n\n## Open\nOpen the page.\n');
  writeFileSync(join(repo.dir, 'app', 'build.js'), "console.log('built');\n");
  const pkg = JSON.parse(readFileSync(join(repo.dir, 'app', 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(repo.dir, 'app', 'package.json'), JSON.stringify({ ...pkg, dependencies: { lib: '1.0.0' } }));
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'journeys');
  repo.git('tag', 'b');
  writeFileSync(join(repo.dir, 'app', 'package.json'), JSON.stringify({ ...pkg, dependencies: { lib: '2.0.0' } }));
  if (headBuild) writeFileSync(join(repo.dir, 'app', 'build.js'), headBuild);
  repo.git('commit', '--quiet', '-am', 'bump lib');
  repo.git('tag', 'h');
  return repo;
}

interface World {
  /** Kane answer for a journey file in a folder (folders: base, head, fix-<n>-journeys). */
  kane: (folder: string, file: string) => [string, number];
  /** What the fake agent does to its working copy on each attempt. */
  edits: ((cwd: string) => void)[];
  containers: Step[][];
}

function world(w: World) {
  const kaneCalls: string[] = [];
  const prompts: string[] = [];
  let credits = 1000;
  const fd = fakeDocker(w.containers);
  const run: Runner = async (cmd, args, o) => {
    if (cmd === 'kane-cli') {
      if (args[0] === 'balance') return ok(`Available credits: ${credits}\n`);
      const folder = basename(o?.cwd ?? '');
      kaneCalls.push(`${folder}:${args[2]}`);
      credits -= 5;
      const [text, code] = w.kane(folder, args[2]!);
      return ok(text, code);
    }
    if (cmd === 'claude') {
      prompts.push(args[args.length - 1]!);
      w.edits[prompts.length - 1]?.(o!.cwd!);
      return ok(JSON.stringify({ is_error: false, result: 'done', total_cost_usd: 0.25, num_turns: 4 }));
    }
    if (cmd === 'gh') return { ok: false, code: 1, stdout: '', stderr: 'offline', error: undefined } as ProcResult;
    return fd.run(cmd, args, o);
  };
  const deps = { ...fd.deps(), run, env: {}, ledgerRoot: tmp(), version: '0.0.0-test', fetch: async () => undefined };
  return { deps, kaneCalls, prompts, fd };
}

const up: Step[] = [{ running: true, out: phases('install', 'build', 'serve') }];
const buildFails: Step[] = [{ running: false, exit: 1, out: phases('install', 'build'), err: 'Error: Missing "./esm/format" specifier in "lib" package' }];

const fixApp = (cwd: string) => {
  writeFileSync(join(cwd, 'server.js'), `${readFileSync(join(cwd, 'server.js'), 'utf8')}// adapted to lib 2\n`);
  writeFileSync(join(cwd, 'BUMPPROOF_FIX.md'), 'server.js: adapted. Release notes: "the default export is gone"\n');
};

async function checkThenFix(repoDir: string, w: ReturnType<typeof world>) {
  const opts = { repo: repoDir, base: 'b', head: 'h', dir: 'app', runId: 'cf1' };
  const res = await runJourneyCheck(w.deps, opts);
  assert.equal(fixNeeded(res.report), true);
  const stage = await runFixStage(w.deps, res, repoDir, 'app', 'fix.patch');
  return { res, stage, report: parseRun(JSON.parse(JSON.stringify(res.report))) };
}

test('fix stage: a regression is patched, rebuilt, failed journey replayed first, then the rest → fixed', async () => {
  const repo = bumpRepo();
  const w = world({
    kane: (folder, file) => (folder === 'head' && file === 'cart_test.md' ? [FAIL, 1] : [PASS, 0]),
    edits: [fixApp],
    containers: [up, up, up],
  });
  const { res, stage, report } = await checkThenFix(repo.dir, w);
  assert.equal(report.verdict.verdict, 'fixed');
  assert.equal(report.verdict.reason, 'regression');
  assert.equal(verdictExit(report), 0);
  assert.deepEqual(w.kaneCalls.filter((c) => c.startsWith('fix-')), ['fix-1-journeys:cart_test.md', 'fix-1-journeys:shop_test.md']);
  assert.deepEqual(report.builds.map((b) => `${b.side}:${b.built}`), ['base:true', 'head:true', 'fix:true']);
  assert.equal(report.journeys.find((j) => j.name === 'cart')?.after_fix?.status, 'passed');
  assert.equal(report.journeys.find((j) => j.name === 'cart')?.outcome, 'regression', 'the head result stays on record');
  assert.equal(report.credits_consumed, 30, 'base 2 + head 2 + after the fix 2, 5 credits each');
  assert.equal(report.fix?.status, 'fixed');
  assert.deepEqual(report.fix?.files, ['BUMPPROOF_FIX.md', 'server.js']);
  assert.equal(report.fix?.patch_file, 'fix.patch');
  assert.equal(report.fix?.cost_usd, 0.25);
  assert.match(report.fix?.explanation ?? '', /default export is gone/);
  assert.match(stage.patch, /\+\/\/ adapted to lib 2/);
  // The fixer is told which journey failed and what it is for, from the base's journey file.
  assert.match(w.prompts[0]!, /\*\*cart\*\*/);
  assert.match(w.prompts[0]!, /# Cart\n\n## Add\nAdd a tea\./);
  assert.match(w.prompts[0]!, /`lib`: 1\.0\.0 -> 2\.0\.0/);
  const keys = report.timeline.map((e) => e.key);
  assert.deepEqual(keys.slice(keys.indexOf('fixer_start')), ['fixer_start', 'built', 'journey', 'journey', 'fixer_done', 'verdict']);
  assert.equal(keys.filter((k) => k === 'verdict').length, 1, 'the verdict line is replaced, not repeated');
  assert.equal(res.check.sides.length, 2);
  // The fixed run and its patch are written together, after the scan.
  const out = join(tmp(), 'run');
  assert.deepEqual(writeRunJson(out, report, w.deps.cfg, {}, stage.patch, [], stage.prompt), []);
  assert.deepEqual(readdirSync(out).sort(), ['fix.patch', 'fixer-prompt.md', 'run.json']);
  // fixer-prompt.md is the prompt as sent, numbered, saved (not rebuilt).
  assert.equal(report.fix?.prompt_file, 'fixer-prompt.md');
  const saved = readFileSync(join(out, 'fixer-prompt.md'), 'utf8');
  assert.match(saved, /saved during the run/);
  assert.match(saved, /## Attempt 1\n/);
  assert.ok(!/## Attempt 2/.test(saved));
  assert.match(saved, /│ The user journey \*\*cart\*\* passed on the old version/);
  const t = makeTranslator('en');
  assert.match(renderFix(report, t, makePaint(false)), /Fixed after 1 attempt\(s\): 1 line\(s\) changed in BUMPPROOF_FIX\.md, server\.js/);
  assert.equal(w.fd.calls.filter((c) => c[0] === 'run').length, 3, 'base, head, fixed head');
});

test('fix stage: a head that does not build is patched and every journey is replayed → fixed', async () => {
  const repo = bumpRepo("console.log('needs lib 1 paths');\n");
  const w = world({ kane: () => [PASS, 0], edits: [fixApp], containers: [up, buildFails, up] });
  const { report } = await checkThenFix(repo.dir, w);
  assert.equal(report.verdict.verdict, 'fixed');
  assert.equal(report.verdict.reason, 'head_build_failed');
  assert.match(w.prompts[0]!, /Missing "\.\/esm\/format" specifier/);
  assert.deepEqual(w.kaneCalls.filter((c) => c.startsWith('fix-')), ['fix-1-journeys:cart_test.md', 'fix-1-journeys:shop_test.md']);
  assert.deepEqual(report.builds.map((b) => `${b.side}:${b.built}`), ['base:true', 'head:false', 'fix:true']);
});

test('fix stage: a patch that still fails stops replaying, is undone, and after max attempts the verdict stays broken', async () => {
  const repo = bumpRepo();
  const w = world({
    kane: (folder, file) => (folder !== 'base' && file === 'cart_test.md' ? [FAIL, 1] : [PASS, 0]),
    edits: [fixApp, fixApp],
    containers: [up, up, up, up],
  });
  const { report, stage } = await checkThenFix(repo.dir, w);
  assert.equal(report.verdict.verdict, 'broken');
  assert.equal(report.fix?.status, 'failed');
  assert.equal(report.fix?.attempts, 2);
  assert.equal(report.fix?.patch_file, null);
  assert.equal(stage.patch, '');
  assert.deepEqual(w.kaneCalls.filter((c) => c.startsWith('fix-')), ['fix-1-journeys:cart_test.md', 'fix-2-journeys:cart_test.md'],
    'the passing journey is not replayed while the failed one still fails');
  assert.match(w.prompts[1]!, /journey cart still does not pass at step "Open the Orders tab"/);
  assert.equal(report.journeys.find((j) => j.name === 'cart')?.after_fix?.status, 'failed');
  assert.equal(report.timeline.filter((e) => e.key === 'fixer_rejected').length, 2);
});

test('fixNeeded, journeyObjective and replayOrder', () => {
  const r = (verdict: string, reason: string) => ({ verdict: { verdict, reason, evaluated: 1 } }) as never;
  assert.equal(fixNeeded(r('broken', 'regression')), true);
  assert.equal(fixNeeded(r('broken', 'head_build_failed')), true);
  assert.equal(fixNeeded(r('safe', 'ok')), false);
  assert.equal(fixNeeded(r('unrunnable', 'base_build_failed')), false);
  assert.equal(journeyObjective('---\nurl: x\n---\n\n# A\n\n## B\nDo.\n'), '# A\n\n## B\nDo.');
  const att = (code: number) => [{ kane: { exit_code: code } }];
  const res = {
    journeys: [{ name: 'a', file: 'a_test.md' }, { name: 'b', file: 'b_test.md' }, { name: 'c', file: 'c_test.md' }],
    base: new Map([['a', att(0)], ['b', att(0)], ['c', att(1)]]),
    report: { journeys: [{ name: 'a', outcome: 'same' }, { name: 'b', outcome: 'regression' }, { name: 'c', outcome: 'baseline_red' }] },
    check: { sides: [{ side: 'base', built: true }, { side: 'head', built: true }] },
  } as never;
  assert.deepEqual(replayOrder(res).map((j) => j.name), ['b', 'a'], 'failed first; red on the base never');
});

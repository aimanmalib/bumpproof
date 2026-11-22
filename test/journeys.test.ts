import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { runJourneyCheck } from '../src/check-journeys.ts';
import { verdictExit, writeRunJson } from '../src/check-cli.ts';
import { loadConfig } from '../src/config.ts';
import { BudgetError, copyJourneys, evidencePath, findJourneys, runJourney, runSide, type KaneDeps } from '../src/journeys.ts';
import { parseRun } from '../src/report/run.ts';
import type { ProcResult, Runner } from '../src/proc.ts';
import { fakeDocker, phases } from './support/fake-docker.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX), 'utf8');
const ok = (stdout: string, code = 0): ProcResult => ({ ok: code === 0, code, stdout, stderr: '' });
const tmp = () => mkdtempSync(join(tmpdir(), 'bumpproof-jt-'));

/** A Kane CLI stand-in: `balance` drops by `charge` after every testmd run; testmd answers from `answer(cwd, file)`. */
function fakeKane(answer: (cwd: string, file: string) => [string, number], charge = 10) {
  let credits = 1000;
  const calls: string[] = [];
  const run: Runner = async (cmd, args, o) => {
    if (args[0] === 'balance') return ok(`Available credits: ${credits}\n`);
    if (args[0] === 'testmd') {
      const file = args[2]!;
      calls.push(`${basename(o?.cwd ?? '')}:${file}`);
      credits -= charge;
      const [text, code] = answer(o?.cwd ?? '', file);
      return ok(text, code);
    }
    return { ok: false, code: null, stdout: '', stderr: '', error: `unexpected ${cmd}` };
  };
  return { run, calls };
}

function deps(run: Runner, root = tmp()): KaneDeps {
  const cfg = loadConfig('/nonexistent');
  return { run, cfg, env: {}, now: () => 0, ledgerRoot: root };
}

test('journeys: found by suffix, sorted, named by stem; copies leave local evidence behind', () => {
  const d = tmp();
  for (const f of ['checkout_test.md', 'account_test.md', 'notes.md', '_test.md']) writeFileSync(join(d, f), '## x\n');
  mkdirSync(join(d, 'output-account', '.internal'), { recursive: true });
  writeFileSync(join(d, 'output-account', '.internal', 'meta.json'), '{}');
  mkdirSync(join(d, '.testmuai', 'evidence'), { recursive: true });
  writeFileSync(join(d, '.testmuai', 'evidence', 'x.evidence'), 'zip');
  assert.deepEqual(findJourneys(d, '_test.md'), [{ name: 'account', file: 'account_test.md' }, { name: 'checkout', file: 'checkout_test.md' }]);
  assert.deepEqual(findJourneys(join(d, 'missing'), '_test.md'), []);
  const c = join(tmp(), 'copy');
  copyJourneys(d, c);
  assert.ok(existsSync(join(c, 'output-account', '.internal', 'meta.json')), 'recordings travel with the copy');
  assert.ok(!existsSync(join(c, '.testmuai')));
});

test('evidencePath: the pack the stream names, local copy first', () => {
  const d = tmp();
  mkdirSync(join(d, '.testmuai', 'evidence'), { recursive: true });
  writeFileSync(join(d, '.testmuai', 'evidence', 'ab-12.evidence'), 'zip');
  const s = '{"type":"test_md_evidence_ingest","status":"ok","evidence_id":"ab-12"}\n{"type":"coverage","pack":"/nowhere/x.evidence"}\n';
  assert.equal(evidencePath(s, d), join(d, '.testmuai', 'evidence', 'ab-12.evidence'));
  assert.equal(evidencePath('{"type":"test_md_evidence_ingest","evidence_id":"../../etc"}', d), null);
  assert.equal(evidencePath('', d), null);
});

test('runJourney: credits = balance drop, written to the ledger; the recorded Kane CLI 0.10.7 stream parses', async () => {
  const k = fakeKane(() => [fixture('recorded-20261122-browse-pass.ndjson'), 0], 56.844);
  const d = deps(k.run);
  const a = await runJourney(d, tmp(), { name: 'browse', file: 'browse_test.md' }, 'r1:base:browse:1');
  assert.equal(a.kane.status, 'passed');
  assert.equal(a.kane.cli_version, '0.10.7');
  assert.deepEqual(a.kane.steps.map((s) => s.heading), ['Open the Tea shelf', 'Open a product', 'Go back to the shelf']);
  assert.equal(Math.round(a.kane.credits_consumed * 100) / 100, 49.71, 'sum of per-step run_end credits');
  assert.equal(a.credits, 56.844, 'the account balance is what was charged');
  const ledger = JSON.parse(readFileSync(join(d.ledgerRoot, d.cfg.kane.ledger_path), 'utf8')) as { total: number };
  assert.equal(ledger.total, 56.844);
});

test('runJourney: no balance → NDJSON credits; spent budget → refused before Kane starts', async () => {
  const k = fakeKane(() => [fixture('synthetic-testmd-pass.ndjson'), 0]);
  const noBalance: Runner = async (c, a, o) => (a[0] === 'balance' ? ok('', 1) : k.run(c, a, o));
  const d = deps(noBalance);
  const a = await runJourney(d, tmp(), { name: 'x', file: 'x_test.md' }, 'r:base:x:1');
  assert.equal(a.credits, a.kane.credits_consumed);
  d.cfg.kane.credit_hard_stop = a.credits;
  await assert.rejects(runJourney(d, tmp(), { name: 'x', file: 'x_test.md' }, 'r:base:x:2'), BudgetError);
  assert.equal(k.calls.length, 1, 'the refused run never reached Kane CLI');
});

test('runSide: the head runs only journeys green on the base, and retries once while inconclusive', async () => {
  const answers: Record<string, [string, number][]> = {
    'base:a_test.md': [[fixture('synthetic-testmd-pass.ndjson'), 0]],
    'base:b_test.md': [[fixture('synthetic-testmd-regression.ndjson'), 1]],
    'head:a_test.md': [[fixture('synthetic-testmd-not-started.ndjson'), 2], [fixture('synthetic-testmd-pass.ndjson'), 0]],
  };
  const k = fakeKane((cwd, file) => answers[`${basename(cwd)}:${file}`]!.shift()!);
  const d = deps(k.run);
  const js = [{ name: 'a', file: 'a_test.md' }, { name: 'b', file: 'b_test.md' }];
  const root = tmp();
  const base = await runSide(d, join(root, 'base'), js, 'base', 'r');
  const head = await runSide(d, join(root, 'head'), js, 'head', 'r', base);
  assert.deepEqual(k.calls, ['base:a_test.md', 'base:b_test.md', 'head:a_test.md', 'head:a_test.md']);
  assert.equal(head.get('a')?.length, 2);
  assert.equal(head.has('b'), false, 'red on the base = not run on the head');
});

test('runJourneyCheck: real git + fake Docker + fake Kane → a run record that parses, with bumps and a regression verdict', async () => {
  const repo = makeFixtureRepo();
  const jd = join(repo.dir, 'app', '.bumpproof', 'journeys');
  mkdirSync(jd, { recursive: true });
  writeFileSync(join(jd, 'shop_test.md'), '---\nurl: http://127.0.0.1:4173/\n---\n\n## Open\nOpen the page.\n');
  const pkg = JSON.parse(readFileSync(join(repo.dir, 'app', 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(repo.dir, 'app', 'package.json'), JSON.stringify({ ...pkg, dependencies: { lib: '1.0.0' } }));
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'journeys');
  repo.git('tag', 'base2');
  writeFileSync(join(repo.dir, 'app', 'package.json'), JSON.stringify({ ...pkg, dependencies: { lib: '2.0.0' } }));
  repo.git('commit', '--quiet', '-am', 'bump lib');
  repo.git('tag', 'head2');
  const up = [{ running: true, out: phases('install', 'build', 'serve') }];
  const fd = fakeDocker([up, up]);
  const k = fakeKane((cwd) => (basename(cwd) === 'base'
    ? [fixture('synthetic-testmd-pass.ndjson'), 0] : [fixture('synthetic-testmd-regression.ndjson'), 1]));
  const run: Runner = (c, a, o) => (c === 'kane-cli' ? k.run(c, a, o) : fd.run(c, a, o));
  const ledgerRoot = tmp();
  // A copy left in the shared tmp folder by an interrupted earlier run must not count against this one.
  const copies = () => readdirSync(tmpdir()).filter((n) => n.startsWith('bumpproof-journeys-jc1'));
  const before = new Set(copies());
  const res = await runJourneyCheck({ ...fd.deps(), run, env: {}, ledgerRoot, version: '0.0.0-test' },
    { repo: repo.dir, base: 'base2', head: 'head2', dir: 'app', runId: 'jc1' });
  const r = parseRun(JSON.parse(JSON.stringify(res.report)));
  assert.equal(r.verdict.verdict, 'broken');
  assert.equal(r.verdict.reason, 'regression');
  assert.deepEqual(r.bumps, [{ name: 'lib', from: '1.0.0', to: '2.0.0', type: 'major' }]);
  assert.equal(r.journeys[0]?.outcome, 'regression');
  assert.equal(r.journeys[0]?.head?.failed_step, 'Open the Orders tab');
  assert.equal(r.credits_consumed, 20);
  assert.equal(res.check.journeys_run, true);
  assert.deepEqual(r.timeline.map((e) => e.key), ['started_local', 'bump', 'built', 'journey', 'built', 'journey', 'verdict']);
  assert.equal(verdictExit(r), 1);
  assert.deepEqual(copies().filter((n) => !before.has(n)), [], 'journey copies removed');
});

test('writeRunJson refuses a record that still holds a private value', () => {
  const cfg = loadConfig('/nonexistent');
  const r = parseRun(JSON.parse(fixture('synthetic-run/run.json')));
  const d = join(tmp(), 'out');
  assert.deepEqual(writeRunJson(d, r, cfg, {}), []);
  assert.ok(existsSync(join(d, 'run.json')));
  const leaky = { ...r, run_id: 'leak', journeys: r.journeys.map((j) => ({ ...j, base: { ...j.base, remark: 'ran by owner@private.test' } })) };
  const d2 = join(tmp(), 'out');
  assert.equal(writeRunJson(d2, leaky, cfg, {}).length > 0, true);
  assert.equal(existsSync(join(d2, 'run.json')), false);
});

test('recorded regression (react-query 5 head, Kane CLI 0.10.7): failed after a heal, confirmed bug becomes the remark', async () => {
  const { parseNdjson } = await import('../src/kane.ts');
  const { journeyRun } = await import('../src/run-record.ts');
  const k = parseNdjson(fixture('recorded-20261122-checkout-regression.ndjson'), 1);
  assert.equal(k.status, 'failed');
  assert.equal(k.complete, true);
  assert.equal(k.healed, true, 'test_md_adaptive_heal and test_md_summary.adaptive_heal both say so');
  assert.equal(k.result_code, 740);
  assert.equal(k.failed_step?.heading, 'Add a product to the cart');
  assert.equal(k.bugs.filter((b) => b.confirmed).length, 2);
  const cfg = loadConfig('/nonexistent');
  const r = journeyRun([{ kane: k, evidence: null, credits: 17.882, seconds: 197 }], cfg.publish, []);
  assert.equal(r?.remark, k.bugs[1]?.one_liner);
  assert.notEqual(r?.remark, k.reason);
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import {
  addRun, checkBudget, emptyLedger, parseNdjson, readLedger, statusFromExit, testmdArgs, toFacts, writeLedger,
} from '../src/kane.ts';
import { compareJourney } from '../src/compare.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('exit code decides the status', () => {
  assert.deepEqual([0, 1, 2, 3, 137, null].map(statusFromExit), ['passed', 'failed', 'not_started', 'cancelled', 'error', 'error']);
});

test('testmd pass: steps, version, completion; unknown events ignored', () => {
  const r = parseNdjson(fixture('synthetic-testmd-pass.ndjson'), 0);
  assert.equal(r.status, 'passed');
  assert.equal(r.cli_version, '0.10.7');
  assert.equal(r.surface, 'testmd');
  assert.equal(r.complete, true);
  assert.equal(r.overall_status, 'passed');
  assert.equal(r.duration_s, 11);
  assert.equal(r.credits_consumed, 0);
  assert.equal(r.healed, false);
  assert.deepEqual(r.steps.map((s) => s.heading), ['Open the shop', 'Add the first product to the cart']);
  assert.equal(r.failed_step, null);
  assert.equal(r.bad_lines, 0);
});

test('testmd heal: the adaptive heal event marks the run healed and credits are summed', () => {
  const r = parseNdjson(fixture('synthetic-testmd-healed.ndjson'), 0);
  assert.equal(r.healed, true);
  assert.equal(r.credits_consumed, 3.5);
  assert.equal(compareJourney('j', toFacts(parseNdjson(fixture('synthetic-testmd-pass.ndjson'), 0)), [toFacts(r)],
    { console_errors_fail: false, network_errors_fail: false }).outcome, 'shifted_ok');
});

test('testmd regression: failed step, reason, product bug code and verdict', () => {
  const r = parseNdjson(fixture('synthetic-testmd-regression.ndjson'), 1);
  assert.equal(r.status, 'failed');
  assert.equal(r.credits_consumed, 7.75);
  assert.equal(r.result_code, 740);
  assert.equal(r.reason, 'The Orders tab leads to a page that does not exist.');
  assert.deepEqual(r.failed_step, { index: 1, heading: 'Open the Orders tab', status: 'failed', duration_s: 12 });
  assert.equal(r.bugs.length, 1);
  assert.equal(r.bugs[0]!.confirmed, true);
});

test('not started and truncated streams: incomplete, bad lines counted, exit code still wins', () => {
  const ns = parseNdjson(fixture('synthetic-testmd-not-started.ndjson'), 2);
  assert.deepEqual([ns.status, ns.complete, ns.credits_consumed], ['not_started', false, 0]);
  const tr = parseNdjson(fixture('synthetic-run-truncated.ndjson'), 3);
  assert.deepEqual([tr.status, tr.complete, tr.bad_lines, tr.events], ['cancelled', false, 2, 2]);
  const passedButCut = parseNdjson(fixture('synthetic-run-truncated.ndjson'), 0);
  assert.equal(passedButCut.status, 'passed');
});

test('agent run: the single run_end completes the stream', () => {
  const text = [
    { type: 'stream_start', cli_version: '0.10.7', surface: 'run' },
    { type: 'run_end', status: 'failed', duration: 20, credits_consumed: 11.9, result_code: 740, summary: 'Checkout total is wrong' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const r = parseNdjson(text, 1);
  assert.deepEqual([r.complete, r.overall_status, r.duration_s, r.credits_consumed, r.result_code, r.reason],
    [true, 'failed', 20, 11.9, 740, 'Checkout total is wrong']);
});

test('testmd args come from config flags', () => {
  const cfg = loadConfig(tmpdir());
  const args = testmdArgs('journeys/checkout_test.md', cfg.kane.testmd_args);
  assert.deepEqual(args.slice(0, 3), ['testmd', 'run', 'journeys/checkout_test.md']);
  assert.ok(args.includes('--agent') && args.includes('--headless'));
});

test('credit ledger: totals recomputed, census counted apart, budget stops runs', () => {
  const budget = { credit_hard_stop: 100, census_budget: 40 };
  let l = emptyLedger();
  l = addRun(l, { at: 't1', id: 'demo-1', credits: 30, census: false });
  l = addRun(l, { at: 't2', id: 'census-1', credits: 39.5, census: true });
  assert.deepEqual([l.total, l.census], [69.5, 39.5]);
  assert.deepEqual(checkBudget(l, budget, true), { ok: true });
  l = addRun(l, { at: 't3', id: 'census-2', credits: 0.5, census: true });
  assert.deepEqual(checkBudget(l, budget, true), { ok: false, reason: 'census_budget', used: 40, limit: 40 });
  assert.deepEqual(checkBudget(l, budget, false), { ok: true });
  l = addRun(l, { at: 't4', id: 'demo-2', credits: 30, census: false });
  assert.equal(checkBudget(l, budget, false).ok, false);
  assert.throws(() => addRun(l, { at: 't5', id: 'bad', credits: -1, census: false }));
});

test('ledger file: a hand-edited total is ignored on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-ledger-'));
  try {
    const path = join(dir, 'sub', 'kredit.json');
    assert.deepEqual(readLedger(path), emptyLedger());
    writeLedger(path, addRun(emptyLedger(), { at: 't', id: 'x', credits: 12, census: true }));
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...raw, total: 0, census: 0 }));
    assert.deepEqual([readLedger(path).total, readLedger(path).census], [12, 12]);
    writeFileSync(path, JSON.stringify({ schema_version: 9, runs: [] }));
    assert.throws(() => readLedger(path), /unknown ledger format/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

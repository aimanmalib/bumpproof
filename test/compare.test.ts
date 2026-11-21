import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareJourney, needsRetry, prVerdict, type JourneyResult, type RunFacts } from '../src/compare.ts';

const OPTS = { console_errors_fail: false, network_errors_fail: false };
const run = (exit_code: number | null, extra: Partial<RunFacts> = {}): RunFacts =>
  ({ exit_code, healed: false, console_errors: [], network_errors: [], ...extra });
const j = (outcome: JourneyResult['outcome']): JourneyResult =>
  ({ journey: outcome, outcome, attempts: 1, new_console_errors: [], new_network_errors: [], failed_on: null });

test('journey: pass without heal is same, pass with heal is shifted_ok', () => {
  assert.equal(compareJourney('a', run(0), [run(0)], OPTS).outcome, 'same');
  assert.equal(compareJourney('a', run(0), [run(0, { healed: true })], OPTS).outcome, 'shifted_ok');
});

test('journey: head exit 1 is a regression', () => {
  const r = compareJourney('a', run(0), [run(1)], OPTS);
  assert.equal(r.outcome, 'regression');
  assert.equal(r.failed_on, 'exit_code');
});

test('journey: base not passing leaves the journey out, whatever the head did', () => {
  for (const base of [1, 2, 3, null]) assert.equal(compareJourney('a', run(base), [run(0)], OPTS).outcome, 'baseline_red');
});

test('journey: exit 2/3 is inconclusive, retried once, then unrunnable', () => {
  assert.equal(compareJourney('a', run(0), [run(2)], OPTS).outcome, 'inconclusive');
  assert.equal(needsRetry([run(2)], 1), true);
  assert.equal(needsRetry([run(2), run(3)], 1), false);
  assert.equal(needsRetry([run(0)], 1), false);
  assert.equal(compareJourney('a', run(0), [run(3), run(2)], OPTS).outcome, 'unrunnable');
  const second = compareJourney('a', run(0), [run(3), run(1)], OPTS);
  assert.equal(second.outcome, 'regression');
  assert.equal(second.attempts, 2);
  assert.equal(compareJourney('a', run(0), [run(null), run(0)], OPTS).outcome, 'same');
});

test('journey: new console and network errors are warnings unless config makes them failures', () => {
  const base = run(0, { console_errors: ['old'], network_errors: ['404 GET /favicon.ico'] });
  const head = run(0, { console_errors: ['old', 'TypeError: x is undefined'], network_errors: ['404 GET /favicon.ico', '500 GET /api'] });
  const warn = compareJourney('a', base, [head], OPTS);
  assert.equal(warn.outcome, 'same');
  assert.deepEqual(warn.new_console_errors, ['TypeError: x is undefined']);
  assert.deepEqual(warn.new_network_errors, ['500 GET /api']);
  assert.equal(compareJourney('a', base, [head], { ...OPTS, console_errors_fail: true }).failed_on, 'console');
  assert.equal(compareJourney('a', base, [head], { ...OPTS, network_errors_fail: true }).outcome, 'regression');
});

test('verdict: safe needs no regression, a built head and one evaluated journey', () => {
  const v = prVerdict({ base_built: true, head_built: true, journeys: [j('same'), j('shifted_ok'), j('baseline_red')] });
  assert.deepEqual([v.verdict, v.reason, v.evaluated], ['safe', 'ok', 2]);
});

test('verdict: regression or build failure is broken without a fix, fixed when every journey passes again', () => {
  const journeys = [j('same'), j('regression')];
  assert.equal(prVerdict({ base_built: true, head_built: true, journeys }).verdict, 'broken');
  assert.equal(prVerdict({ base_built: true, head_built: true, journeys, fix: { attempts: 2, all_pass: false } }).verdict, 'broken');
  assert.equal(prVerdict({ base_built: true, head_built: true, journeys, fix: { attempts: 1, all_pass: true } }).verdict, 'fixed');
  const build = prVerdict({ base_built: true, head_built: false, journeys: [j('same')], fix: { attempts: 1, all_pass: true } });
  assert.deepEqual([build.verdict, build.reason], ['fixed', 'head_build_failed']);
  assert.equal(prVerdict({ base_built: true, head_built: false, journeys: [j('same')] }).reason, 'head_build_failed');
});

test('verdict: unrunnable when the base fails, no journey passes on base, or nothing was evaluated', () => {
  assert.equal(prVerdict({ base_built: false, head_built: true, journeys: [j('same')] }).reason, 'base_build_failed');
  assert.equal(prVerdict({ base_built: true, head_built: true, journeys: [j('baseline_red')] }).reason, 'no_baseline_journey');
  assert.equal(prVerdict({ base_built: true, head_built: true, journeys: [] }).reason, 'no_baseline_journey');
  const v = prVerdict({ base_built: true, head_built: true, journeys: [j('unrunnable'), j('baseline_red')] });
  assert.deepEqual([v.verdict, v.reason], ['unrunnable', 'all_inconclusive']);
});

test('verdict: a fix cannot turn an unrunnable base into fixed', () => {
  const v = prVerdict({ base_built: false, head_built: false, journeys: [j('regression')], fix: { attempts: 1, all_pass: true } });
  assert.equal(v.verdict, 'unrunnable');
});

test('every outcome, verdict and reason has text in every language', async () => {
  const { makeTranslator } = await import('../src/i18n.ts');
  const { loadDefaults } = await import('../src/config.ts');
  const keys = [
    ...['same', 'shifted_ok', 'regression', 'inconclusive', 'unrunnable', 'baseline_red'].map((k) => `outcome.${k}`),
    ...['safe', 'fixed', 'broken', 'unrunnable'].map((k) => `verdict.${k}`),
    ...['base_build_failed', 'no_baseline_journey', 'head_build_failed', 'regression', 'all_inconclusive', 'ok'].map((k) => `reason.${k}`),
  ];
  for (const lang of loadDefaults().languages as string[]) {
    const t = makeTranslator(lang);
    for (const k of keys) assert.notEqual(t(k), k, `${lang} is missing ${k}`);
  }
});

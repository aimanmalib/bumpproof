import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { exitCodeOf, newRunId, outcomeOf, renderCheck, runCheck } from '../src/check.ts';
import { makeTranslator } from '../src/i18n.ts';
import { makePaint } from '../src/ui.ts';
import { fakeDocker, phases } from './support/fake-docker.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';

const up = [{ running: true, out: phases('install', 'build', 'serve') }];
const buildFails = [{ running: false, exit: 1, out: phases('install', 'build'), err: 'Error: broken on purpose' }];
const leftovers = (id: string) => readdirSync(tmpdir()).filter((n) => n.startsWith(`bumpproof-${id}`));

test('newRunId is sortable by time and safe as a folder and container name', () => {
  const id = newRunId(new Date(Date.UTC(2026, 10, 21, 22, 5)), () => 0.5);
  assert.equal(id, '20261121-2205-7fff');
  assert.match(newRunId(), /^\d{8}-\d{4}-[0-9a-f]{4}$/);
});

test('outcome and exit code per build result', () => {
  const s = (side: 'base' | 'head', built: boolean) => ({ side, built, seconds: 1, log_tail: [] });
  assert.equal(outcomeOf([s('base', true), s('head', true)]), 'both_built');
  assert.equal(outcomeOf([s('base', true), s('head', false)]), 'head_build_failed');
  assert.equal(outcomeOf([s('base', false)]), 'base_build_failed');
  assert.deepEqual(['both_built', 'head_build_failed', 'base_build_failed'].map((o) => exitCodeOf(o as never)), [0, 1, 2]);
});

test('runCheck: base then head on the same port, head build failure detected, containers and work folder removed', async () => {
  const repo = makeFixtureRepo();
  const fd = fakeDocker([up, buildFails]);
  const ready: string[] = [];
  const rec = await runCheck(fd.deps(), { repo: repo.dir, base: 'base', head: 'head-broken', dir: 'app', runId: 'chk1',
    onReady: async (side) => void ready.push(side) });
  assert.equal(rec.outcome, 'head_build_failed');
  assert.deepEqual(rec.sides.map((s) => [s.side, s.built, s.failed_at]), [['base', true, undefined], ['head', false, 'build']]);
  assert.deepEqual(ready, ['base'], 'journeys only run against a side that is up');
  assert.equal(rec.head.sha, repo.git('rev-parse', 'head-broken'));
  assert.equal(rec.journeys_run, false);
  const runs = fd.calls.filter((c) => c[0] === 'run');
  assert.equal(runs.length, 2);
  for (const r of runs) assert.ok(r.includes('127.0.0.1:4173:4173'));
  const removed = fd.calls.filter((c) => c[0] === 'rm').map((c) => c.at(-1));
  assert.deepEqual(removed, ['bumpproof-chk1-base', 'bumpproof-chk1-head']);
  assert.deepEqual(leftovers('chk1'), []);
  assert.ok(!JSON.stringify(rec).includes(repo.dir), 'record holds no host paths');
});

test('runCheck: a base that does not build stops before the head', async () => {
  const repo = makeFixtureRepo();
  const fd = fakeDocker([buildFails]);
  const rec = await runCheck(fd.deps(), { repo: repo.dir, base: 'head-broken', head: 'base', dir: 'app', runId: 'chk2' });
  assert.equal(rec.outcome, 'base_build_failed');
  assert.equal(rec.sides.length, 1);
  assert.deepEqual(leftovers('chk2'), []);
});

test('renderCheck says what failed, in English and Malay', async () => {
  const repo = makeFixtureRepo();
  const rec = await runCheck(fakeDocker([up, buildFails]).deps(), { repo: repo.dir, base: 'base', head: 'head-broken', dir: 'app', runId: 'chk3' });
  const p = makePaint(false);
  const en = renderCheck(rec, makeTranslator('en'), p);
  assert.match(en, /Head: build failed/);
  assert.match(en, /broken on purpose/);
  assert.match(en, /Browser journeys were not run/);
  const ms = renderCheck(rec, makeTranslator('ms'), p);
  assert.match(ms, /Kepala: binaan gagal/);
});

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, type Io } from '../src/cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';
import { replay, stamp } from '../src/replay.ts';
import { replayDir, runReplay } from '../src/report-cli.ts';
import { readRun } from '../src/report/run.ts';
import { makePaint } from '../src/ui.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const plain = makePaint(false);

function io(env: NodeJS.ProcessEnv = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s), env, cwd: ROOT, isTTY: false };
}

test('stamp formats minutes and seconds', () => {
  assert.equal(stamp(0), '00:00');
  assert.equal(stamp(412), '06:52');
  assert.equal(stamp(-3), '00:00');
});

test('replay prints the timeline in time order and ends with the verdict', async () => {
  const run = readRun(FIXTURE);
  const out: string[] = [];
  const waits: number[] = [];
  await replay(run, makeTranslator('en'), plain, { speed: 0, maxGapMs: 900, sleep: async (ms) => { waits.push(ms); }, out: (l) => out.push(l) });
  assert.deepEqual(waits, [], 'speed 0 never waits');
  const stamps = out.filter((l) => /^\d\d:\d\d {2}/.test(l)).map((l) => l.slice(0, 5));
  assert.equal(stamps.length, run.timeline.length);
  assert.deepEqual(stamps, [...stamps].sort());
  assert.match(out.join('\n'), /synthetic example made for tests/);
  assert.match(out.join('\n'), /05:03 {2}Pull request · account: failed in 33 s/);
  assert.match(out.at(-2)!, /^Verdict: Fixed\. /);
  assert.match(out.at(-1)!, /3 journeys · 93 Kane CLI credits · 6 min 52 s/);
});

test('replay waits in proportion to the recorded gaps, capped', async () => {
  const run = readRun(FIXTURE);
  const waits: number[] = [];
  await replay(run, makeTranslator('en'), plain, { speed: 40, maxGapMs: 900, sleep: async (ms) => { waits.push(ms); }, out: () => {} });
  assert.ok(waits.length > 0);
  assert.ok(waits.every((w) => w > 0 && w <= 900));
  assert.ok(waits.includes(900), 'a long gap is capped');
  assert.ok(waits.includes(50), 'a 2 s gap at speed 40 is 50 ms');
});

test('replay speaks Malay', async () => {
  const out: string[] = [];
  await replay(readRun(FIXTURE), makeTranslator('ms'), plain, { speed: 0, maxGapMs: 0, sleep: async () => {}, out: (l) => out.push(l) });
  const text = out.join('\n');
  assert.match(text, /Ulang tayang larian/);
  assert.match(text, /Pull request · account: gagal dalam 33 s/);
  assert.match(text, /Keputusan: Dibaiki\./);
  assert.doesNotMatch(text, /Replaying|Verdict:|passed in/);
});

test('bumpproof replay: a missing folder or a broken record exits 2 with a message', async () => {
  const cfg = loadConfig(ROOT);
  const t = makeTranslator('en');
  const a = io();
  assert.equal(await runReplay(cfg, t, undefined, undefined, a), 2);
  assert.match(a.stderr.join('\n'), /Give a run folder/);
  const dir = mkdtempSync(join(tmpdir(), 'bp-replay-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema_version: 1 }));
    const b = io();
    assert.equal(await runReplay(cfg, t, dir, '0', b), 2);
    assert.match(b.stderr.join('\n'), /Cannot read this run: \w+: expected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumpproof replay and report --comment run from the command line without network or keys', async () => {
  const a = io();
  assert.equal(await main(['replay', 'test/fixtures/synthetic-run', '--speed', '0'], a), 0);
  assert.match(a.stdout.join('\n'), /Verdict: Fixed/);
  const b = io();
  assert.equal(await main(['report', '--comment', 'test/fixtures/synthetic-run'], b), 0);
  assert.match(b.stdout.join('\n'), /## 🛠️ Bumpproof: Fixed/);
  assert.doesNotMatch(b.stdout.join('\n'), /Run page with/, 'synthetic runs get no public link');
});

test('replay falls back to the runs shipped in the package when the folder is not in the current directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'bumpproof-pkg-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bumpproof-empty-'));
  try {
    const shipped = join(root, 'docs', 'runs', 'r-1');
    mkdirSync(join(root, 'docs', 'runs'), { recursive: true });
    cpSync(FIXTURE, shipped, { recursive: true });
    assert.equal(replayDir(cwd, 'r-1', root), shipped, 'a bare id from an empty folder');
    assert.equal(replayDir(cwd, 'docs/runs/r-1', root), shipped, 'the README path from an empty folder');
    assert.equal(replayDir(cwd, 'nope', root), join(cwd, 'nope'), 'an unknown id stays local, so it still fails');
    const local = join(cwd, 'docs', 'runs', 'r-1');
    cpSync(FIXTURE, local, { recursive: true });
    assert.equal(replayDir(cwd, 'docs/runs/r-1', root), local, 'a folder in the current directory wins');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('bumpproof replay of an id that exists nowhere still exits 2', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bumpproof-empty-'));
  try {
    const o = { ...io(), cwd };
    assert.equal(await main(['replay', 'no-such-run-id'], o), 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

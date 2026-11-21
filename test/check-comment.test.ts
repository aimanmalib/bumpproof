import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTION_MARKER, renderCheckComment, renderRefusalComment } from '../src/check-comment.ts';
import type { CheckRecord } from '../src/check.ts';
import { main, type Io } from '../src/cli.ts';
import { makeTranslator } from '../src/i18n.ts';

const opts = { version: '9.9.9', repoUrl: 'https://example.com/bumpproof', logLines: 2 };
const base = { ref: 'main', sha: 'a'.repeat(40) };
const head = { ref: 'dependabot/npm_and_yarn/x', sha: 'b'.repeat(40) };

function record(over: Partial<CheckRecord>): CheckRecord {
  return { schema_version: 1, run_id: 'r1', started_at: '2026-11-22T00:00:00.000Z', app_dir: 'examples/shop', base, head,
    sides: [], outcome: 'both_built', journeys_run: false, ...over };
}

test('build check comment: marker and outcome first, short shas, honest note that journeys did not run', () => {
  const md = renderCheckComment(record({ sides: [
    { side: 'base', built: true, seconds: 31.2, log_tail: [] }, { side: 'head', built: true, seconds: 29, log_tail: [] }] }),
  makeTranslator('en'), opts);
  const lines = md.split('\n');
  assert.equal(lines[0], ACTION_MARKER);
  assert.equal(lines[1], '<!-- bumpproof-outcome: both_built -->');
  assert.match(md, /`aaaaaaa` → `bbbbbbb`/);
  assert.doesNotMatch(md, /dependabot\/npm_and_yarn/, 'branch names are attacker-chosen in forks; only shas are printed');
  assert.match(md, /Result: both sides build and start\./);
  assert.match(md, /does not run browser journeys or fixes/);
  assert.match(md, /Bumpproof 9\.9\.9 · https:\/\/example\.com\/bumpproof/);
});

test('failed head: the last log lines go in a closed details block, code fences inside the log are defused', () => {
  const md = renderCheckComment(record({ outcome: 'head_build_failed', sides: [
    { side: 'base', built: true, seconds: 30, log_tail: [] },
    { side: 'head', built: false, failed_at: 'build', exit_code: 1, seconds: 12, log_tail: ['one', 'two ```', 'three'] }] }),
  makeTranslator('en'), opts);
  assert.match(md, /<!-- bumpproof-outcome: head_build_failed -->/);
  assert.match(md, /^## ❌ /m);
  assert.match(md, /<details><summary>Head: last lines of the log<\/summary>/);
  assert.doesNotMatch(md, /\bone\b/, 'only the configured number of lines');
  assert.match(md, /two '''/);
  assert.equal(md.match(/```/g)?.length, 2, 'exactly one fence pair');
  assert.match(md, /This counts as a failed build\./);
});

test('base did not build: head skipped line; Malay comment uses the Malay locale', () => {
  const md = renderCheckComment(record({ outcome: 'base_build_failed', sides: [
    { side: 'base', built: false, failed_at: 'install', seconds: 5, log_tail: [] }] }), makeTranslator('ms'), opts);
  assert.match(md, /<!-- bumpproof-outcome: base_build_failed -->/);
  assert.match(md, /Semakan binaan Bumpproof/);
  assert.match(md, /tidak menjalankan perjalanan pelayar/);
});

test('refusal comment says not started and why', () => {
  const md = renderRefusalComment('only 3 GB free | low', makeTranslator('en'), opts);
  assert.match(md, /<!-- bumpproof-outcome: not_started -->/);
  assert.match(md, /Not started: only 3 GB free \\\| low/);
});

function io(cwd: string): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s), env: {}, cwd, isTTY: false };
}

test('check --markdown writes a not-started comment when the refs cannot be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-md-'));
  try {
    const o = io(dir);
    assert.equal(await main(['check', '--base', 'nope', '--head', 'nope2', '--markdown', 'c.md'], o), 2);
    const md = readFileSync(join(dir, 'c.md'), 'utf8');
    assert.match(md, /<!-- bumpproof-outcome: not_started -->/);
    assert.match(md, /Not started: Git error/);
    assert.match(o.stderr.join('\n'), /^Git error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check --min-free-gb must be a number of zero or more', async () => {
  const o = io(tmpdir());
  assert.equal(await main(['check', '--base', 'a', '--head', 'b', '--min-free-gb', 'lots'], o), 2);
  assert.match(o.stderr[0] ?? '', /--min-free-gb needs a number/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstLine, run } from '../src/proc.ts';

test('run captures output and exit code without a shell', async () => {
  const r = await run(process.execPath, ['-e', 'console.log("a b"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.ok, false);
  assert.equal(r.stdout.trim(), 'a b');
});

test('run reports ENOENT for a missing binary', async () => {
  const r = await run('bumpproof-no-such-binary', []);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ENOENT');
});

test('run kills a process that outlives the timeout', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TIMEOUT');
});

test('firstLine skips blank lines', () => {
  assert.equal(firstLine('\n\n  v1.2  \nnext'), 'v1.2');
  assert.equal(firstLine(''), '');
});

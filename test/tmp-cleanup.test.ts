// The suite must not leave folders in the system temp folder (one run used to leave about 70).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './support/tmp.ts';

const DIR = new URL('.', import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith('.test.ts') && f !== 'tmp-cleanup.test.ts')
  .map((f) => ({ f, src: readFileSync(join(DIR, f), 'utf8') }));

test('test files that make temp folders through tempDir leave none behind', () => {
  const users = files.filter((x) => /\btempDir\(|\bmakeFixtureRepo\(/.test(x.src)).map((x) => join(DIR, x.f));
  assert.ok(users.length > 0);
  const scratch = tempDir('bumpproof-leak-');
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
  delete env.NODE_TEST_CONTEXT; // otherwise the child reports to this runner instead of running on its own
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...users], { env, encoding: 'utf8' });
  try {
    assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a test file that calls mkdtempSync itself also removes what it made', () => {
  const raw = files.filter((x) => x.src.includes('mkdtempSync(') && !x.src.includes('rmSync(')).map((x) => x.f);
  assert.deepEqual(raw, []);
});

test('tempDir folders are gone once the process exits', () => {
  const helper = new URL('./support/tmp.ts', import.meta.url).href;
  const code = `import { tempDir } from '${helper}'; console.log(tempDir('bumpproof-exit-'));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.ok(dir.includes('bumpproof-exit-'));
  assert.throws(() => readdirSync(dir), { code: 'ENOENT' });
});

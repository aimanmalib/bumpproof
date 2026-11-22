// `dist/` is committed so that `npm install -g github:…` works without a build step on the user's machine.
// This test fails when someone changes `src/` and forgets `npm run build`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../src/config.ts';

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

test('the committed dist/ is the current build of src/ (run npm run build after changing src/)', () => {
  const out = mkdtempSync(join(tmpdir(), 'bumpproof-dist-'));
  try {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out], { cwd: ROOT, stdio: 'pipe' });
    const committed = join(ROOT, 'dist');
    const want = files(out);
    assert.deepEqual(files(committed), want, 'dist/ has the same files as a fresh build');
    const stale = want.filter((f) => !readFileSync(join(committed, f)).equals(readFileSync(join(out, f))));
    assert.deepEqual(stale, [], 'every file in dist/ matches a fresh build byte for byte');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

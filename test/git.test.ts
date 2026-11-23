import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanSubdir, exportTree, GitError, gitEnv, resolveRef } from '../src/git.ts';
import { run } from '../src/proc.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';
import { tempDir } from './support/tmp.ts';

test('gitEnv drops GIT_* from a calling hook and turns prompts off', () => {
  const env = gitEnv({ PATH: '/bin', GIT_DIR: '/real/.git', GIT_INDEX_FILE: 'x', GIT_WORK_TREE: '/real' });
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: '0', PATH: '/bin' });
});

test('cleanSubdir normalises and refuses to climb out', () => {
  assert.equal(cleanSubdir('./examples//shop/'), 'examples/shop');
  assert.equal(cleanSubdir(''), '');
  assert.throws(() => cleanSubdir('examples/../../etc'), GitError);
});

test('resolveRef gives full shas and rejects unknown or option-like refs', async () => {
  const repo = makeFixtureRepo();
  assert.equal(await resolveRef(run, repo.dir, 'base'), repo.git('rev-parse', 'base'));
  await assert.rejects(resolveRef(run, repo.dir, 'no-such-branch'), GitError);
  await assert.rejects(resolveRef(run, repo.dir, '--upload-pack=x'), GitError);
});

test('exportTree writes only the app folder at that commit, without .git', async () => {
  const repo = makeFixtureRepo();
  const dest = join(tempDir('bumpproof-export-'), 'base');
  await exportTree(run, repo.dir, repo.git('rev-parse', 'base'), 'app', dest);
  assert.ok(existsSync(join(dest, 'package.json')));
  assert.ok(!existsSync(join(dest, '.git')));
  assert.ok(!existsSync(`${dest}.tar`), 'archive removed');
  assert.match(readFileSync(join(dest, 'build.js'), 'utf8'), /writeFileSync/);
  await exportTree(run, repo.dir, repo.git('rev-parse', 'head-broken'), 'app', dest);
  assert.match(readFileSync(join(dest, 'build.js'), 'utf8'), /broken on purpose/);
});

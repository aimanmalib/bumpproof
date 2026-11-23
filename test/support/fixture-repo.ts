// Builds a throwaway git repository holding the sandbox fixture app under `app/`:
// commit "base" builds; commit "head-broken" has a build script that throws.
import { execFileSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from '../../src/git.ts';
import { tempDir } from './tmp.ts';

const FIXTURE = new URL('../fixtures/sandbox-app/', import.meta.url);

export interface FixtureRepo {
  dir: string;
  git: (...args: string[]) => string;
}

export function makeFixtureRepo(): FixtureRepo {
  const dir = tempDir('bumpproof-test-repo-');
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  cpSync(FIXTURE, join(dir, 'app'), { recursive: true });
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('tag', 'base');
  writeFileSync(join(dir, 'app', 'build.js'), "throw new Error('broken on purpose by the sandbox test');\n");
  git('commit', '--quiet', '-am', 'head-broken');
  git('tag', 'head-broken');
  return { dir, git };
}

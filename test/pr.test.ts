import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { gitEnv } from '../src/git.ts';
import { makeTranslator } from '../src/i18n.ts';
import {
  appDirOf, canWrite, mergeLocally, fillVars, parsePrInfo, parsePrRef, PR_MARKER, PrError, pushFix, upsertComment, type PrInfo,
} from '../src/pr.ts';
import { parsePrArgs, prComment, runPr } from '../src/pr-cli.ts';
import { readRun } from '../src/report/run.ts';
import { run, type Runner } from '../src/proc.ts';
import { repoName } from '../src/report/words.ts';
import { makePaint } from '../src/ui.ts';

const cfg = loadConfig(tmpdir());

test('parsePrRef reads owner/repo#n and pull request URLs, and nothing else', () => {
  assert.deepEqual(parsePrRef('octo/app#12'), { owner: 'octo', repo: 'app', number: 12 });
  assert.deepEqual(parsePrRef('https://github.com/octo/my.app/pull/7'), { owner: 'octo', repo: 'my.app', number: 7 });
  for (const bad of [undefined, '', 'octo/app', 'octo/app#0', 'octo#3', '--repo/x#1', 'https://evil.example/octo/app/pull/1']) {
    assert.equal(parsePrRef(bad), null, String(bad));
  }
});

const ghJson = (o: Record<string, unknown> = {}) => JSON.stringify({
  number: 4, title: 'Bump clsx from 1.2.1 to 2.1.1 in /examples/shop', url: 'https://github.com/o/r/pull/4', state: 'OPEN',
  baseRefName: 'main', headRefName: 'dependabot/npm_and_yarn/examples/shop/clsx-2.1.1', headRefOid: 'a'.repeat(40),
  isCrossRepository: false, author: { login: 'app/dependabot' },
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...o,
});

test('parsePrInfo takes the fields, the CI state and the app folder from the title', () => {
  const i = parsePrInfo(ghJson());
  assert.equal(i.head_ref, 'dependabot/npm_and_yarn/examples/shop/clsx-2.1.1');
  assert.equal(i.author, 'app/dependabot');
  assert.equal(i.ci, 'green');
  assert.equal(i.title_dir, '/examples/shop');
  assert.equal(parsePrInfo(ghJson({ title: 'Bump clsx from 1 to 2' })).title_dir, null);
  assert.throws(() => parsePrInfo('not json'), PrError);
  assert.throws(() => parsePrInfo('{"number":1}'), PrError);
});

test('appDirOf: --dir, then the folder in the title, then config', () => {
  const i = parsePrInfo(ghJson());
  assert.equal(appDirOf(i, 'web', undefined), 'examples/shop');
  assert.equal(appDirOf(i, 'web', ''), '');
  assert.equal(appDirOf({ ...i, title_dir: null }, 'web', undefined), 'web');
});

test('canWrite only for repositories listed in config, any letter case', () => {
  const c = { ...cfg, pr: { ...cfg.pr, write_repos: ['https://github.com/Octo/App'] } };
  assert.equal(canWrite(c, { owner: 'octo', repo: 'app', number: 1 }), true);
  assert.equal(canWrite(c, { owner: 'octo', repo: 'other', number: 1 }), false);
  const forms = { ...cfg, pr: { ...cfg.pr, write_repos: ['github.com/octo/app.git', 'octo/lib/'] } };
  assert.equal(canWrite(forms, { owner: 'octo', repo: 'app', number: 1 }), true);
  assert.equal(canWrite(forms, { owner: 'octo', repo: 'lib', number: 1 }), true);
});

test('repoName shows any stored repository form as github.com/owner/repo', () => {
  assert.equal(repoName('https://github.com/octo/app'), 'github.com/octo/app');
  assert.equal(repoName('octo/app'), 'github.com/octo/app');
  assert.equal(repoName('https://gitlab.example.com/octo/app.git'), 'gitlab.example.com/octo/app');
});

test('parsePrArgs: --comment is a flag for pr, not a value-taking option', () => {
  const f = parsePrArgs(['pr', 'o/r#1', '--fix', '--comment', '--push-fix']);
  assert.deepEqual([f.target, f.fix, f.comment, f.pushFix, f.publish], ['o/r#1', true, true, true, false]);
});

test('fillVars fills known placeholders and leaves the rest', () => {
  assert.equal(fillVars('Fix {name} {from} -> {to} {x}', { name: 'clsx', from: '1', to: '2' }), 'Fix clsx 1 -> 2 {x}');
});

function runCapture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (s: string) => out.push(s), e: (s: string) => err.push(s) };
}

test('runPr refuses to comment or push on a repository that is not ours, before touching the network', async () => {
  const calls: string[] = [];
  const fake: Runner = async (cmd) => {
    calls.push(cmd);
    return { ok: false, code: 1, stdout: '', stderr: '' };
  };
  const t = makeTranslator('en');
  const cap = runCapture();
  const deps = { cfg, run: fake } as unknown as Parameters<typeof runPr>[0]['deps'];
  const c = { deps, fetch: async () => null, version: '0', cwd: tmpdir(), out: cap.o, err: cap.e } as unknown as Parameters<typeof runPr>[0];
  const p = makePaint(false);
  assert.equal(await runPr(c, parsePrArgs(['pr', 'someone/else#3', '--comment']), t, p), 2);
  assert.match(cap.err.join('\n'), /not one of them/);
  assert.equal(await runPr(c, parsePrArgs(['pr', 'nope']), t, p), 2);
  assert.equal(await runPr(c, parsePrArgs(['pr', `${cfg.pr.write_repos[0]!.replace('https://github.com/', '')}#1`, '--push-fix']), t, p), 2);
  assert.match(cap.err.join('\n'), /needs --fix/);
  assert.deepEqual(calls, []);
});

test('upsertComment edits the earlier Bumpproof comment, or posts a new one', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bumpproof-pr-comment-'));
  try {
    for (const existing of ['', '991\n']) {
      const calls: string[][] = [];
      const fake: Runner = async (_cmd, args) => {
        calls.push(args);
        if (args.includes('--paginate')) return { ok: true, code: 0, stdout: existing, stderr: '' };
        return { ok: true, code: 0, stdout: 'https://github.com/o/r/pull/4#issuecomment-1\n', stderr: '' };
      };
      const url = await upsertComment(fake, cfg, { owner: 'o', repo: 'r', number: 4 }, 'hello', scratch);
      assert.equal(url, 'https://github.com/o/r/pull/4#issuecomment-1');
      const write = calls[1]!;
      if (existing) assert.deepEqual(write.slice(0, 4), ['api', '-X', 'PATCH', 'repos/o/r/issues/comments/991']);
      else assert.deepEqual(write.slice(0, 4), ['api', '-X', 'POST', 'repos/o/r/issues/4/comments']);
      const body = (JSON.parse(readFileSync(join(scratch, 'comment.json'), 'utf8')) as { body: string }).body;
      assert.equal(body, `${PR_MARKER}\nhello`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** A bare "GitHub" with a PR branch and a merge ref, plus a clone of it, all on disk. */
function makeOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'bumpproof-pr-git-'));
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' }).trim();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin], { env });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', work], { env });
  mkdirSync(join(work, 'app', 'src'), { recursive: true });
  writeFileSync(join(work, 'app', 'package.json'), '{"dependencies":{"lib":"1.0.0"}}\n');
  writeFileSync(join(work, 'app', 'src', 'a.js'), "export const status = 'loading';\n");
  g(work, 'add', '.');
  g(work, 'commit', '--quiet', '-m', 'base');
  g(work, 'checkout', '--quiet', '-b', 'bump');
  writeFileSync(join(work, 'app', 'package.json'), '{"dependencies":{"lib":"2.0.0"}}\n');
  g(work, 'commit', '--quiet', '-am', 'Bump lib from 1.0.0 to 2.0.0 in /app');
  const head = g(work, 'rev-parse', 'HEAD');
  g(work, 'checkout', '--quiet', 'main');
  g(work, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'bump');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '--quiet', 'origin', 'HEAD~1:refs/heads/main', 'bump:refs/heads/bump', 'HEAD:refs/pull/1/merge');
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', '--no-checkout', origin, clone], { env });
  g(clone, 'config', 'user.name', 't');
  g(clone, 'config', 'user.email', 't@example.com');
  const info: PrInfo = { number: 1, title: 'Bump lib', url: '', state: 'OPEN', base_ref: 'main', head_ref: 'bump', head_sha: head,
    cross_repo: false, author: 'app/dependabot', ci: 'green', title_dir: '/app' };
  return { root, origin, work, clone, info, g, merge: g(origin, 'rev-parse', 'refs/pull/1/merge') };
}

const FILES = [{ path: 'src/a.js', content: "export const status = 'pending';\n" }, { path: 'BUMPPROOF_FIX.md', content: '# fix\n' }];

test('mergeLocally merges the PR head into the current base tip and checks the base out', async () => {
  const o = makeOrigin();
  try {
    // The base branch moved after the PR was opened (a stale GitHub merge ref would miss this commit).
    o.g(o.work, 'checkout', '--quiet', '-B', 'later', 'HEAD~1');
    mkdirSync(join(o.work, 'app', 'journeys'), { recursive: true });
    writeFileSync(join(o.work, 'app', 'journeys', 'shop_test.md'), 'journey\n');
    o.g(o.work, 'add', '.');
    o.g(o.work, 'commit', '--quiet', '-m', 'add a journey on main');
    o.g(o.work, 'push', '--quiet', 'origin', 'later:refs/heads/main', 'refs/heads/bump:refs/pull/1/head');
    const r = await mergeLocally(run, o.clone, o.info);
    assert.equal(r.base, o.g(o.origin, 'rev-parse', 'main'));
    assert.deepEqual(o.g(o.clone, 'rev-list', '--parents', '-n1', r.head).split(' ').slice(1), [r.base, o.info.head_sha]);
    assert.equal(o.g(o.clone, 'show', `${r.head}:app/package.json`), '{"dependencies":{"lib":"2.0.0"}}');
    assert.equal(readFileSync(join(o.clone, 'app', 'journeys', 'shop_test.md'), 'utf8'), 'journey\n');
    await assert.rejects(mergeLocally(run, o.clone, { ...o.info, head_sha: 'b'.repeat(40) }), /moved/);
    // A base change to the same line conflicts: refused.
    o.g(o.work, 'checkout', '--quiet', 'later');
    writeFileSync(join(o.work, 'app', 'package.json'), '{"dependencies":{"lib":"1.5.0"}}\n');
    o.g(o.work, 'commit', '--quiet', '-am', 'conflict');
    o.g(o.work, 'push', '--quiet', 'origin', 'later:refs/heads/main');
    await assert.rejects(mergeLocally(run, o.clone, o.info), /does not merge cleanly/);
  } finally {
    rmSync(o.root, { recursive: true, force: true });
  }
});

test('pushFix writes the fixed files inside the app folder and pushes one fast-forward commit to the PR branch', async () => {
  const o = makeOrigin();
  try {
    const sha = await pushFix(run, { clone: o.clone, info: o.info, merge: o.merge, files: FILES, dir: 'app', message: 'Fix lib', scratch: o.root });
    assert.equal(o.g(o.origin, 'rev-parse', 'bump'), sha);
    assert.equal(o.g(o.origin, 'rev-parse', `${sha}^`), o.info.head_sha);
    assert.equal(o.g(o.origin, 'show', `${sha}:app/src/a.js`), "export const status = 'pending';");
    assert.equal(o.g(o.origin, 'show', `${sha}:app/BUMPPROOF_FIX.md`), '# fix');
    // The branch has moved since the run (it is now at `sha`): refused, nothing pushed.
    await assert.rejects(pushFix(run, { clone: o.clone, info: o.info, merge: o.merge, files: FILES, dir: 'app', message: 'again', scratch: o.root }), /moved/);
    assert.equal(o.g(o.origin, 'rev-parse', 'bump'), sha);
  } finally {
    rmSync(o.root, { recursive: true, force: true });
  }
});

test('pushFix refuses forks, empty fixes, paths outside the app and files that changed under it', async () => {
  const o = makeOrigin();
  try {
    const p = { clone: o.clone, info: o.info, merge: o.merge, files: FILES, dir: 'app', message: 'm', scratch: o.root };
    await assert.rejects(pushFix(run, { ...p, info: { ...o.info, cross_repo: true } }), /fork/);
    await assert.rejects(pushFix(run, { ...p, files: [] }), /no fix/);
    await assert.rejects(pushFix(run, { ...p, files: [{ path: '../x', content: '' }] }), /inside the repository/);
    // package.json differs between the branch and the merge ref the fix was verified on (here: the base tip).
    await assert.rejects(pushFix(run, { ...p, merge: o.g(o.origin, 'rev-parse', 'main'), files: [{ path: 'package.json', content: '{}' }] }), /differs/);
    assert.equal(o.g(o.origin, 'rev-parse', 'bump'), o.info.head_sha);
  } finally {
    rmSync(o.root, { recursive: true, force: true });
  }
});

test('a verified fix left off the branch says so, with the command that reproduces the break', () => {
  const fixed = readRun(join(import.meta.dirname, 'fixtures', 'synthetic-run'));
  const o = { runUrl: null, bugCode: 740, pushed: null, branch: 'dependabot/x', target: 'o/r#3' };
  for (const lang of ['en', 'ms'] as const) {
    const t = makeTranslator(lang);
    const kept = prComment(fixed, t, o);
    assert.match(kept, /`bumpproof pr o\/r#3`/);
    assert.match(kept, /`dependabot\/x`/);
    const pushed = prComment(fixed, t, { ...o, pushed: 'a'.repeat(40) });
    assert.doesNotMatch(pushed, /bumpproof pr o\/r#3/);
    assert.match(pushed, new RegExp('a'.repeat(40)));
    const safe = { ...fixed, verdict: { ...fixed.verdict, verdict: 'safe' as const } };
    assert.doesNotMatch(prComment(safe, t, o), /bumpproof pr o\/r#3/);
  }
});

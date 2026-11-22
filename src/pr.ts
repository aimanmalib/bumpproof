// `bumpproof pr <owner/repo>#<n>`: the pull request side of a run. Reads the PR through `gh`, fetches GitHub's merge
// ref (the PR applied on top of its base branch, which is what CI tests), and, only on repositories listed as ours,
// posts the result comment and pushes a verified fix onto the PR branch as a normal commit (never a force push).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ciState } from './census-rules.ts';
import type { Config } from './config.ts';
import { cleanSubdir, GitError, gitEnv } from './git.ts';
import type { Runner } from './proc.ts';

export class PrError extends Error {}

export interface PrRef { owner: string; repo: string; number: number }

/** `owner/repo#12` or `https://github.com/owner/repo/pull/12`. */
export function parsePrRef(s: string | undefined): PrRef | null {
  if (!s) return null;
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][A-Za-z0-9._-]*?)(?:#|\/pull\/)(\d+)\/?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[3]);
  return n > 0 ? { owner: m[1]!, repo: m[2]!, number: n } : null;
}

export const slug = (r: PrRef) => `${r.owner}/${r.repo}`;

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  cross_repo: boolean;
  author: string;
  ci: string;
  /** App folder from a Dependabot or Renovate title (`in /examples/shop`), or null. */
  title_dir: string | null;
}

export const PR_FIELDS = 'number,title,url,state,baseRefName,headRefName,headRefOid,isCrossRepository,author,statusCheckRollup';

export function parsePrInfo(text: string): PrInfo {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PrError('gh returned something that is not JSON');
  }
  const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : '');
  if (typeof j.number !== 'number' || !str('headRefOid')) throw new PrError('gh did not return the pull request fields');
  const author = j.author && typeof j.author === 'object' ? (j.author as { login?: unknown }).login : '';
  const dir = / in (\/\S*)\s*$/.exec(str('title'))?.[1] ?? null;
  return {
    number: j.number, title: str('title'), url: str('url'), state: str('state'), base_ref: str('baseRefName'),
    head_ref: str('headRefName'), head_sha: str('headRefOid'), cross_repo: j.isCrossRepository === true,
    author: typeof author === 'string' ? author : '', ci: ciState(j.statusCheckRollup), title_dir: dir,
  };
}

export async function fetchPrInfo(run: Runner, cfg: Config, ref: PrRef): Promise<PrInfo> {
  const r = await run(cfg.github.command, ['pr', 'view', String(ref.number), '-R', slug(ref), '--json', PR_FIELDS], { timeoutMs: 60000 });
  if (!r.ok) throw new PrError(`gh pr view: ${(r.stderr || r.error || '').trim().split('\n').pop() ?? ''}`);
  return parsePrInfo(r.stdout);
}

/** Comment and push are allowed only on the repositories listed in config (`pr.write_repos`, case-insensitive). */
export function canWrite(cfg: Config, ref: PrRef): boolean {
  return cfg.pr.write_repos.some((r) => r.toLowerCase() === slug(ref).toLowerCase());
}

/** The PR's own folder name in its title wins over the configured one: Dependabot names it. */
export function appDirOf(info: PrInfo, configured: string, given: string | undefined): string {
  if (given !== undefined) return given;
  if (info.title_dir) return info.title_dir.replace(/^\/+/, '');
  return configured;
}

async function git(run: Runner, repo: string, args: string[], timeoutMs = 600000): Promise<string> {
  const r = await run('git', ['-C', repo, ...args], { timeoutMs, env: gitEnv() });
  if (!r.ok) throw new GitError(`git ${args[0]}: ${(r.stderr || r.error || '').trim().split('\n').pop() ?? ''}`);
  return r.stdout.trim();
}

export interface PrRefs { base: string; head: string }

/**
 * Fetches `refs/pull/<n>/merge` into a clone. Its first parent is the base branch tip, the commit itself is the PR
 * merged on top: comparing the two shows exactly what merging the PR would change, even when the branch is behind.
 */
export async function fetchMergeRefs(run: Runner, clone: string, n: number): Promise<PrRefs> {
  try {
    await git(run, clone, ['fetch', '--quiet', 'origin', `+refs/pull/${n}/merge:refs/bumpproof/merge`]);
  } catch (e) {
    throw new PrError(`no merge ref for #${n}: the pull request has conflicts or is closed (${(e as Error).message})`);
  }
  const head = await git(run, clone, ['rev-parse', 'refs/bumpproof/merge^{commit}']);
  const base = await git(run, clone, ['rev-parse', 'refs/bumpproof/merge^1']);
  return { base, head };
}

/** Comment bodies start with this line so a later run edits its own comment instead of adding another. */
export const PR_MARKER = '<!-- bumpproof-pr -->';

/** Posts the comment, or edits the earlier Bumpproof comment on the same PR. Returns the comment URL. */
export async function upsertComment(run: Runner, cfg: Config, ref: PrRef, body: string, scratch: string): Promise<string> {
  const text = `${PR_MARKER}\n${body}`;
  const list = await run(cfg.github.command, ['api', '--paginate', `repos/${slug(ref)}/issues/${ref.number}/comments`,
    '--jq', `.[] | select(.body | startswith("${PR_MARKER}")) | .id`], { timeoutMs: 60000 });
  if (!list.ok) throw new PrError(`gh api comments: ${list.stderr.trim().split('\n').pop() ?? ''}`);
  const id = list.stdout.trim().split('\n').filter(Boolean)[0];
  const file = join(scratch, 'comment.json');
  writeFileSync(file, JSON.stringify({ body: text }));
  const args = id
    ? ['api', '-X', 'PATCH', `repos/${slug(ref)}/issues/comments/${id}`, '--input', file, '--jq', '.html_url']
    : ['api', '-X', 'POST', `repos/${slug(ref)}/issues/${ref.number}/comments`, '--input', file, '--jq', '.html_url'];
  const r = await run(cfg.github.command, args, { timeoutMs: 60000 });
  if (!r.ok) throw new PrError(`gh api comment: ${r.stderr.trim().split('\n').pop() ?? ''}`);
  return r.stdout.trim();
}

export interface PushInput {
  clone: string;
  info: PrInfo;
  /** The merge ref commit the fix was made and verified on. */
  merge: string;
  /** Files the verified fix changed, relative to the app folder (null content = deleted). */
  files: { path: string; content: string | null }[];
  dir: string;
  message: string;
  scratch: string;
}

/** Blob id of `path` at `commit`, or '' when the file is not there. */
async function blobAt(run: Runner, repo: string, commit: string, path: string): Promise<string> {
  const r = await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${commit}:${path}`], { timeoutMs: 60000, env: gitEnv() });
  return r.ok ? r.stdout.trim() : '';
}

/**
 * Writes the verified files on the PR branch as it is on GitHub now and pushes one new commit. Each file must be
 * the same on the branch as on the merge ref the fix was verified on, so nothing the fix did not see is overwritten.
 * A branch that moved since the run is refused here and, in a race, by git (not a fast-forward).
 */
export async function pushFix(run: Runner, p: PushInput): Promise<string> {
  if (p.info.cross_repo) throw new PrError('the PR branch lives in a fork; Bumpproof pushes only to branches of the same repository');
  if (p.files.length === 0) throw new PrError('there is no fix to push');
  await git(run, p.clone, ['fetch', '--quiet', 'origin', `+refs/heads/${p.info.head_ref}:refs/bumpproof/head`]);
  const tip = await git(run, p.clone, ['rev-parse', 'refs/bumpproof/head^{commit}']);
  if (tip !== p.info.head_sha) throw new PrError(`the PR branch moved during the run (${tip.slice(0, 7)}); run again`);
  const paths = p.files.map((f) => {
    const rel = cleanSubdir(f.path);
    if (!rel) throw new PrError(`bad path in the fix: ${f.path}`);
    return p.dir ? `${cleanSubdir(p.dir)}/${rel}` : rel;
  });
  for (const path of paths) {
    if ((await blobAt(run, p.clone, tip, path)) !== (await blobAt(run, p.clone, p.merge, path))) {
      throw new PrError(`${path} on the PR branch differs from what the fix was verified on; rebase the PR and run again`);
    }
  }
  const work = join(p.scratch, 'push');
  await git(run, p.clone, ['worktree', 'add', '--quiet', '--detach', work, tip]);
  try {
    p.files.forEach((f, i) => {
      const target = join(work, paths[i]!);
      if (f.content === null) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content);
      }
    });
    await git(run, work, ['add', '--all', '--', ...paths]);
    await git(run, work, ['commit', '--quiet', '-m', p.message]);
    const sha = await git(run, work, ['rev-parse', 'HEAD']);
    await git(run, work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${p.info.head_ref}`]);
    return sha;
  } finally {
    await run('git', ['-C', p.clone, 'worktree', 'remove', '--force', work], { timeoutMs: 60000, env: gitEnv() });
  }
}

/** `{name}` style placeholders from config templates; unknown ones stay as written. */
export function fillVars(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

// `bumpproof pr <owner/repo>#<n>`: the pull request side of a run. Reads the PR through `gh`, fetches GitHub's merge
// ref (the PR applied on top of its base branch, which is what CI tests), and, only on repositories listed as ours,
// posts the result comment and pushes a verified fix onto the PR branch as a normal commit (never a force push).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ciState } from "./census-rules.js";
import { cleanSubdir, GitError, gitEnv } from "./git.js";
export class PrError extends Error {
}
/** `owner/repo#12` or `https://github.com/owner/repo/pull/12`. */
export function parsePrRef(s) {
    if (!s)
        return null;
    const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][A-Za-z0-9._-]*?)(?:#|\/pull\/)(\d+)\/?$/.exec(s.trim());
    if (!m)
        return null;
    const n = Number(m[3]);
    return n > 0 ? { owner: m[1], repo: m[2], number: n } : null;
}
export const slug = (r) => `${r.owner}/${r.repo}`;
export const PR_FIELDS = 'number,title,url,state,baseRefName,headRefName,headRefOid,isCrossRepository,author,statusCheckRollup';
export function parsePrInfo(text) {
    let j;
    try {
        j = JSON.parse(text);
    }
    catch {
        throw new PrError('gh returned something that is not JSON');
    }
    const str = (k) => (typeof j[k] === 'string' ? j[k] : '');
    if (typeof j.number !== 'number' || !str('headRefOid'))
        throw new PrError('gh did not return the pull request fields');
    const author = j.author && typeof j.author === 'object' ? j.author.login : '';
    const dir = / in (\/\S*)\s*$/.exec(str('title'))?.[1] ?? null;
    return {
        number: j.number, title: str('title'), url: str('url'), state: str('state'), base_ref: str('baseRefName'),
        head_ref: str('headRefName'), head_sha: str('headRefOid'), cross_repo: j.isCrossRepository === true,
        author: typeof author === 'string' ? author : '', ci: ciState(j.statusCheckRollup), title_dir: dir,
    };
}
export async function fetchPrInfo(run, cfg, ref) {
    const r = await run(cfg.github.command, ['pr', 'view', String(ref.number), '-R', slug(ref), '--json', PR_FIELDS], { timeoutMs: 60000 });
    if (!r.ok)
        throw new PrError(`gh pr view: ${(r.stderr || r.error || '').trim().split('\n').pop() ?? ''}`);
    return parsePrInfo(r.stdout);
}
/** `https://github.com/owner/repo`, the form run records and config use. */
export const repoUrl = (r) => `https://github.com/${slug(r)}`;
const normRepo = (s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/(\.git)?\/*$/, '');
/** Comment and push are allowed only on the repositories listed in config (`pr.write_repos`, URLs, case-insensitive). */
export function canWrite(cfg, ref) {
    return cfg.pr.write_repos.some((r) => normRepo(r) === slug(ref).toLowerCase());
}
/** The PR's own folder name in its title wins over the configured one: Dependabot names it. */
export function appDirOf(info, configured, given) {
    if (given !== undefined)
        return given;
    if (info.title_dir)
        return info.title_dir.replace(/^\/+/, '');
    return configured;
}
export async function git(run, repo, args, timeoutMs = 600000) {
    const r = await run('git', ['-C', repo, ...args], { timeoutMs, env: gitEnv() });
    if (!r.ok)
        throw new GitError(`git ${args[0]}: ${(r.stderr || r.error || '').trim().split('\n').pop() ?? ''}`);
    return r.stdout.trim();
}
/** Identity for the local merge commit only; it is never pushed. */
export const MERGE_IDENTITY = ['-c', 'user.name=Bumpproof', '-c', 'user.email=bumpproof@localhost.invalid'];
/**
 * Merges the PR head into the current tip of its base branch inside the clone (no push) and checks the base out, so
 * the working tree holds the base's journeys. GitHub's own `refs/pull/<n>/merge` can lag behind the base branch, so
 * the merge is made here: comparing base tip and merge shows exactly what merging the PR would change now.
 */
export async function mergeLocally(run, clone, info) {
    if (info.base_ref.startsWith('-') || info.head_ref.startsWith('-'))
        throw new PrError('bad branch name');
    await git(run, clone, ['fetch', '--quiet', 'origin', `+refs/heads/${info.base_ref}:refs/bumpproof/base`,
        `+refs/pull/${info.number}/head:refs/bumpproof/pr`]);
    const base = await git(run, clone, ['rev-parse', 'refs/bumpproof/base^{commit}']);
    const pr = await git(run, clone, ['rev-parse', 'refs/bumpproof/pr^{commit}']);
    if (pr !== info.head_sha)
        throw new PrError(`the PR head moved while it was read (${pr.slice(0, 7)}); run again`);
    const head = await mergeOnto(run, clone, base, pr, info);
    await git(run, clone, ['checkout', '--quiet', '--detach', base]);
    return { base, head };
}
/** A local merge commit of `pr` on top of `base` (nothing is checked out or pushed). */
export async function mergeOnto(run, clone, base, pr, info) {
    const tree = await run('git', ['-C', clone, 'merge-tree', '--write-tree', base, pr], { timeoutMs: 600000, env: gitEnv() });
    if (!tree.ok)
        throw new PrError(`#${info.number} does not merge cleanly into ${info.base_ref}; rebase it first`);
    const treeSha = tree.stdout.trim().split('\n')[0];
    return git(run, clone, [...MERGE_IDENTITY, 'commit-tree', treeSha, '-p', base, '-p', pr, '-m', `Merge #${info.number} into ${info.base_ref}`]);
}
/** Comment bodies start with this line so a later run edits its own comment instead of adding another. */
export const PR_MARKER = '<!-- bumpproof-pr -->';
/** Posts the comment, or edits the earlier Bumpproof comment on the same PR. Returns the comment URL. */
export async function upsertComment(run, cfg, ref, body, scratch) {
    const text = `${PR_MARKER}\n${body}`;
    const list = await run(cfg.github.command, ['api', '--paginate', `repos/${slug(ref)}/issues/${ref.number}/comments`,
        '--jq', `.[] | select(.body | startswith("${PR_MARKER}")) | .id`], { timeoutMs: 60000 });
    if (!list.ok)
        throw new PrError(`gh api comments: ${list.stderr.trim().split('\n').pop() ?? ''}`);
    const id = list.stdout.trim().split('\n').filter(Boolean)[0];
    const file = join(scratch, 'comment.json');
    writeFileSync(file, JSON.stringify({ body: text }));
    const args = id
        ? ['api', '-X', 'PATCH', `repos/${slug(ref)}/issues/comments/${id}`, '--input', file, '--jq', '.html_url']
        : ['api', '-X', 'POST', `repos/${slug(ref)}/issues/${ref.number}/comments`, '--input', file, '--jq', '.html_url'];
    const r = await run(cfg.github.command, args, { timeoutMs: 60000 });
    if (!r.ok)
        throw new PrError(`gh api comment: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    return r.stdout.trim();
}
/** Blob id of `path` at `commit`, or '' when the file is not there. */
async function blobAt(run, repo, commit, path) {
    const r = await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${commit}:${path}`], { timeoutMs: 60000, env: gitEnv() });
    return r.ok ? r.stdout.trim() : '';
}
/**
 * Writes the verified files on the PR branch as it is on GitHub now and pushes one new commit. Each file must be
 * the same on the branch as on the merge ref the fix was verified on, so nothing the fix did not see is overwritten.
 * A branch that moved since the run is refused here and, in a race, by git (not a fast-forward).
 */
export async function pushFix(run, p) {
    if (p.info.cross_repo)
        throw new PrError('the PR branch lives in a fork; Bumpproof pushes only to branches of the same repository');
    if (p.files.length === 0)
        throw new PrError('there is no fix to push');
    await git(run, p.clone, ['fetch', '--quiet', 'origin', `+refs/heads/${p.info.head_ref}:refs/bumpproof/head`]);
    const tip = await git(run, p.clone, ['rev-parse', 'refs/bumpproof/head^{commit}']);
    if (tip !== p.info.head_sha)
        throw new PrError(`the PR branch moved during the run (${tip.slice(0, 7)}); run again`);
    const paths = p.files.map((f) => {
        const rel = cleanSubdir(f.path);
        if (!rel)
            throw new PrError(`bad path in the fix: ${f.path}`);
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
            const target = join(work, paths[i]);
            if (f.content === null)
                rmSync(target, { force: true });
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
    }
    finally {
        await run('git', ['-C', p.clone, 'worktree', 'remove', '--force', work], { timeoutMs: 60000, env: gitEnv() });
    }
}
/** `{name}` style placeholders from config templates; unknown ones stay as written. */
export function fillVars(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

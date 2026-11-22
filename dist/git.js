// Git plumbing for a run: resolve refs to commits and export the app folder at a commit into a plain directory.
// The exported folders hold no .git, so the sandbox never sees repository history or credentials.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export class GitError extends Error {
}
const SHA = /^[0-9a-f]{40}$/;
/** No prompts, and no GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE from a calling hook: `-C <repo>` must decide the repository. */
export function gitEnv(env = process.env) {
    const out = { GIT_TERMINAL_PROMPT: '0' };
    for (const [k, v] of Object.entries(env))
        if (!k.startsWith('GIT_'))
            out[k] = v;
    return out;
}
async function git(run, repo, args, timeoutMs = 120000) {
    const r = await run('git', ['-C', repo, ...args], { timeoutMs, env: gitEnv() });
    if (!r.ok)
        throw new GitError(`git ${args[0]}: ${(r.stderr || r.error || '').trim().split('\n').pop() ?? ''}`);
    return r.stdout.trim();
}
/** Turns a branch, tag or short sha into a full commit sha. */
export async function resolveRef(run, repo, ref) {
    if (ref.startsWith('-'))
        throw new GitError(`bad ref: ${ref}`);
    const sha = await git(run, repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!SHA.test(sha))
        throw new GitError(`unknown ref: ${ref}`);
    return sha;
}
/** A folder path inside the repository, normalised; refuses anything that climbs out of it. */
export function cleanSubdir(dir) {
    const parts = dir.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
    if (parts.some((p) => p === '..'))
        throw new GitError(`app folder must stay inside the repository: ${dir}`);
    return parts.join('/');
}
/**
 * Writes the tree of `sha` (only `subdir` when given) into `dest`, which is created fresh.
 * `git archive <sha>:<subdir>` puts the folder's contents at the top of the archive.
 */
export async function exportTree(run, repo, sha, subdir, dest) {
    if (!SHA.test(sha))
        throw new GitError(`not a commit sha: ${sha}`);
    const sub = cleanSubdir(subdir);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const tar = `${dest}.tar`;
    try {
        await git(run, repo, ['archive', '--format=tar', '-o', tar, sub ? `${sha}:${sub}` : sha]);
        const r = await run('tar', ['-xf', tar, '-C', dest], { timeoutMs: 120000 });
        if (!r.ok)
            throw new GitError(`tar: ${r.stderr.trim()}`);
    }
    finally {
        rmSync(tar, { force: true });
    }
}
/** Clones without checking out, for repositories that are not on disk yet (pull requests, census). */
export async function cloneNoCheckout(run, url, dest) {
    if (url.startsWith('-'))
        throw new GitError(`bad url: ${url}`);
    const r = await run('git', ['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--', url, dest], {
        timeoutMs: 600000,
        env: gitEnv(),
    });
    if (!r.ok)
        throw new GitError(`git clone: ${r.stderr.trim().split('\n').pop() ?? ''}`);
}
/** Fetches one refspec (for example `refs/pull/12/head`) and returns the commit it points to. */
export async function fetchRef(run, repo, refspec) {
    if (refspec.startsWith('-'))
        throw new GitError(`bad refspec: ${refspec}`);
    await git(run, repo, ['fetch', '--quiet', 'origin', refspec], 600000);
    return resolveRef(run, repo, 'FETCH_HEAD');
}
/** Short form for display and run ids. */
export function shortSha(sha) {
    return sha.slice(0, 7);
}
export function sideDir(workDir, side) {
    return join(workDir, side);
}

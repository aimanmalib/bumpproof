// Census, part 1: find candidate pull requests and apply the fixed selection rules (PRD §5.9, D13).
// Read-only GitHub calls through `gh`: search is paced (one request every `search_gap_ms`), capped at
// `max_searches`, and stops on a rate limit. Every repository found is listed in census/candidates.json,
// including the ones left out and why, so nothing is dropped silently.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseTitle } from "./bump.js";
import { scanText } from "./evidence.js";
import { changedAppDirs, ciState, lockfileIn, manifestFacts, manifestReasons, parseJsonObject, pickAppDir, repoReasons, secretKeys, watchedBumps, } from "./census-rules.js";
export const CANDIDATES_SCHEMA = 1;
class Timebox extends Error {
}
/** Paced `gh api` calls. Search and plain API calls keep separate clocks. */
export class Gh {
    last = { search: -Infinity, core: -Infinity };
    started;
    d;
    c;
    constructor(d, c) {
        this.d = d;
        this.c = c;
        this.started = d.now();
    }
    timeLeft() {
        return this.d.now() - this.started < this.c.timebox_min * 60_000;
    }
    async call(args, kind) {
        if (!this.timeLeft())
            throw new Timebox();
        const gap = kind === 'search' ? this.c.search_gap_ms : this.c.request_gap_ms;
        const wait = this.last[kind] + gap - this.d.now();
        if (wait > 0)
            await this.d.sleep(wait);
        this.last[kind] = this.d.now();
        const r = await this.d.run(this.d.cfg.github.command, ['api', ...args], { timeoutMs: 30_000 });
        const status = r.ok ? 200 : Number(/HTTP (\d{3})/.exec(r.stderr)?.[1] ?? 0);
        return { ok: r.ok, status, text: r.ok ? r.stdout : r.stderr };
    }
    async json(path) {
        const r = await this.call([path], 'core');
        if (!r.ok)
            return r.status === 404 ? null : Promise.reject(new ApiError(r.status));
        return JSON.parse(r.text);
    }
    async raw(path) {
        const r = await this.call(['-H', 'Accept: application/vnd.github.raw+json', path], 'core');
        if (!r.ok)
            return r.status === 404 ? null : Promise.reject(new ApiError(r.status));
        return r.text;
    }
}
export class ApiError extends Error {
    status;
    constructor(status) {
        super(`GitHub API HTTP ${status || 'error'}`);
        this.status = status;
    }
}
const isRateLimit = (r) => (r.status === 403 || r.status === 429) && /rate limit|abuse/i.test(r.text);
export function searchQuery(c, bot, pkg) {
    return `is:pr is:open author:${bot.author} created:>=${c.created_since} "${bot.title.replaceAll('{pkg}', pkg)}" in:title`;
}
export function hitsFrom(json, bot) {
    const items = json?.items;
    if (!Array.isArray(items))
        return [];
    const out = [];
    for (const it of items) {
        const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(String(it.repository_url ?? ''))?.[1];
        if (!repo || typeof it.number !== 'number')
            continue;
        out.push({ repo, number: it.number, title: String(it.title ?? ''), url: String(it.html_url ?? ''),
            created_at: String(it.created_at ?? ''), bot });
    }
    return out;
}
/** Newest pull request first, one per repository (the first seen wins ties), ignoring our own repository. */
export function dedupe(hits, ownRepo) {
    const sorted = [...hits].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.repo.localeCompare(b.repo) || a.number - b.number);
    const seen = new Set();
    return sorted.filter((h) => {
        const k = h.repo.toLowerCase();
        if (seen.has(k) || k === ownRepo?.toLowerCase())
            return false;
        seen.add(k);
        return true;
    });
}
export async function search(gh, d, c) {
    const hits = [];
    const log = [];
    for (const pkg of c.watchlist) {
        for (const bot of c.bots) {
            if (log.length >= c.max_searches)
                return { hits, log, stopped: 'max_searches' };
            const query = searchQuery(c, bot, pkg);
            const args = ['-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', `per_page=${c.per_page}`, '-f', 'sort=created', '-f', 'order=desc'];
            let r;
            try {
                r = await gh.call(args, 'search');
                if (isRateLimit(r)) {
                    d.progress?.('census.progress_wait', { s: c.rate_limit_wait_s });
                    await d.sleep(c.rate_limit_wait_s * 1000);
                    r = await gh.call(args, 'search');
                }
            }
            catch (e) {
                if (e instanceof Timebox)
                    return { hits, log, stopped: 'timebox' };
                throw e;
            }
            if (isRateLimit(r)) {
                log.push({ bot: bot.name, package: pkg, query, status: 'rate_limited' });
                return { hits, log, stopped: 'rate_limit' };
            }
            if (!r.ok) {
                log.push({ bot: bot.name, package: pkg, query, status: 'error' });
                continue;
            }
            const json = JSON.parse(r.text);
            const found = hitsFrom(json, bot.name);
            hits.push(...found);
            log.push({ bot: bot.name, package: pkg, query, status: 'ok', total: json.total_count ?? found.length, returned: found.length });
            d.progress?.('census.progress_search', { bot: bot.name, pkg, n: found.length });
        }
    }
    return { hits, log, stopped: null };
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const contents = (repo, path, sha) => `repos/${repo}/contents${path ? `/${enc(path)}` : ''}?ref=${sha}`;
const join2 = (dir, name) => (dir ? `${dir}/${name}` : name);
/** Applies the rules stage by stage; the first stage that finds reasons ends the evaluation (fewer API calls). */
export async function evaluate(gh, cfg, c, hit) {
    const cand = { repo: hit.repo, url: `https://github.com/${hit.repo}`, status: 'excluded', reasons: [], pr: { ...hit } };
    const stop = (reasons) => ({ ...cand, reasons });
    const repo = (await gh.json(`repos/${hit.repo}`));
    if (!repo)
        return stop([{ code: 'not_found' }]);
    const license = (repo.license?.spdx_id ?? null) || null;
    Object.assign(cand, { license, stars: Number(repo.stargazers_count ?? 0), size_kb: Number(repo.size ?? 0) });
    let reasons = repoReasons({ license, archived: repo.archived === true, size_kb: cand.size_kb }, c);
    if (reasons.length)
        return stop(reasons);
    const pull = (await gh.json(`repos/${hit.repo}/pulls/${hit.number}`));
    if (!pull || pull.state !== 'open')
        return stop([{ code: 'pr_closed' }]);
    const base = pull.base.sha;
    const head = pull.head.sha;
    Object.assign(cand.pr, { base_sha: base, head_sha: head });
    const files = (await gh.json(`repos/${hit.repo}/pulls/${hit.number}/files?per_page=100`)) ?? [];
    const lockNames = Object.keys(cfg.sandbox.lockfiles);
    const dir = pickAppDir(changedAppDirs(files.map((f) => f.filename), lockNames), parseTitle(hit.title).dir);
    cand.dir = dir;
    if (dir === null)
        return stop([{ code: 'no_manifest_change' }]);
    const pkgPath = join2(dir, 'package.json');
    const basePkg = parseJsonObject((await gh.raw(contents(hit.repo, pkgPath, base))) ?? '');
    const headPkg = parseJsonObject((await gh.raw(contents(hit.repo, pkgPath, head))) ?? '');
    if (!basePkg || !headPkg)
        return stop([{ code: 'no_package_json', detail: pkgPath }]);
    const bumps = watchedBumps(hit.title, basePkg, headPkg, cfg.bump.dep_fields, c);
    Object.assign(cand, { bump_source: bumps.source, watched: bumps.watched, other_bumps: bumps.all.length - bumps.watched.length });
    if (bumps.watched.length === 0)
        return stop([{ code: 'no_watched_bump' }]);
    const rootPkg = dir ? parseJsonObject((await gh.raw(contents(hit.repo, 'package.json', base))) ?? '') : null;
    cand.manifest = manifestFacts(basePkg, rootPkg, cfg.sandbox.build_script, cfg.sandbox.serve_scripts, c, cfg.bump.dep_fields);
    reasons = manifestReasons(cand.manifest);
    if (reasons.length)
        return stop(reasons);
    const names = async (d) => {
        const list = await gh.json(contents(hit.repo, d, base));
        return Array.isArray(list) ? list.map((e) => String(e.name ?? '')) : [];
    };
    const appNames = await names(dir);
    cand.lockfile = lockfileIn(appNames, lockNames);
    if (c.require_lockfile && !cand.lockfile)
        reasons.push({ code: 'no_lockfile' });
    const envKeys = [];
    for (const [d, list] of dir ? [[dir, appNames], ['', await names('')]] : [['', appNames]]) {
        for (const f of c.env_files.filter((e) => list.includes(e))) {
            envKeys.push(...secretKeys((await gh.raw(contents(hit.repo, join2(d, f), base))) ?? '', c.env_key_pattern));
        }
    }
    cand.env_secret_keys = [...new Set(envKeys)];
    if (cand.env_secret_keys.length)
        reasons.push({ code: 'needs_secrets', detail: cand.env_secret_keys.join(', ') });
    if (reasons.length)
        return stop(reasons);
    const r = await gh.call(['graphql', '-f', `query=${rollupQuery(hit)}`], 'core');
    cand.pr.ci = r.ok ? ciState(rollupNodes(r.text)) : 'none';
    return { ...cand, status: 'eligible', reasons: [] };
}
/** Same data as `gh pr view --json statusCheckRollup`, through `gh api` so all calls share one pacer. */
export function rollupQuery(hit) {
    const [owner, name] = hit.repo.split('/');
    return `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${hit.number}){` +
        'commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{' +
        '... on CheckRun{conclusion status} ... on StatusContext{state}}}}}}}}}}';
}
export function rollupNodes(text) {
    try {
        const j = JSON.parse(text);
        return j?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    }
    catch {
        return [];
    }
}
export function ownRepoOf(url) {
    return /github\.com\/([^/]+\/[^/#?]+)/.exec(url)?.[1]?.replace(/\.git$/, '') ?? null;
}
export async function findCandidates(d) {
    const c = d.cfg.census;
    const gh = new Gh(d, c);
    const s = await search(gh, d, c);
    let stopped = s.stopped;
    const unique = dedupe(s.hits, ownRepoOf(d.cfg.report.repo_url));
    const candidates = [];
    // Repositories never reached are counted by why, not listed: nothing about them was looked at.
    const notChecked = {};
    let rest = null;
    const eligible = () => candidates.filter((x) => x.status === 'eligible').length;
    for (const [i, hit] of unique.entries()) {
        if (!rest)
            rest = eligible() >= c.target_eligible ? 'enough' : i >= c.max_evaluate ? 'limit' : gh.timeLeft() ? null : 'timebox';
        if (!rest) {
            try {
                candidates.push(await evaluate(gh, d.cfg, c, hit));
                d.progress?.(`census.progress_${candidates.at(-1).status}`, { repo: hit.repo });
                continue;
            }
            catch (e) {
                if (e instanceof ApiError || e instanceof SyntaxError) {
                    candidates.push({ repo: hit.repo, url: `https://github.com/${hit.repo}`, status: 'excluded', reasons: [{ code: 'api_error' }], pr: { ...hit } });
                    continue;
                }
                if (!(e instanceof Timebox))
                    throw e;
                rest = 'timebox';
            }
        }
        notChecked[rest] = (notChecked[rest] ?? 0) + 1;
    }
    if (rest === 'timebox')
        stopped = 'timebox';
    const count = (st) => candidates.filter((x) => x.status === st).length;
    const { bots, watchlist, created_since, max_searches, search_gap_ms, per_page, max_evaluate, target_eligible, timebox_min, ...filters } = c;
    return {
        schema_version: CANDIDATES_SCHEMA,
        generated_at: new Date(d.now()).toISOString(),
        rules: { bots: bots.map((b) => `${b.author} "${b.title}"`), watchlist, created_since, max_searches, search_gap_ms, per_page, max_evaluate,
            target_eligible, timebox_min,
            ...filters, build_script: d.cfg.sandbox.build_script, serve_scripts: d.cfg.sandbox.serve_scripts },
        order: 'newest_pr_first',
        stopped,
        searches: s.log,
        counts: { found: unique.length, evaluated: candidates.length, eligible: count('eligible'), excluded: count('excluded'),
            not_evaluated: Object.values(notChecked).reduce((a, b) => a + b, 0) },
        not_checked: notChecked,
        candidates,
    };
}
/** Writes the file only when the publication scan finds nothing (census/ is published). */
export function writeCandidates(path, file, cfg, secrets) {
    const text = `${JSON.stringify(file, null, 2)}\n`;
    const findings = scanText(path, text, cfg.publish, secrets);
    if (findings.length === 0) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    }
    return findings;
}
/** `bumpproof census --find [--out <file>]`. Running the census itself comes with the Kane steps. */
export async function runCensusFind(d, t, out, secrets, io) {
    io.out(t('census.finding', { searches: d.cfg.census.watchlist.length * d.cfg.census.bots.length, gap: d.cfg.census.search_gap_ms / 1000 }));
    const file = await findCandidates(d);
    const findings = writeCandidates(out, file, d.cfg, secrets);
    if (findings.length > 0) {
        io.err(t('report.scan_failed', { count: findings.length }));
        for (const f of findings)
            io.err(`  ${f.file}:${f.line} ${f.kind} ${f.match}`);
        return 1;
    }
    io.out(t('census.found', { ...file.counts, searches: file.searches.length }));
    if (file.stopped)
        io.out(t(`census.stopped_${file.stopped}`));
    const tally = new Map();
    for (const c of file.candidates)
        for (const r of c.reasons)
            tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
    for (const [code, n] of Object.entries(file.not_checked))
        tally.set(code, (tally.get(code) ?? 0) + n);
    for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1]))
        io.out(`  ${String(n).padStart(3)}  ${t(`census.reason_${code}`)}`);
    io.out(t('census.written', { path: out }));
    return 0;
}

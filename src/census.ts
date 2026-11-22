// Census, part 1: find candidate pull requests and apply the fixed selection rules (PRD §5.9, D13).
// Read-only GitHub calls through `gh`: search is paced (one request every `search_gap_ms`), capped at
// `max_searches`, and stops on a rate limit. Every repository found is listed in census/candidates.json,
// including the ones left out and why, so nothing is dropped silently.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseTitle, type Bump } from './bump.ts';
import type { Config, JsonObject } from './config.ts';
import { scanText, type Finding } from './evidence.ts';
import type { Runner } from './proc.ts';
import {
  changedAppDirs, ciState, lockfileIn, manifestFacts, manifestReasons, parseJsonObject, pickAppDir, repoReasons,
  secretKeys, watchedBumps, type CensusRules, type CiState, type ManifestFacts, type Reason,
} from './census-rules.ts';

export const CANDIDATES_SCHEMA = 1;

export interface CensusConfig extends CensusRules {
  created_since: string;
  /** `title` is a phrase searched in the title; `{pkg}` is replaced by the package name. */
  bots: { name: string; author: string; title: string }[];
  max_searches: number;
  search_gap_ms: number;
  request_gap_ms: number;
  per_page: number;
  rate_limit_wait_s: number;
  max_evaluate: number;
  /** Checking stops once this many repositories pass; the rest are listed as not checked (`enough`). */
  target_eligible: number;
  timebox_min: number;
  candidates_path: string;
  /** `census --run`: repositories per call, wall-clock budget over all runs, journey folders, run records. */
  run_limit: number;
  run_timebox_min: number;
  generic_journeys_dir: string;
  specific_journeys_dir: string;
  runs_dir: string;
}

export interface Hit { repo: string; number: number; title: string; url: string; created_at: string; bot: string }

export interface Candidate {
  repo: string;
  url: string;
  status: 'eligible' | 'excluded';
  reasons: Reason[];
  pr: Hit & { base_sha?: string; head_sha?: string; ci?: CiState };
  license?: string | null;
  stars?: number;
  size_kb?: number;
  dir?: string | null;
  bump_source?: string;
  watched?: Bump[];
  other_bumps?: number;
  manifest?: ManifestFacts;
  lockfile?: string | null;
  env_secret_keys?: string[];
}

export interface SearchLog { bot: string; package: string; query: string; status: 'ok' | 'rate_limited' | 'error'; total?: number; returned?: number }

export interface CandidatesFile {
  schema_version: number;
  generated_at: string;
  rules: JsonObject;
  order: string;
  stopped: null | 'rate_limit' | 'timebox' | 'max_searches';
  searches: SearchLog[];
  counts: { found: number; evaluated: number; eligible: number; excluded: number; not_evaluated: number };
  /** Repositories found but never checked, by reason (`enough`, `limit`, `timebox`). */
  not_checked: Record<string, number>;
  /** Every repository checked, in search order, with the reasons when it is left out. */
  candidates: Candidate[];
}

export interface FindDeps {
  cfg: Config;
  run: Runner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Locale key and values for a progress line (stderr). */
  progress?: (key: string, vars: Record<string, string | number>) => void;
}

class Timebox extends Error {}

interface ApiResult { ok: boolean; status: number; text: string }

/** Paced `gh api` calls. Search and plain API calls keep separate clocks. */
export class Gh {
  private last = { search: -Infinity, core: -Infinity };
  readonly started: number;
  private d: FindDeps;
  private c: CensusConfig;
  constructor(d: FindDeps, c: CensusConfig) {
    this.d = d;
    this.c = c;
    this.started = d.now();
  }
  timeLeft(): boolean {
    return this.d.now() - this.started < this.c.timebox_min * 60_000;
  }
  async call(args: string[], kind: 'search' | 'core'): Promise<ApiResult> {
    if (!this.timeLeft()) throw new Timebox();
    const gap = kind === 'search' ? this.c.search_gap_ms : this.c.request_gap_ms;
    const wait = this.last[kind] + gap - this.d.now();
    if (wait > 0) await this.d.sleep(wait);
    this.last[kind] = this.d.now();
    const r = await this.d.run(this.d.cfg.github.command, ['api', ...args], { timeoutMs: 30_000 });
    const status = r.ok ? 200 : Number(/HTTP (\d{3})/.exec(r.stderr)?.[1] ?? 0);
    return { ok: r.ok, status, text: r.ok ? r.stdout : r.stderr };
  }
  async json(path: string): Promise<unknown> {
    const r = await this.call([path], 'core');
    if (!r.ok) return r.status === 404 ? null : Promise.reject(new ApiError(r.status));
    return JSON.parse(r.text) as unknown;
  }
  async raw(path: string): Promise<string | null> {
    const r = await this.call(['-H', 'Accept: application/vnd.github.raw+json', path], 'core');
    if (!r.ok) return r.status === 404 ? null : Promise.reject(new ApiError(r.status));
    return r.text;
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub API HTTP ${status || 'error'}`);
    this.status = status;
  }
}

const isRateLimit = (r: ApiResult): boolean => (r.status === 403 || r.status === 429) && /rate limit|abuse/i.test(r.text);

export function searchQuery(c: CensusConfig, bot: { author: string; title: string }, pkg: string): string {
  return `is:pr is:open author:${bot.author} created:>=${c.created_since} "${bot.title.replaceAll('{pkg}', pkg)}" in:title`;
}

export function hitsFrom(json: unknown, bot: string): Hit[] {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: Hit[] = [];
  for (const it of items as Record<string, unknown>[]) {
    const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(String(it.repository_url ?? ''))?.[1];
    if (!repo || typeof it.number !== 'number') continue;
    out.push({ repo, number: it.number, title: String(it.title ?? ''), url: String(it.html_url ?? ''),
      created_at: String(it.created_at ?? ''), bot });
  }
  return out;
}

/** Newest pull request first, one per repository (the first seen wins ties), ignoring our own repository. */
export function dedupe(hits: Hit[], ownRepo: string | null): Hit[] {
  const sorted = [...hits].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.repo.localeCompare(b.repo) || a.number - b.number);
  const seen = new Set<string>();
  return sorted.filter((h) => {
    const k = h.repo.toLowerCase();
    if (seen.has(k) || k === ownRepo?.toLowerCase()) return false;
    seen.add(k);
    return true;
  });
}

export async function search(gh: Gh, d: FindDeps, c: CensusConfig): Promise<{ hits: Hit[]; log: SearchLog[]; stopped: CandidatesFile['stopped'] }> {
  const hits: Hit[] = [];
  const log: SearchLog[] = [];
  for (const pkg of c.watchlist) {
    for (const bot of c.bots) {
      if (log.length >= c.max_searches) return { hits, log, stopped: 'max_searches' };
      const query = searchQuery(c, bot, pkg);
      const args = ['-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', `per_page=${c.per_page}`, '-f', 'sort=created', '-f', 'order=desc'];
      let r: ApiResult;
      try {
        r = await gh.call(args, 'search');
        if (isRateLimit(r)) {
          d.progress?.('census.progress_wait', { s: c.rate_limit_wait_s });
          await d.sleep(c.rate_limit_wait_s * 1000);
          r = await gh.call(args, 'search');
        }
      } catch (e) {
        if (e instanceof Timebox) return { hits, log, stopped: 'timebox' };
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
      const json = JSON.parse(r.text) as { total_count?: number };
      const found = hitsFrom(json, bot.name);
      hits.push(...found);
      log.push({ bot: bot.name, package: pkg, query, status: 'ok', total: json.total_count ?? found.length, returned: found.length });
      d.progress?.('census.progress_search', { bot: bot.name, pkg, n: found.length });
    }
  }
  return { hits, log, stopped: null };
}

const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
const contents = (repo: string, path: string, sha: string): string =>
  `repos/${repo}/contents${path ? `/${enc(path)}` : ''}?ref=${sha}`;
const join2 = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Applies the rules stage by stage; the first stage that finds reasons ends the evaluation (fewer API calls). */
export async function evaluate(gh: Gh, cfg: Config, c: CensusConfig, hit: Hit): Promise<Candidate> {
  const cand: Candidate = { repo: hit.repo, url: `https://github.com/${hit.repo}`, status: 'excluded', reasons: [], pr: { ...hit } };
  const stop = (reasons: Reason[]): Candidate => ({ ...cand, reasons });
  const repo = (await gh.json(`repos/${hit.repo}`)) as Record<string, unknown> | null;
  if (!repo) return stop([{ code: 'not_found' }]);
  const license = ((repo.license as { spdx_id?: string } | null)?.spdx_id ?? null) || null;
  Object.assign(cand, { license, stars: Number(repo.stargazers_count ?? 0), size_kb: Number(repo.size ?? 0) });
  let reasons = repoReasons({ license, archived: repo.archived === true, size_kb: cand.size_kb! }, c);
  if (reasons.length) return stop(reasons);

  const pull = (await gh.json(`repos/${hit.repo}/pulls/${hit.number}`)) as Record<string, any> | null;
  if (!pull || pull.state !== 'open') return stop([{ code: 'pr_closed' }]);
  const base: string = pull.base.sha;
  const head: string = pull.head.sha;
  Object.assign(cand.pr, { base_sha: base, head_sha: head });
  const files = ((await gh.json(`repos/${hit.repo}/pulls/${hit.number}/files?per_page=100`)) as { filename: string }[] | null) ?? [];
  const lockNames = Object.keys(cfg.sandbox.lockfiles);
  const dir = pickAppDir(changedAppDirs(files.map((f) => f.filename), lockNames), parseTitle(hit.title).dir);
  cand.dir = dir;
  if (dir === null) return stop([{ code: 'no_manifest_change' }]);

  const pkgPath = join2(dir, 'package.json');
  const basePkg = parseJsonObject((await gh.raw(contents(hit.repo, pkgPath, base))) ?? '');
  const headPkg = parseJsonObject((await gh.raw(contents(hit.repo, pkgPath, head))) ?? '');
  if (!basePkg || !headPkg) return stop([{ code: 'no_package_json', detail: pkgPath }]);
  const bumps = watchedBumps(hit.title, basePkg, headPkg, cfg.bump.dep_fields, c);
  Object.assign(cand, { bump_source: bumps.source, watched: bumps.watched, other_bumps: bumps.all.length - bumps.watched.length });
  if (bumps.watched.length === 0) return stop([{ code: 'no_watched_bump' }]);

  const rootPkg = dir ? parseJsonObject((await gh.raw(contents(hit.repo, 'package.json', base))) ?? '') : null;
  cand.manifest = manifestFacts(basePkg, rootPkg, cfg.sandbox.build_script, cfg.sandbox.serve_scripts, c, cfg.bump.dep_fields);
  reasons = manifestReasons(cand.manifest);
  if (reasons.length) return stop(reasons);

  const names = async (d: string): Promise<string[]> => {
    const list = await gh.json(contents(hit.repo, d, base));
    return Array.isArray(list) ? list.map((e) => String((e as { name?: string }).name ?? '')) : [];
  };
  const appNames = await names(dir);
  cand.lockfile = lockfileIn(appNames, lockNames);
  if (c.require_lockfile && !cand.lockfile) reasons.push({ code: 'no_lockfile' });
  const envKeys: string[] = [];
  for (const [d, list] of dir ? [[dir, appNames], ['', await names('')]] as const : [['', appNames]] as const) {
    for (const f of c.env_files.filter((e) => list.includes(e))) {
      envKeys.push(...secretKeys((await gh.raw(contents(hit.repo, join2(d, f), base))) ?? '', c.env_key_pattern));
    }
  }
  cand.env_secret_keys = [...new Set(envKeys)];
  if (cand.env_secret_keys.length) reasons.push({ code: 'needs_secrets', detail: cand.env_secret_keys.join(', ') });
  if (reasons.length) return stop(reasons);

  const r = await gh.call(['graphql', '-f', `query=${rollupQuery(hit)}`], 'core');
  cand.pr.ci = r.ok ? ciState(rollupNodes(r.text)) : 'none';
  return { ...cand, status: 'eligible', reasons: [] };
}

/** Same data as `gh pr view --json statusCheckRollup`, through `gh api` so all calls share one pacer. */
export function rollupQuery(hit: Hit): string {
  const [owner, name] = hit.repo.split('/');
  return `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${hit.number}){` +
    'commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{' +
    '... on CheckRun{conclusion status} ... on StatusContext{state}}}}}}}}}}';
}

export function rollupNodes(text: string): unknown[] {
  try {
    const j = JSON.parse(text) as any;
    return j?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  } catch {
    return [];
  }
}

export function ownRepoOf(url: string): string | null {
  return /github\.com\/([^/]+\/[^/#?]+)/.exec(url)?.[1]?.replace(/\.git$/, '') ?? null;
}

export async function findCandidates(d: FindDeps): Promise<CandidatesFile> {
  const c = d.cfg.census;
  const gh = new Gh(d, c);
  const s = await search(gh, d, c);
  let stopped = s.stopped;
  const unique = dedupe(s.hits, ownRepoOf(d.cfg.report.repo_url));
  const candidates: Candidate[] = [];
  // Repositories never reached are counted by why, not listed: nothing about them was looked at.
  const notChecked: Record<string, number> = {};
  let rest: string | null = null;
  const eligible = (): number => candidates.filter((x) => x.status === 'eligible').length;
  for (const [i, hit] of unique.entries()) {
    if (!rest) rest = eligible() >= c.target_eligible ? 'enough' : i >= c.max_evaluate ? 'limit' : gh.timeLeft() ? null : 'timebox';
    if (!rest) {
      try {
        candidates.push(await evaluate(gh, d.cfg, c, hit));
        d.progress?.(`census.progress_${candidates.at(-1)!.status}`, { repo: hit.repo });
        continue;
      } catch (e) {
        if (e instanceof ApiError || e instanceof SyntaxError) {
          candidates.push({ repo: hit.repo, url: `https://github.com/${hit.repo}`, status: 'excluded', reasons: [{ code: 'api_error' }], pr: { ...hit } });
          continue;
        }
        if (!(e instanceof Timebox)) throw e;
        rest = 'timebox';
      }
    }
    notChecked[rest] = (notChecked[rest] ?? 0) + 1;
  }
  if (rest === 'timebox') stopped = 'timebox';
  const count = (st: Candidate['status']): number => candidates.filter((x) => x.status === st).length;
  const { bots, watchlist, created_since, max_searches, search_gap_ms, per_page, max_evaluate, target_eligible, timebox_min, ...filters } = c;
  return {
    schema_version: CANDIDATES_SCHEMA,
    generated_at: new Date(d.now()).toISOString(),
    rules: { bots: bots.map((b) => `${b.author} "${b.title}"`), watchlist, created_since, max_searches, search_gap_ms, per_page, max_evaluate,
      target_eligible, timebox_min,
      ...filters, build_script: d.cfg.sandbox.build_script, serve_scripts: d.cfg.sandbox.serve_scripts } as unknown as JsonObject,
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
export function writeCandidates(path: string, file: CandidatesFile, cfg: Config, secrets: string[]): Finding[] {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const findings = scanText(path, text, cfg.publish, secrets);
  if (findings.length === 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return findings;
}

/** `bumpproof census --find [--out <file>]`. Running the census itself comes with the Kane steps. */
export async function runCensusFind(d: FindDeps, t: (k: string, v?: Record<string, string | number>) => string,
  out: string, secrets: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  io.out(t('census.finding', { searches: d.cfg.census.watchlist.length * d.cfg.census.bots.length, gap: d.cfg.census.search_gap_ms / 1000 }));
  const file = await findCandidates(d);
  const findings = writeCandidates(out, file, d.cfg, secrets);
  if (findings.length > 0) {
    io.err(t('report.scan_failed', { count: findings.length }));
    for (const f of findings) io.err(`  ${f.file}:${f.line} ${f.kind} ${f.match}`);
    return 1;
  }
  io.out(t('census.found', { ...file.counts, searches: file.searches.length }));
  if (file.stopped) io.out(t(`census.stopped_${file.stopped}`));
  const tally = new Map<string, number>();
  for (const c of file.candidates) for (const r of c.reasons) tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
  for (const [code, n] of Object.entries(file.not_checked)) tally.set(code, (tally.get(code) ?? 0) + n);
  for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1])) io.out(`  ${String(n).padStart(3)}  ${t(`census.reason_${code}`)}`);
  io.out(t('census.written', { path: out }));
  return 0;
}

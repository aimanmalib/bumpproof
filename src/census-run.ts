// `bumpproof census --run`: runs eligible third-party pull requests from census/candidates.json, read only (PRD §5.9).
// Per repository: clone, merge the PR locally, add our journeys to a LOCAL commit on the base (two generic ones from
// config, plus one written for that app when census/journeys/<owner>__<repo>/ has it), author them once on the base,
// commit the recordings locally, then check base against the merged head with the fixer. Nothing is pushed anywhere:
// the fix patch stays in census/runs/<id>/. The replay on the base is the control (base against base, H4).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runJourneyCommand, writeRunJson } from './check-cli.ts';
import type { JourneyCheckDeps } from './check-journeys.ts';
import { makeWorkDir, newRunId } from './check.ts';
import type { Candidate, CandidatesFile } from './census.ts';
import {
  applyRun, readResults, round3, rowFor, upsertRow, nextCandidates, type CensusRow, type JourneyKind,
} from './census-results.ts';
import { ROOT, expandHome, type Config } from './config.ts';
import { scrubText, secretsFromEnv } from './evidence.ts';
import { cleanSubdir, cloneNoCheckout, exportTree, GitError, gitEnv } from './git.ts';
import type { Translate } from './i18n.ts';
import { BudgetError, copyJourneys, findJourneys, journeysDir, runSide, type KaneDeps } from './journeys.ts';
import type { Fetcher } from './notes.ts';
import { fetchPrInfo, git, MERGE_IDENTITY, mergeLocally, mergeOnto, parsePrRef, PrError } from './pr.ts';
import { journeyRun } from './run-record.ts';
import { removeLabelled, SandboxError, startApp, stopApp } from './sandbox.ts';
import type { Paint } from './ui.ts';

export interface CensusRunDeps extends JourneyCheckDeps {
  fetch: Fetcher;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface CensusJourneyFile { file: string; content: string; kind: JourneyKind }

/** `owner/repo` → `owner__repo`, the folder name for that app's own journeys. */
export const specificFolder = (repo: string) => repo.replace('/', '__');

/** The app's start path (`app.json` `{"path": "/sub/"}` in its journeys folder, for apps served under a base path). */
export function appPath(dir: string): string {
  const f = join(dir, 'app.json');
  if (!existsSync(f)) return '/';
  const v = (JSON.parse(readFileSync(f, 'utf8')) as { path?: unknown }).path;
  return typeof v === 'string' && /^\/[A-Za-z0-9._~\/-]*$/.test(v) ? v : '/';
}

/** Generic journeys (config; `{port}` and `{path}` filled in) and the app's own journeys when present. Same name: the app's wins. */
export function censusJourneys(cfg: Config, cwd: string, repo: string): CensusJourneyFile[] {
  const suffix = cfg.kane.journey_suffix;
  const ownDir = repo ? resolve(cwd, cfg.census.specific_journeys_dir, specificFolder(repo)) : '';
  const path = ownDir ? appPath(ownDir) : '/';
  const read = (dir: string, kind: JourneyKind) => (dir && existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(suffix) && f.length > suffix.length).sort()
    .map((f) => ({ file: f, kind, content: readFileSync(join(dir, f), 'utf8').replaceAll('{port}', String(cfg.port)).replaceAll('{path}', path) }));
  const generic = read(resolve(ROOT, cfg.census.generic_journeys_dir), 'generic');
  const own = read(ownDir, 'specific');
  return [...generic.filter((g) => !own.some((o) => o.file === g.file)), ...own];
}

/** Repository path of the journeys folder for an app folder (posix, inside the clone). */
export function journeysPath(cfg: Config, dir: string): string {
  const j = cleanSubdir(expandHome(cfg.kane.journeys_dir));
  return dir ? `${cleanSubdir(dir)}/${j}` : j;
}

/** A LOCAL commit on `parent` that writes `files` (name → text) or copies `fromDir` into `path`. Never pushed. */
export async function commitInto(d: Pick<CensusRunDeps, 'run'>, clone: string, parent: string, path: string,
  src: { files?: CensusJourneyFile[]; fromDir?: string }, message: string): Promise<string> {
  const work = `${clone}-wt-${parent.slice(0, 8)}-${Date.now()}`;
  await git(d.run, clone, ['worktree', 'add', '--quiet', '--detach', work, parent]);
  try {
    const target = join(work, path);
    mkdirSync(target, { recursive: true });
    for (const f of src.files ?? []) writeFileSync(join(target, f.file), f.content);
    if (src.fromDir) copyJourneys(src.fromDir, target);
    await git(d.run, work, ['add', '--force', '--all', '--', path]);
    await git(d.run, work, [...MERGE_IDENTITY, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', message]);
    return await git(d.run, work, ['rev-parse', 'HEAD']);
  } finally {
    await d.run('git', ['-C', clone, 'worktree', 'remove', '--force', work], { timeoutMs: 60000, env: gitEnv() });
  }
}

interface Authored { built: boolean; detail: string | null; runs: Map<string, ReturnType<typeof journeyRun>>; credits: number; folder: string }

/** Serves the base once and lets Kane CLI author every journey; the recordings are left in `folder`. */
async function authorOnBase(d: CensusRunDeps, clone: string, sha: string, dir: string, runId: string, scratch: string): Promise<Authored> {
  const appDir = join(scratch, 'author-app');
  const folder = join(scratch, 'author-journeys');
  await exportTree(d.run, clone, sha, dir, appDir);
  await removeLabelled(d.run, d.cfg);
  const name = `${d.cfg.sandbox.container_prefix}-${runId}-author`;
  const out: Authored = { built: false, detail: null, runs: new Map(), credits: 0, folder };
  try {
    const res = await startApp(d, { name, runId, side: 'base', appDir });
    if (!res.built) {
      out.detail = `${res.failed_at ?? 'start'}: ${res.log_tail.slice(-6).join('\n')}`;
      return out;
    }
    out.built = true;
    copyJourneys(journeysDir(appDir, d.cfg), folder);
    const journeys = findJourneys(folder, d.cfg.kane.journey_suffix);
    const kd: KaneDeps = { run: d.run, cfg: d.cfg, env: d.env, now: d.now, ledgerRoot: d.ledgerRoot, census: true };
    const secrets = secretsFromEnv(d.env, d.cfg.publish.secret_env);
    const runs = await runSide(kd, folder, journeys, 'base', `${runId}-author`, undefined,
      (n, a) => d.out(`  author ${n}: ${a.kane.status} (${a.kane.duration_s ?? a.seconds} s, ${a.credits} credits)`));
    for (const j of journeys) {
      const attempts = runs.get(j.name);
      out.runs.set(j.name, journeyRun(attempts, d.cfg.publish, secrets));
      out.credits += (attempts ?? []).reduce((s, a) => s + a.credits, 0);
    }
    return out;
  } finally {
    await stopApp(d.run, name);
    rmSync(appDir, { recursive: true, force: true });
  }
}

/** Runs one candidate end to end and returns its row. Budget and disk refusals are thrown to stop the census. */
export async function runCandidate(d: CensusRunDeps, c: Candidate, t: Translate, p: Paint): Promise<CensusRow> {
  const started = d.now();
  const row = rowFor(c, new Date(started).toISOString());
  const ref = parsePrRef(c.pr.url);
  const runId = newRunId(new Date(started));
  const scratch = makeWorkDir(d.cfg, `${runId}-census`);
  const secrets = secretsFromEnv(d.env, d.cfg.publish.secret_env);
  const finish = (r: CensusRow) => ({ ...r, duration_s: Math.round((d.now() - started) / 1000) });
  try {
    if (!ref) return finish({ ...row, reason: 'bad_pr_url' });
    const info = await fetchPrInfo(d.run, d.cfg, ref);
    row.ci = info.ci;
    row.pr_title = info.title;
    if (info.state !== 'OPEN') return finish({ ...row, reason: 'pr_not_open', detail: info.state.toLowerCase() });
    const dir = cleanSubdir(c.dir ?? '');
    const clone = join(scratch, 'repo');
    await cloneNoCheckout(d.run, `${c.url}.git`, clone);
    const refs = await mergeLocally(d.run, clone, info);
    const path = journeysPath(d.cfg, dir);
    const files = censusJourneys(d.cfg, d.cwd, c.repo);
    const kinds = new Map(files.map((f) => [f.file.slice(0, -d.cfg.kane.journey_suffix.length), f.kind]));
    const withJourneys = await commitInto(d, clone, refs.base, path, { files }, 'Bumpproof census journeys (local only)');
    d.out(t('census.authoring', { repo: c.repo, n: files.length }));
    const authored = await authorOnBase(d, clone, withJourneys, dir, runId, scratch);
    row.credits = round3(authored.credits);
    if (!authored.built) return finish({ ...row, reason: 'base_build_failed', detail: scrubText(authored.detail ?? '', d.cfg.publish, secrets) });
    const base = await commitInto(d, clone, withJourneys, path, { fromDir: authored.folder }, 'Bumpproof census recordings (local only)');
    const head = await mergeOnto(d.run, clone, base, info.head_sha, info);
    await git(d.run, clone, ['checkout', '--quiet', '--detach', base]);
    const res = await runJourneyCommand({
      deps: { ...d, census: true }, opts: { repo: clone, base, head, dir, runId }, publish: false, cwd: d.cwd, out: d.out, err: d.err,
      source: { repo: c.url, pr: info.number, pr_url: info.url, pr_title: info.title, ci: info.ci }, fix: { fetch: d.fetch },
    }, t, p);
    const dest = resolve(d.cwd, d.cfg.census.runs_dir, res.report.run_id);
    const problems = writeRunJson(dest, res.report, d.cfg, d.env, res.patch, [], res.prompt);
    if (problems.length > 0) d.err(t('check.publish_blocked', { n: problems.length, first: problems[0]! }));
    const done = applyRun(row, res.report, authored.runs, kinds, authored.credits);
    const patchFile = res.report.fix?.patch_file;
    done.patch = problems.length === 0 && patchFile && res.patch ? relative(d.cwd, join(dest, patchFile)) : null;
    return finish(done);
  } catch (e) {
    if (e instanceof SandboxError || e instanceof BudgetError) throw e;
    if (e instanceof PrError || e instanceof GitError) {
      return finish({ ...row, reason: e instanceof PrError ? 'pr_error' : 'git_error', detail: scrubText(e.message, d.cfg.publish, secrets) });
    }
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface CensusRunFlags { limit: number; only?: string }

/** Runs the next candidates and writes census/results.json after each one. Exit 0 = ran, 2 = refused or nothing to do. */
export async function runCensus(d: CensusRunDeps, f: CensusRunFlags, t: Translate, p: Paint): Promise<number> {
  const cfg = d.cfg;
  const candPath = resolve(d.cwd, cfg.census.candidates_path);
  if (!existsSync(candPath)) {
    d.err(t('census.no_candidates', { path: cfg.census.candidates_path }));
    return 2;
  }
  const cands = JSON.parse(readFileSync(candPath, 'utf8')) as CandidatesFile;
  const resPath = resolve(d.cwd, cfg.report.census_path);
  const generic = censusJourneys(cfg, d.cwd, '').map((j) => j.file);
  let results = readResults(resPath, cands.order, generic);
  const order = cands.candidates.map((c) => c.repo);
  const todo = nextCandidates(cands.candidates, results.repos, f.limit, f.only);
  if (todo.length === 0) {
    d.out(t('census.nothing_left'));
    return 2;
  }
  for (const c of todo) {
    const usedMin = results.counts.duration_s / 60;
    if (usedMin >= cfg.census.run_timebox_min) {
      d.out(t('census.timebox', { used: Math.round(usedMin), limit: cfg.census.run_timebox_min }));
      return 0;
    }
    d.out(p.bold(t('census.running', { repo: c.repo, n: c.pr.number, bump: c.watched?.[0]?.name ?? '?' })));
    try {
      const row = await runCandidate(d, c, t, p);
      results = upsertRow(results, row, order, new Date(d.now()).toISOString());
      writeFileSync(resPath, `${JSON.stringify(results, null, 2)}\n`);
      d.out(t('census.row', { repo: row.repo, verdict: t(`verdict.${row.verdict}`), reason: row.reason, control: row.control,
        credits: row.credits, s: row.duration_s }));
    } catch (e) {
      if (e instanceof SandboxError) d.err(t('check.refused', { reason: t(`sandbox.refused_${e.code}`, { detail: e.message }) }));
      else if (e instanceof BudgetError) d.err(t('check.budget', { detail: e.message }));
      else throw e;
      return 2;
    }
  }
  return 0;
}

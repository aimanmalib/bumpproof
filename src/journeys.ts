// Runs the app's Kane CLI journeys (`*_test.md`) against one side while that side is being served (PRD §5.3, D2, D3).
// Each side runs on its own COPY of the journeys folder, so healing on the head never rewrites the committed recordings.
// Exit code first; the evidence pack only adds console and network warnings. Credits go to the ledger after every run.
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveChrome } from './chrome.ts';
import type { RunFacts } from './compare.ts';
import { needsRetry } from './compare.ts';
import { expandHome, type Config } from './config.ts';
import { parseCredits } from './doctor.ts';
import { readPack, secretsFromEnv, summarize, type EvidenceSummary } from './evidence.ts';
import { addRun, checkBudget, parseNdjson, readLedger, testmdArgs, toFacts, writeLedger, type KaneRun } from './kane.ts';
import type { Runner } from './proc.ts';

export interface JourneyFile { name: string; file: string }

export interface JourneyAttempt {
  kane: KaneRun;
  evidence: EvidenceSummary | null;
  /** Credits charged for this run: the balance drop when the balance could be read, else the NDJSON sum. */
  credits: number;
  seconds: number;
}

export interface KaneDeps {
  run: Runner;
  cfg: Config;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Where the credit ledger lives (the ledger path in config is relative to it). */
  ledgerRoot: string;
  census?: boolean;
}

export class BudgetError extends Error {
  reason: string;
  constructor(reason: string, used: number, limit: number) {
    super(`${reason}: ${used} of ${limit}`);
    this.reason = reason;
  }
}

/** Journey files in a folder, sorted, named by their stem (`checkout_test.md` → `checkout`). */
export function findJourneys(dir: string, suffix: string): JourneyFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) && f.length > suffix.length)
    .sort()
    .map((f) => ({ name: f.slice(0, -suffix.length), file: f }));
}

/** Copies journeys plus their recordings (`output-*`); local evidence folders are left behind. */
export function copyJourneys(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('.testmuai') });
}

/** The evidence pack named in the stream (`test_md_evidence_ingest` id, or the `pack` path of the `coverage` event). */
export function evidencePath(ndjson: string, cwd: string): string | null {
  let id: string | null = null;
  let pack: string | null = null;
  for (const line of ndjson.split('\n')) {
    if (!line.includes('evidence')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.type === 'test_md_evidence_ingest' && typeof e.evidence_id === 'string') id = e.evidence_id;
      if (e.type === 'coverage' && typeof e.pack === 'string') pack = e.pack;
    } catch {
      // not JSON: skip
    }
  }
  if (id && /^[A-Za-z0-9-]+$/.test(id)) {
    const local = join(cwd, '.testmuai', 'evidence', `${id}.evidence`);
    if (existsSync(local)) return local;
  }
  return pack && existsSync(pack) ? pack : null;
}

export function kaneEnv(cfg: Config, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const chrome = resolveChrome(cfg, env);
  return chrome ? { ...env, KANE_CLI_CHROME_PATH: chrome.path } : { ...env };
}

async function balance(d: KaneDeps, env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const r = await d.run(d.cfg.kane.command, ['balance'], { env, timeoutMs: d.cfg.doctor.timeout_ms });
  return r.ok ? parseCredits(r.stdout) : undefined;
}

/** One `kane-cli testmd run` of one journey in `cwd`. Refuses to start when the credit budget is spent. */
export async function runJourney(d: KaneDeps, cwd: string, j: JourneyFile, id: string): Promise<JourneyAttempt> {
  const ledgerPath = join(d.ledgerRoot, d.cfg.kane.ledger_path);
  const budget = checkBudget(readLedger(ledgerPath), d.cfg.kane, d.census === true);
  if (!budget.ok) throw new BudgetError(budget.reason, budget.used, budget.limit);
  const env = kaneEnv(d.cfg, d.env);
  const before = await balance(d, env);
  const started = d.now();
  const r = await d.run(d.cfg.kane.command, testmdArgs(j.file, d.cfg.kane.testmd_args), {
    cwd, env, timeoutMs: d.cfg.kane.timeout_s * 1000,
  });
  const seconds = Math.round((d.now() - started) / 1000);
  const kane = parseNdjson(r.stdout, r.error ? null : r.code);
  const after = await balance(d, env);
  const drop = before !== undefined && after !== undefined ? Math.round((before - after) * 1000) / 1000 : undefined;
  const credits = drop !== undefined && drop >= 0 ? drop : kane.credits_consumed;
  writeLedger(ledgerPath, addRun(readLedger(ledgerPath), {
    at: new Date(started).toISOString(), id, credits, census: d.census === true,
  }));
  let evidence: EvidenceSummary | null = null;
  const pack = evidencePath(r.stdout, cwd);
  if (pack) {
    try {
      evidence = summarize(readPack(readFileSync(pack)), d.cfg.publish, {
        min_status: d.cfg.compare.network_min_status, image_exts: d.cfg.evidence.image_exts,
        secrets: secretsFromEnv(d.env, d.cfg.publish.secret_env),
      });
    } catch {
      evidence = null; // unreadable pack: the exit code still decides
    }
  }
  return { kane, evidence, credits, seconds };
}

export function factsOf(a: JourneyAttempt): RunFacts {
  return toFacts(a.kane, a.evidence?.console_errors ?? [], a.evidence?.network_errors ?? []);
}

export type SideRuns = Map<string, JourneyAttempt[]>;

/**
 * Runs every journey once on the base; on the head only the journeys that passed on the base,
 * with one more attempt while the result is inconclusive (exit 2 or 3), as config allows.
 */
export async function runSide(
  d: KaneDeps, cwd: string, journeys: JourneyFile[], side: 'base' | 'head' | 'after_fix', runId: string,
  onlyPassedOn?: SideRuns, onRun?: (name: string, a: JourneyAttempt) => void,
): Promise<SideRuns> {
  const out: SideRuns = new Map();
  for (const j of journeys) {
    if (onlyPassedOn && onlyPassedOn.get(j.name)?.[0]?.kane.exit_code !== 0) continue;
    const attempts: JourneyAttempt[] = [];
    const maxRetries = side === 'base' ? 0 : d.cfg.compare.inconclusive_retries;
    do {
      const a = await runJourney(d, cwd, j, `${runId}:${side}:${j.name}:${attempts.length + 1}`);
      attempts.push(a);
      onRun?.(j.name, a);
    } while (needsRetry(attempts.map(factsOf), maxRetries));
    out.set(j.name, attempts);
  }
  return out;
}

export function journeysDir(appDir: string, cfg: Config): string {
  return join(appDir, expandHome(cfg.kane.journeys_dir));
}

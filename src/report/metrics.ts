// The measured results H1–H6 (PRD §2), computed from the files in the repository only:
// docs/runs/*/run.json, census/results.json, census/runs/*/run.json, census/candidates.json and the credit ledger.
// Nothing here is typed in by hand; a page that shows a number shows one of these.
import { existsSync, readFileSync } from 'node:fs';
import type { RunReport } from './run.ts';

/** The census row fields the numbers need (census/results.json). */
export interface CensusFacts {
  verdict: string;
  control: string | null;
  ci_green_but_broken: boolean;
  run_id: string | null;
}

export interface CandidateFacts { evaluated: number; eligible: number }
export interface LedgerEntry { id: string; credits: number; census: boolean }

export interface MetricInputs {
  runs: RunReport[];
  census: CensusFacts[] | null;
  censusRuns: RunReport[];
  candidates: CandidateFacts | null;
  ledger: LedgerEntry[] | null;
}

export interface FixTally { fixed: number; attempted: number; attempts: number }

export interface Metrics {
  h1: { prs: number; safe: number; fixed_regression: number; fixed_build: number; broken: number; other: number };
  h2: { evaluated: number | null; eligible: number | null; run: number; runnable: number } | null;
  h3: { count: number; runnable: number } | null;
  h4: { same: number; false_alarm: number; inconclusive: number; checked: number } | null;
  h5: {
    loop_median_s: number | null; loops: number; pr_credits_median: number | null; prs: number;
    author_mean: number | null; replay_mean: number | null; ratio: number | null;
  };
  h6: { demo: FixTally; census: FixTally; total: FixTally };
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const real = (runs: RunReport[]) => runs.filter((r) => !r.synthetic);
const isPr = (r: RunReport) => r.source.repo !== null && r.source.pr !== null;
const BUILD_REASONS = new Set(['head_build_failed']);

/** Seconds from the fixer starting (right after the failed check) to the end of Kane CLI's runs on the patch. */
export function loopSeconds(r: RunReport): number | null {
  if (r.fix?.status !== 'fixed') return null;
  const start = r.timeline.find((e) => e.key === 'fixer_start');
  const done = r.timeline.find((e) => e.key === 'fixer_done');
  return start && done && done.at_s >= start.at_s ? done.at_s - start.at_s : null;
}

function tally(runs: RunReport[]): FixTally {
  const asked = runs.filter((r) => r.fix !== null);
  return {
    fixed: asked.filter((r) => r.fix!.status === 'fixed').length,
    attempted: asked.length,
    attempts: asked.reduce((s, r) => s + r.fix!.attempts, 0),
  };
}

function h1(runs: RunReport[]): Metrics['h1'] {
  const prs = real(runs).filter(isPr);
  const n = (f: (r: RunReport) => boolean) => prs.filter(f).length;
  const safe = n((r) => r.verdict.verdict === 'safe');
  const fixedBuild = n((r) => r.verdict.verdict === 'fixed' && BUILD_REASONS.has(r.verdict.reason));
  const fixedRegression = n((r) => r.verdict.verdict === 'fixed' && r.verdict.reason === 'regression');
  const broken = n((r) => r.verdict.verdict === 'broken');
  return { prs: prs.length, safe, fixed_regression: fixedRegression, fixed_build: fixedBuild, broken,
    other: prs.length - safe - fixedBuild - fixedRegression - broken };
}

/** Census credits from the ledger: journeys authored on the base (`<run>-author:`) against replays of recordings. */
function credits(ledger: LedgerEntry[] | null): Pick<Metrics['h5'], 'author_mean' | 'replay_mean' | 'ratio'> {
  const census = (ledger ?? []).filter((e) => e.census);
  const authorMean = mean(census.filter((e) => e.id.includes('-author:')).map((e) => e.credits));
  const replayMean = mean(census.filter((e) => !e.id.includes('-author:')).map((e) => e.credits));
  return {
    author_mean: authorMean === null ? null : round1(authorMean),
    replay_mean: replayMean === null ? null : round1(replayMean),
    ratio: authorMean !== null && replayMean ? round1(authorMean / replayMean) : null,
  };
}

export function measure(i: MetricInputs): Metrics {
  const runs = real(i.runs);
  const censusRuns = real(i.censusRuns);
  const rows = i.census ?? [];
  const runnable = rows.filter((r) => r.verdict !== 'unrunnable').length;
  const prCredits = median(runs.filter(isPr).map((r) => r.credits_consumed));
  const loops = [...runs, ...censusRuns].map(loopSeconds).filter((s): s is number => s !== null);
  const demo = tally(runs);
  const census = tally(censusRuns);
  const checked = rows.filter((r) => r.control === 'same' || r.control === 'false_alarm' || r.control === 'inconclusive');
  return {
    h1: h1(runs),
    h2: i.census === null ? null : {
      evaluated: i.candidates?.evaluated ?? null, eligible: i.candidates?.eligible ?? null, run: rows.length, runnable,
    },
    h3: i.census === null ? null : { count: rows.filter((r) => r.ci_green_but_broken).length, runnable },
    h4: i.census === null ? null : {
      same: checked.filter((r) => r.control === 'same').length,
      false_alarm: checked.filter((r) => r.control === 'false_alarm').length,
      inconclusive: checked.filter((r) => r.control === 'inconclusive').length,
      checked: checked.length,
    },
    h5: {
      loop_median_s: median(loops), loops: loops.length,
      pr_credits_median: prCredits === null ? null : round1(prCredits), prs: runs.filter(isPr).length,
      ...credits(i.ledger),
    },
    h6: { demo, census, total: {
      fixed: demo.fixed + census.fixed, attempted: demo.attempted + census.attempted, attempts: demo.attempts + census.attempts,
    } },
  };
}

/** census/candidates.json: counted from the candidate list itself, not from its summary. */
export function readCandidates(path: string | undefined): CandidateFacts | null {
  if (!path || !existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as { candidates?: unknown };
  if (!Array.isArray(data.candidates)) return null;
  const status = (c: unknown) => (c && typeof c === 'object' ? (c as Record<string, unknown>).status : undefined);
  const evaluated = data.candidates.filter((c) => status(c) === 'eligible' || status(c) === 'excluded');
  return { evaluated: evaluated.length, eligible: evaluated.filter((c) => status(c) === 'eligible').length };
}

/** The Kane CLI credit ledger; entries without a numeric `credits` are skipped. */
export function readLedger(path: string | undefined): LedgerEntry[] | null {
  if (!path || !existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as { runs?: unknown };
  if (!Array.isArray(data.runs)) return null;
  return data.runs.flatMap((e: unknown) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.credits === 'number' ? [{ id: o.id, credits: o.credits, census: o.census === true }] : [];
  });
}

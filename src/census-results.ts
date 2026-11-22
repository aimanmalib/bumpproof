// census/results.json: one row per third-party pull request the census ran, plus counts computed from the rows only.
// The control (base against base) compares the run that authored the journeys on the base with the replay of the
// same recordings on the same base code: anything but "passed again" there is a false alarm of the tool itself (H4).
import { existsSync, readFileSync } from 'node:fs';
import type { Candidate } from './census.ts';
import type { Verdict } from './compare.ts';
import type { JourneyRun, RunReport } from './report/run.ts';

export type ControlOutcome = 'same' | 'false_alarm' | 'inconclusive' | 'not_run';
export type JourneyKind = 'generic' | 'specific';

export interface CensusJourney {
  name: string;
  kind: JourneyKind;
  /** The authoring run on the base. */
  author: string | null;
  /** The replay of the base recordings on the same base code. */
  control: ControlOutcome;
  /** Outcome against the head, from the run record ('baseline_red' when the base did not pass). */
  head: string | null;
  after_fix: string | null;
}

export interface CensusRow {
  repo: string;
  url: string;
  license: string | null;
  stars: number | null;
  pr_url: string;
  pr_number: number;
  pr_title: string;
  bot: string;
  /** CI state of the pull request when the census ran it: green, red, pending or none. */
  ci: string | null;
  dir: string;
  bump: string;
  verdict: Verdict;
  /** Verdict reason from the run record, or why the repository could not be run. */
  reason: string;
  /** Last log lines or error text when the repository could not be run. */
  detail: string | null;
  control: ControlOutcome;
  /** H3: CI was green (or absent) but the app broke on the head. */
  ci_green_but_broken: boolean;
  journeys: CensusJourney[];
  credits: number;
  duration_s: number;
  run_id: string | null;
  /** Patch kept in this report only (never sent to the repository). */
  patch: string | null;
  ran_at: string;
}

export interface CensusCounts {
  run: number;
  runnable: number;
  safe: number;
  fixed: number;
  broken: number;
  unrunnable: number;
  ci_green_but_broken: number;
  control_same: number;
  control_false_alarm: number;
  control_inconclusive: number;
  credits: number;
  duration_s: number;
}

export interface CensusResults {
  schema_version: 1;
  generated_at: string;
  rules: { order: string; generic_journeys: string[]; patches: string };
  counts: CensusCounts;
  repos: CensusRow[];
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function bumpLabel(c: Pick<Candidate, 'watched'>): string {
  return (c.watched ?? []).map((b) => `${b.name} ${b.from ?? '?'} → ${b.to ?? '?'}`).join(', ') || '—';
}

/** A row for a candidate, before (or without) a run: the caller fills in what the run found. */
export function rowFor(c: Candidate, ranAt: string): CensusRow {
  return {
    repo: c.repo, url: c.url, license: c.license ?? null, stars: c.stars ?? null, pr_url: c.pr.url, pr_number: c.pr.number,
    pr_title: c.pr.title, bot: c.pr.bot, ci: c.pr.ci ?? null, dir: c.dir ?? '', bump: bumpLabel(c), verdict: 'unrunnable',
    reason: 'not_run', detail: null, control: 'not_run', ci_green_but_broken: false, journeys: [], credits: 0, duration_s: 0,
    run_id: null, patch: null, ran_at: ranAt,
  };
}

/** One journey of the control: the authoring run against the replay on the same code. */
export function controlOutcome(author: JourneyRun | null, replay: JourneyRun | null): ControlOutcome {
  if (!author || author.status !== 'passed') return 'not_run';
  if (!replay) return 'inconclusive';
  if (replay.status === 'passed') return 'same';
  return replay.status === 'failed' ? 'false_alarm' : 'inconclusive';
}

export function overallControl(js: ControlOutcome[]): ControlOutcome {
  if (js.includes('false_alarm')) return 'false_alarm';
  const ran = js.filter((j) => j !== 'not_run');
  if (ran.length === 0) return 'not_run';
  return ran.includes('inconclusive') ? 'inconclusive' : 'same';
}

/** Fills the row from the run record and the authoring runs (keyed by journey name). */
export function applyRun(row: CensusRow, r: RunReport, authored: Map<string, JourneyRun | null>, kinds: Map<string, JourneyKind>,
  authorCredits: number): CensusRow {
  const journeys: CensusJourney[] = [...authored.keys()].map((name) => {
    const rec = r.journeys.find((j) => j.name === name);
    return {
      name, kind: kinds.get(name) ?? 'generic', author: authored.get(name)?.status ?? null,
      control: controlOutcome(authored.get(name) ?? null, rec?.base ?? null),
      head: rec ? rec.outcome : null, after_fix: rec?.after_fix?.status ?? null,
    };
  });
  const broke = r.verdict.verdict === 'broken' || r.verdict.verdict === 'fixed';
  return {
    ...row, verdict: r.verdict.verdict, reason: r.verdict.reason, journeys, control: overallControl(journeys.map((j) => j.control)),
    ci_green_but_broken: broke && (row.ci === 'green' || row.ci === 'none' || row.ci === null),
    credits: round3(r.credits_consumed + authorCredits), run_id: r.run_id,
  };
}

export function countsOf(rows: CensusRow[]): CensusCounts {
  const n = (f: (r: CensusRow) => boolean) => rows.filter(f).length;
  return {
    run: rows.length,
    runnable: n((r) => r.verdict !== 'unrunnable'),
    safe: n((r) => r.verdict === 'safe'),
    fixed: n((r) => r.verdict === 'fixed'),
    broken: n((r) => r.verdict === 'broken'),
    unrunnable: n((r) => r.verdict === 'unrunnable'),
    ci_green_but_broken: n((r) => r.ci_green_but_broken),
    control_same: n((r) => r.control === 'same'),
    control_false_alarm: n((r) => r.control === 'false_alarm'),
    control_inconclusive: n((r) => r.control === 'inconclusive'),
    credits: round3(rows.reduce((s, r) => s + r.credits, 0)),
    duration_s: rows.reduce((s, r) => s + r.duration_s, 0),
  };
}

export function emptyResults(order: string, generic: string[]): CensusResults {
  return { schema_version: 1, generated_at: '', rules: { order, generic_journeys: generic, patches: 'kept in this report only' },
    counts: countsOf([]), repos: [] };
}

export function readResults(path: string, order: string, generic: string[]): CensusResults {
  if (!existsSync(path)) return emptyResults(order, generic);
  const r = JSON.parse(readFileSync(path, 'utf8')) as CensusResults;
  if (r.schema_version !== 1 || !Array.isArray(r.repos)) throw new Error(`${path}: not a census results file (schema 1)`);
  return r;
}

/** Replaces the repository's row (or appends it) and keeps rows in candidate order; counts are recomputed. */
export function upsertRow(res: CensusResults, row: CensusRow, order: string[], now: string): CensusResults {
  const rows = [...res.repos.filter((r) => r.repo !== row.repo), row];
  const pos = (r: CensusRow) => {
    const i = order.indexOf(r.repo);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  rows.sort((a, b) => pos(a) - pos(b));
  return { ...res, generated_at: now, counts: countsOf(rows), repos: rows };
}

/** Eligible candidates in file order that have no row yet (or only the one named), up to `limit`. */
export function nextCandidates(all: Candidate[], done: CensusRow[], limit: number, only?: string): Candidate[] {
  const seen = new Set(done.map((r) => r.repo.toLowerCase()));
  const pick = all.filter((c) => c.status === 'eligible'
    && (only ? c.repo.toLowerCase() === only.toLowerCase() : !seen.has(c.repo.toLowerCase())));
  return pick.slice(0, Math.max(0, limit));
}

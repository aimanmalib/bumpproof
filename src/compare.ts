// Verdict rules. Plain code over Kane CLI exit codes and parsed events; no model ever decides a verdict.
//
// Per journey (base must pass first):
//   head exit 0, no heal       -> same
//   head exit 0, healed        -> shifted_ok   (the UI moved, the behaviour held)
//   head exit 1                -> regression
//   head exit 2/3 (or other)   -> inconclusive -> one retry -> still inconclusive = unrunnable for that journey
//   base not passing           -> baseline_red (journey left out, reported)
// Per pull request:
//   base did not build/start, or no journey passed on base       -> unrunnable
//   head did not build/start, or any regression                   -> fixed when a fix made every journey pass again,
//                                                                    otherwise broken
//   otherwise, with at least one journey evaluated                -> safe
//   otherwise (every head attempt inconclusive)                   -> unrunnable

export type Outcome = 'same' | 'shifted_ok' | 'regression' | 'inconclusive' | 'unrunnable' | 'baseline_red';
export type Verdict = 'safe' | 'fixed' | 'broken' | 'unrunnable';

/** The parts of one Kane CLI run that the rules read. */
export interface RunFacts {
  exit_code: number | null;
  healed: boolean;
  console_errors: string[];
  network_errors: string[];
}

export interface CompareOptions {
  console_errors_fail: boolean;
  network_errors_fail: boolean;
}

export interface JourneyResult {
  journey: string;
  outcome: Outcome;
  /** Head attempts actually used (1, or 2 after a retry). */
  attempts: number;
  new_console_errors: string[];
  new_network_errors: string[];
  /** Why a warning turned into a failure, when config asks for it. */
  failed_on: 'exit_code' | 'console' | 'network' | null;
}

export function runOutcome(r: RunFacts): 'pass' | 'fail' | 'inconclusive' {
  if (r.exit_code === 0) return 'pass';
  if (r.exit_code === 1) return 'fail';
  return 'inconclusive';
}

/** Entries in `head` that were not in `base` (order kept, duplicates dropped). */
export function newEntries(base: string[], head: string[]): string[] {
  const seen = new Set(base);
  const out: string[] = [];
  for (const h of head) if (!seen.has(h) && !out.includes(h)) out.push(h);
  return out;
}

/**
 * `head` holds the attempts in order. The caller runs a second attempt only when the first was
 * inconclusive (see `needsRetry`); extra attempts after a conclusive one are ignored.
 */
export function compareJourney(journey: string, base: RunFacts, head: RunFacts[], opts: CompareOptions): JourneyResult {
  const empty = { new_console_errors: [], new_network_errors: [], failed_on: null };
  if (runOutcome(base) !== 'pass') return { journey, outcome: 'baseline_red', attempts: 0, ...empty };
  const idx = head.findIndex((h) => runOutcome(h) !== 'inconclusive');
  const used = idx === -1 ? head.length : idx + 1;
  if (idx === -1) {
    return { journey, outcome: head.length >= 2 ? 'unrunnable' : 'inconclusive', attempts: used, ...empty };
  }
  const h = head[idx]!;
  const newConsole = newEntries(base.console_errors, h.console_errors);
  const newNetwork = newEntries(base.network_errors, h.network_errors);
  const res = { journey, attempts: used, new_console_errors: newConsole, new_network_errors: newNetwork };
  if (runOutcome(h) === 'fail') return { ...res, outcome: 'regression', failed_on: 'exit_code' };
  if (opts.console_errors_fail && newConsole.length > 0) return { ...res, outcome: 'regression', failed_on: 'console' };
  if (opts.network_errors_fail && newNetwork.length > 0) return { ...res, outcome: 'regression', failed_on: 'network' };
  return { ...res, outcome: h.healed ? 'shifted_ok' : 'same', failed_on: null };
}

/** True when the head attempts so far are all inconclusive and fewer than `maxRetries + 1` were made. */
export function needsRetry(head: RunFacts[], maxRetries: number): boolean {
  return head.length > 0 && head.length <= maxRetries && head.every((h) => runOutcome(h) === 'inconclusive');
}

export interface PrInput {
  base_built: boolean;
  head_built: boolean;
  journeys: JourneyResult[];
  /** Present when the fixer ran: did every journey pass again after the last patch? */
  fix?: { attempts: number; all_pass: boolean };
}

export interface PrVerdict {
  verdict: Verdict;
  reason: 'base_build_failed' | 'no_baseline_journey' | 'head_build_failed' | 'regression' | 'all_inconclusive' | 'ok';
  evaluated: number;
  counts: Record<Outcome, number>;
}

export function countOutcomes(journeys: JourneyResult[]): Record<Outcome, number> {
  const c: Record<Outcome, number> = { same: 0, shifted_ok: 0, regression: 0, inconclusive: 0, unrunnable: 0, baseline_red: 0 };
  for (const j of journeys) c[j.outcome]++;
  return c;
}

export function prVerdict(input: PrInput): PrVerdict {
  const counts = countOutcomes(input.journeys);
  const evaluated = counts.same + counts.shifted_ok + counts.regression;
  const baselineGreen = input.journeys.length - counts.baseline_red;
  const out = (verdict: Verdict, reason: PrVerdict['reason']): PrVerdict => ({ verdict, reason, evaluated, counts });
  if (!input.base_built) return out('unrunnable', 'base_build_failed');
  if (baselineGreen === 0) return out('unrunnable', 'no_baseline_journey');
  const problem = !input.head_built ? 'head_build_failed' : counts.regression > 0 ? 'regression' : null;
  if (problem) return out(input.fix?.all_pass ? 'fixed' : 'broken', problem);
  if (evaluated === 0) return out('unrunnable', 'all_inconclusive');
  return out('safe', 'ok');
}

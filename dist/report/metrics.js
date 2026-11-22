// The measured results H1–H6 (PRD §2), computed from the files in the repository only:
// docs/runs/*/run.json, census/results.json, census/runs/*/run.json, census/candidates.json and the credit ledger.
// Nothing here is typed in by hand; a page that shows a number shows one of these.
import { existsSync, readFileSync } from 'node:fs';
export const round1 = (n) => Math.round(n * 10) / 10;
export function median(xs) {
    if (xs.length === 0)
        return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const real = (runs) => runs.filter((r) => !r.synthetic);
const isPr = (r) => r.source.repo !== null && r.source.pr !== null;
const BUILD_REASONS = new Set(['head_build_failed']);
/** Seconds from the fixer starting (right after the failed check) to the end of Kane CLI's runs on the patch. */
export function loopSeconds(r) {
    if (r.fix?.status !== 'fixed')
        return null;
    const start = r.timeline.find((e) => e.key === 'fixer_start');
    const done = r.timeline.find((e) => e.key === 'fixer_done');
    return start && done && done.at_s >= start.at_s ? done.at_s - start.at_s : null;
}
function tally(runs) {
    const asked = runs.filter((r) => r.fix !== null);
    return {
        fixed: asked.filter((r) => r.fix.status === 'fixed').length,
        attempted: asked.length,
        attempts: asked.reduce((s, r) => s + r.fix.attempts, 0),
    };
}
function h1(runs) {
    const prs = real(runs).filter(isPr);
    const n = (f) => prs.filter(f).length;
    const safe = n((r) => r.verdict.verdict === 'safe');
    const fixedBuild = n((r) => r.verdict.verdict === 'fixed' && BUILD_REASONS.has(r.verdict.reason));
    const fixedRegression = n((r) => r.verdict.verdict === 'fixed' && r.verdict.reason === 'regression');
    const broken = n((r) => r.verdict.verdict === 'broken');
    return { prs: prs.length, safe, fixed_regression: fixedRegression, fixed_build: fixedBuild, broken,
        other: prs.length - safe - fixedBuild - fixedRegression - broken };
}
/** Census credits from the ledger: journeys authored on the base (`<run>-author:`) against replays of recordings. */
function credits(ledger) {
    const census = (ledger ?? []).filter((e) => e.census);
    const authorMean = mean(census.filter((e) => e.id.includes('-author:')).map((e) => e.credits));
    const replayMean = mean(census.filter((e) => !e.id.includes('-author:')).map((e) => e.credits));
    return {
        author_mean: authorMean === null ? null : round1(authorMean),
        replay_mean: replayMean === null ? null : round1(replayMean),
        ratio: authorMean !== null && replayMean ? round1(authorMean / replayMean) : null,
    };
}
export function measure(i) {
    const runs = real(i.runs);
    const censusRuns = real(i.censusRuns);
    const rows = i.census ?? [];
    const runnable = rows.filter((r) => r.verdict !== 'unrunnable').length;
    const prCredits = median(runs.filter(isPr).map((r) => r.credits_consumed));
    const loops = [...runs, ...censusRuns].map(loopSeconds).filter((s) => s !== null);
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
export function readCandidates(path) {
    if (!path || !existsSync(path))
        return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data.candidates))
        return null;
    const status = (c) => (c && typeof c === 'object' ? c.status : undefined);
    const evaluated = data.candidates.filter((c) => status(c) === 'eligible' || status(c) === 'excluded');
    return { evaluated: evaluated.length, eligible: evaluated.filter((c) => status(c) === 'eligible').length };
}
/** The Kane CLI credit ledger; entries without a numeric `credits` are skipped. */
export function readLedger(path) {
    if (!path || !existsSync(path))
        return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data.runs))
        return null;
    return data.runs.flatMap((e) => {
        const o = (e ?? {});
        return typeof o.id === 'string' && typeof o.credits === 'number' ? [{ id: o.id, credits: o.credits, census: o.census === true }] : [];
    });
}

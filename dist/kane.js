// Reads what Kane CLI prints in agent mode (NDJSON) and keeps the credit budget.
// Exit code first: 0 passed, 1 failed, 2 did not start (no credits used), 3 cancelled or timed out.
// Unknown event types and fields are ignored, so newer Kane CLI releases do not break parsing.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function statusFromExit(code) {
    switch (code) {
        case 0: return 'passed';
        case 1: return 'failed';
        case 2: return 'not_started';
        case 3: return 'cancelled';
        default: return 'error';
    }
}
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function parseNdjson(text, exitCode) {
    const run = {
        status: statusFromExit(exitCode), exit_code: exitCode, cli_version: null, surface: null, complete: false,
        overall_status: null, duration_s: null, credits_consumed: 0, result_code: null, reason: null, healed: false,
        steps: [], failed_step: null, bugs: [], events: 0, bad_lines: 0,
    };
    const headings = new Map();
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        let e;
        try {
            const v = JSON.parse(line);
            if (typeof v !== 'object' || v === null || Array.isArray(v))
                throw new Error('not an object');
            e = v;
        }
        catch {
            run.bad_lines++;
            continue;
        }
        run.events++;
        switch (e.type) {
            case 'stream_start':
                run.cli_version = str(e.cli_version);
                run.surface = str(e.surface);
                break;
            case 'test_md_step_start': {
                const i = num(e.step_index);
                if (i !== null)
                    headings.set(i, str(e.heading));
                break;
            }
            case 'test_md_step_end': {
                const i = num(e.step_index);
                if (i === null)
                    break;
                const step = { index: i, heading: headings.get(i) ?? null, status: str(e.status), duration_s: num(e.duration_s) };
                run.steps.push(step);
                if (step.status !== 'passed' && run.failed_step === null)
                    run.failed_step = step;
                break;
            }
            case 'test_md_adaptive_heal':
                run.healed = true;
                break;
            case 'test_md_summary': {
                // Kane CLI 0.10.7 reports healing here: `adaptive_heal: { triggered: true }`.
                const heal = e.adaptive_heal;
                if (heal && typeof heal === 'object' && heal.triggered === true)
                    run.healed = true;
                break;
            }
            case 'test_md_bug_verdict':
                run.bugs.push({ step_index: num(e.step_index), confirmed: e.confirmed === true, title: str(e.bug_title), one_liner: str(e.one_liner) });
                break;
            case 'run_end': {
                // testmd emits one run_end per step it runs; agent `run` emits one in total.
                run.credits_consumed += num(e.credits_consumed) ?? 0;
                const rc = num(e.result_code);
                if (rc !== null && (run.result_code === null || e.status !== 'passed'))
                    run.result_code = rc;
                if (e.status !== 'passed' && run.reason === null)
                    run.reason = str(e.reason) ?? str(e.summary);
                if (run.surface !== 'testmd') {
                    run.complete = true;
                    run.overall_status = str(e.status);
                    run.duration_s = num(e.duration);
                }
                break;
            }
            case 'test_md_done':
                run.complete = true;
                run.overall_status = str(e.overall_status);
                run.duration_s = num(e.duration_s);
                // If a release reports the session total here, it wins over the sum of per-step run_end events.
                if (num(e.credits_consumed) !== null)
                    run.credits_consumed = num(e.credits_consumed);
                break;
            default:
                break;
        }
    }
    return run;
}
/** The facts the verdict rules need from a parsed run plus the evidence pack summary. */
export function toFacts(run, consoleErrors = [], networkErrors = []) {
    return { exit_code: run.exit_code, healed: run.healed, console_errors: consoleErrors, network_errors: networkErrors };
}
/** Arguments for one replay of a journey file; flags come from config `kane.testmd_args`. */
export function testmdArgs(journeyFile, flags) {
    return ['testmd', 'run', journeyFile, ...flags];
}
export function emptyLedger() {
    return { schema_version: 1, total: 0, census: 0, runs: [] };
}
export function readLedger(path) {
    if (!existsSync(path))
        return emptyLedger();
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (v.schema_version !== 1 || !Array.isArray(v.runs))
        throw new Error(`${path}: unknown ledger format`);
    return recount(v.runs);
}
/** Totals are always recomputed from the entries, so a hand-edited total cannot hide spending. */
export function recount(runs) {
    const round = (n) => Math.round(n * 1000) / 1000;
    return {
        schema_version: 1,
        total: round(runs.reduce((s, r) => s + r.credits, 0)),
        census: round(runs.filter((r) => r.census).reduce((s, r) => s + r.credits, 0)),
        runs,
    };
}
export function addRun(ledger, entry) {
    if (!Number.isFinite(entry.credits) || entry.credits < 0)
        throw new Error(`bad credit amount for ${entry.id}`);
    return recount([...ledger.runs, entry]);
}
export function writeLedger(path, ledger) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
    renameSync(tmp, path);
}
/** May another run start? `census` runs also count against the census budget. */
export function checkBudget(ledger, budget, census) {
    if (ledger.total >= budget.credit_hard_stop) {
        return { ok: false, reason: 'hard_stop', used: ledger.total, limit: budget.credit_hard_stop };
    }
    if (census && ledger.census >= budget.census_budget) {
        return { ok: false, reason: 'census_budget', used: ledger.census, limit: budget.census_budget };
    }
    return { ok: true };
}

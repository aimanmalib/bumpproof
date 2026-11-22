// Turns one `check` with journeys into the published run record (`run.json`, schema in report/run.ts).
// The verdict comes from compare.ts rules only; this file just carries facts across.
import { compareJourney, prVerdict } from "./compare.js";
import { scrubText } from "./evidence.js";
import { factsOf } from "./journeys.js";
import { RUN_SCHEMA } from "./report/run.js";
/** Collects timeline lines with seconds since the run started. */
export class Timeline {
    entries = [];
    start;
    now;
    constructor(start, now) {
        this.start = start;
        this.now = now;
    }
    add(key, vars, tone = 'info') {
        this.entries.push({ at_s: Math.max(0, Math.round((this.now() - this.start) / 1000)), key, vars, tone });
    }
}
export function journeyRun(attempts, rules, secrets) {
    const last = attempts?.[attempts.length - 1];
    if (!attempts || !last)
        return null;
    const k = last.kane;
    const clean = (s) => (s === null ? null : scrubText(s, rules, secrets));
    return {
        status: k.status,
        seconds: k.duration_s ?? last.seconds,
        credits: Math.round(attempts.reduce((s, a) => s + a.credits, 0) * 1000) / 1000,
        healed: k.healed,
        failed_step: clean(k.failed_step?.heading ?? null),
        // A bug Kane CLI confirmed says what the user sees; the run_end reason is only a machine code.
        remark: k.status === 'passed' ? null : clean([...k.bugs].reverse().find((b) => b.confirmed)?.one_liner ?? k.reason),
        result_code: k.result_code,
    };
}
/** One record per journey found on the base. A journey with no head run (head did not build) is `unrunnable`. */
export function journeyRecords(journeys, base, head, opts, rules, secrets) {
    const records = [];
    const results = [];
    for (const j of journeys) {
        const b = base.get(j.name);
        if (!b?.[0])
            continue;
        const h = head?.get(j.name);
        const res = h && h.length > 0
            ? compareJourney(j.name, factsOf(b[0]), h.map(factsOf), opts)
            : b[0].kane.exit_code === 0
                ? { journey: j.name, outcome: 'unrunnable', attempts: 0, new_console_errors: [], new_network_errors: [], failed_on: null }
                : compareJourney(j.name, factsOf(b[0]), [], opts);
        results.push(res);
        records.push({
            name: j.name, base: journeyRun(b, rules, secrets), head: journeyRun(h, rules, secrets), after_fix: null,
            outcome: res.outcome, new_console_errors: res.new_console_errors, new_network_errors: res.new_network_errors,
        });
    }
    return { records, results };
}
export function buildRunReport(i, opts, rules, secrets) {
    const { records, results } = journeyRecords(i.journeys, i.base, i.head, opts, rules, secrets);
    const sides = i.check.sides;
    const v = prVerdict({
        base_built: sides.find((s) => s.side === 'base')?.built === true,
        head_built: sides.find((s) => s.side === 'head')?.built === true,
        journeys: results,
    });
    const all = [...i.base.values(), ...(i.head?.values() ?? [])].flat();
    return {
        schema_version: RUN_SCHEMA, run_id: i.check.run_id, synthetic: false, started_at: i.check.started_at,
        duration_s: i.durationS, bumpproof_version: i.bumpproofVersion, kane_cli_version: i.kaneVersion,
        source: { repo: null, pr: null, pr_url: null, pr_title: null, ci: null, ...i.source },
        app_dir: i.check.app_dir, base: i.check.base, head: i.check.head,
        bumps: i.bumps.map((b) => ({ name: b.name, from: b.from, to: b.to, type: b.type })),
        builds: sides.map((s) => ({ side: s.side, built: s.built, seconds: s.seconds, failed_at: s.failed_at ?? null })),
        journeys: records,
        verdict: { verdict: v.verdict, reason: v.reason, evaluated: v.evaluated },
        fix: null,
        credits_consumed: Math.round(all.reduce((s, a) => s + a.credits, 0) * 1000) / 1000,
        timeline: i.timeline,
        shots: [],
    };
}

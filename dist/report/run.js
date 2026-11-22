// The published run record: `docs/runs/<id>/run.json`. Reports, PR comments and `replay` read only this file,
// so it is validated on the way in and its shape is versioned (`schema_version`).
// Timeline lines hold a locale key and values, never sentences, so every reader can show them in English or Malay.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
export const RUN_SCHEMA = 1;
export class RunFormatError extends Error {
}
const VERDICTS = ['safe', 'fixed', 'broken', 'unrunnable'];
const OUTCOMES = ['same', 'shifted_ok', 'regression', 'inconclusive', 'unrunnable', 'baseline_red'];
const STATUSES = ['passed', 'failed', 'not_started', 'cancelled', 'error', 'skipped'];
const TONES = ['info', 'ok', 'fail', 'warn'];
function fail(path, want) {
    throw new RunFormatError(`${path}: expected ${want}`);
}
const obj = (v, p) => (v && typeof v === 'object' && !Array.isArray(v) ? v : fail(p, 'an object'));
const arr = (v, p) => (Array.isArray(v) ? v : fail(p, 'a list'));
const str = (v, p) => (typeof v === 'string' ? v : fail(p, 'text'));
const num = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(p, 'a number'));
const bool = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'true or false'));
const optStr = (v, p) => (v === null || v === undefined ? null : str(v, p));
const optNum = (v, p) => (v === null || v === undefined ? null : num(v, p));
const oneOf = (v, list, p) => (typeof v === 'string' && list.includes(v) ? v : fail(p, list.join(' | ')));
const strs = (v, p) => arr(v ?? [], p).map((x, i) => str(x, `${p}[${i}]`));
function journeyRun(v, p) {
    if (v === null || v === undefined)
        return null;
    const o = obj(v, p);
    return {
        status: oneOf(o.status, STATUSES, `${p}.status`), seconds: optNum(o.seconds, `${p}.seconds`),
        credits: num(o.credits ?? 0, `${p}.credits`), healed: bool(o.healed ?? false, `${p}.healed`),
        failed_step: optStr(o.failed_step, `${p}.failed_step`), remark: optStr(o.remark, `${p}.remark`),
        result_code: optNum(o.result_code, `${p}.result_code`),
    };
}
function safeFile(v, p) {
    const s = str(v, p);
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(s) || s.split('/').includes('..'))
        fail(p, 'a plain relative file name');
    return s;
}
/** Validates and normalises a parsed run.json. Unknown fields are dropped. */
export function parseRun(v) {
    const o = obj(v, 'run');
    const version = num(o.schema_version, 'schema_version');
    if (version !== RUN_SCHEMA)
        throw new RunFormatError(`schema_version: ${version} is not supported (this build reads ${RUN_SCHEMA})`);
    const src = obj(o.source ?? {}, 'source');
    const side = (x, p) => { const s = obj(x, p); return { ref: str(s.ref, `${p}.ref`), sha: str(s.sha, `${p}.sha`) }; };
    const verdict = obj(o.verdict, 'verdict');
    const fix = o.fix === null || o.fix === undefined ? null : obj(o.fix, 'fix');
    return {
        schema_version: version,
        run_id: safeFile(o.run_id, 'run_id'),
        synthetic: bool(o.synthetic ?? false, 'synthetic'),
        started_at: str(o.started_at, 'started_at'),
        duration_s: num(o.duration_s, 'duration_s'),
        bumpproof_version: str(o.bumpproof_version, 'bumpproof_version'),
        kane_cli_version: optStr(o.kane_cli_version, 'kane_cli_version'),
        source: {
            repo: optStr(src.repo, 'source.repo'), pr: optNum(src.pr, 'source.pr'), pr_url: optStr(src.pr_url, 'source.pr_url'),
            pr_title: optStr(src.pr_title, 'source.pr_title'), ci: optStr(src.ci, 'source.ci'),
        },
        app_dir: str(o.app_dir ?? '', 'app_dir'),
        base: side(o.base, 'base'),
        head: side(o.head, 'head'),
        bumps: arr(o.bumps ?? [], 'bumps').map((b, i) => {
            const x = obj(b, `bumps[${i}]`);
            return { name: str(x.name, `bumps[${i}].name`), from: optStr(x.from, `bumps[${i}].from`), to: optStr(x.to, `bumps[${i}].to`),
                type: str(x.type ?? 'unknown', `bumps[${i}].type`) };
        }),
        builds: arr(o.builds ?? [], 'builds').map((b, i) => {
            const x = obj(b, `builds[${i}]`);
            return { side: oneOf(x.side, ['base', 'head', 'fix'], `builds[${i}].side`), built: bool(x.built, `builds[${i}].built`),
                seconds: num(x.seconds, `builds[${i}].seconds`), failed_at: optStr(x.failed_at, `builds[${i}].failed_at`) };
        }),
        journeys: arr(o.journeys ?? [], 'journeys').map((j, i) => {
            const p = `journeys[${i}]`;
            const x = obj(j, p);
            return {
                name: str(x.name, `${p}.name`), base: journeyRun(x.base, `${p}.base`) ?? fail(`${p}.base`, 'an object'),
                head: journeyRun(x.head, `${p}.head`), after_fix: journeyRun(x.after_fix, `${p}.after_fix`),
                outcome: oneOf(x.outcome, OUTCOMES, `${p}.outcome`),
                new_console_errors: strs(x.new_console_errors, `${p}.new_console_errors`),
                new_network_errors: strs(x.new_network_errors, `${p}.new_network_errors`),
            };
        }),
        verdict: {
            verdict: oneOf(verdict.verdict, VERDICTS, 'verdict.verdict'), reason: str(verdict.reason, 'verdict.reason'),
            evaluated: num(verdict.evaluated, 'verdict.evaluated'),
        },
        fix: fix && {
            status: oneOf(fix.status, ['fixed', 'failed'], 'fix.status'), attempts: num(fix.attempts, 'fix.attempts'),
            changed_lines: num(fix.changed_lines, 'fix.changed_lines'), cost_usd: optNum(fix.cost_usd, 'fix.cost_usd'),
            files: strs(fix.files, 'fix.files'), explanation: str(fix.explanation ?? '', 'fix.explanation'),
            patch_file: fix.patch_file === null || fix.patch_file === undefined ? null : safeFile(fix.patch_file, 'fix.patch_file'),
            ...(fix.prompt_file === null || fix.prompt_file === undefined ? {} : { prompt_file: safeFile(fix.prompt_file, 'fix.prompt_file') }),
        },
        credits_consumed: num(o.credits_consumed ?? 0, 'credits_consumed'),
        timeline: arr(o.timeline ?? [], 'timeline').map((e, i) => {
            const p = `timeline[${i}]`;
            const x = obj(e, p);
            const vars = {};
            for (const [k, val] of Object.entries(obj(x.vars ?? {}, `${p}.vars`))) {
                vars[k] = typeof val === 'number' ? val : str(val, `${p}.vars.${k}`);
            }
            return { at_s: num(x.at_s, `${p}.at_s`), key: str(x.key, `${p}.key`), vars, tone: oneOf(x.tone ?? 'info', TONES, `${p}.tone`) };
        }),
        shots: arr(o.shots ?? [], 'shots').map((s, i) => {
            const x = obj(s, `shots[${i}]`);
            return { journey: str(x.journey, `shots[${i}].journey`), side: oneOf(x.side, ['base', 'head', 'after_fix'], `shots[${i}].side`),
                file: safeFile(x.file, `shots[${i}].file`) };
        }),
    };
}
/** Reads `<dir>/run.json`. */
export function readRun(dir) {
    const path = join(dir, 'run.json');
    if (!existsSync(path))
        throw new RunFormatError(`${path}: not found`);
    let data;
    try {
        data = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (e) {
        throw new RunFormatError(`${path}: not valid JSON (${e.message})`);
    }
    return parseRun(data);
}
/** Every `<runsDir>/<id>/run.json`, newest first. A broken record stops the report instead of being skipped quietly. */
export function readRuns(runsDir) {
    if (!existsSync(runsDir))
        return [];
    const runs = readdirSync(runsDir)
        .filter((n) => statSync(join(runsDir, n)).isDirectory() && existsSync(join(runsDir, n, 'run.json')))
        .map((n) => readRun(join(runsDir, n)));
    return runs.sort((a, b) => b.started_at.localeCompare(a.started_at) || a.run_id.localeCompare(b.run_id));
}
/** Short commit id for display. */
export const short = (sha) => sha.slice(0, 7);
/** `1 m 05 s` style durations come from locales; this gives the parts. */
export function splitSeconds(s) {
    const total = Math.max(0, Math.round(s));
    return { m: Math.floor(total / 60), s: total % 60 };
}

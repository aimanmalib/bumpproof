// `report` and `replay` commands: argument handling and output; the work lives in src/report/ and src/replay.ts.
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { ROOT } from "./config.js";
import { secretsFromEnv } from "./evidence.js";
import { makeTranslator } from "./i18n.js";
import { replay } from "./replay.js";
import { buildSite } from "./report/html.js";
import { renderComment } from "./report/markdown.js";
import { RunFormatError, readRun } from "./report/run.js";
import { makePaint, useColor } from "./ui.js";
import { version } from "./cli.js";
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
const at = (cwd, p) => (isAbsolute(p) ? p : join(cwd, p));
export function runReport(cfg, t, values, io) {
    try {
        const comment = str(values.comment);
        if (comment) {
            const run = readRun(at(io.cwd, comment));
            const runUrl = run.synthetic ? null : `${cfg.report.pages_url.replace(/\/?$/, '/')}runs/${run.run_id}/`;
            io.out(renderComment(run, t, { runUrl, bugCode: cfg.kane.bug_result_code }));
            return 0;
        }
        const outDir = at(io.cwd, str(values.out) ?? cfg.report.out_dir);
        const runsDir = at(io.cwd, str(values.runs) ?? (str(values.out) ? join(str(values.out), 'runs') : cfg.report.runs_dir));
        const censusPath = at(io.cwd, str(values.census) ?? cfg.report.census_path);
        const translators = new Map(cfg.languages.map((l) => [l, makeTranslator(l)]));
        const res = buildSite(cfg, { outDir, runsDir, censusPath, version: version(), translators,
            candidatesPath: at(io.cwd, cfg.census.candidates_path), censusRunsDir: at(io.cwd, cfg.census.runs_dir),
            ledgerPath: at(io.cwd, cfg.kane.ledger_path),
            readmePath: str(values.out) ? undefined : at(io.cwd, cfg.report.readme_path),
            secrets: secretsFromEnv(io.env, cfg.publish.secret_env) });
        if (res.findings.length > 0) {
            io.err(t('report.scan_failed', { count: res.findings.length }));
            for (const f of res.findings)
                io.err(`  ${f.file}:${f.line} ${f.kind} ${f.match}`);
            return 1;
        }
        if (!res.census)
            io.out(t('report.census_missing', { path: str(values.census) ?? cfg.report.census_path }));
        if (res.readme)
            io.out(t('report.readme_written', { path: cfg.report.readme_path }));
        io.out(t('report.written', { pages: res.pages.length, runs: res.runs, dir: str(values.out) ?? cfg.report.out_dir }));
        return 0;
    }
    catch (e) {
        if (e instanceof RunFormatError || e instanceof SyntaxError) {
            io.err(t('report.bad_input', { detail: e.message }));
            return 2;
        }
        throw e;
    }
}
/**
 * A run folder under the current directory wins. Outside a clone (an empty folder, `npx`, a global install) fall back
 * to the runs shipped inside the package, so `replay <id>` and `replay docs/runs/<id>` both work anywhere.
 */
export function replayDir(cwd, dir, root = ROOT) {
    const local = at(cwd, dir);
    const shipped = join(root, 'docs', 'runs', basename(dir));
    return existsSync(join(local, 'run.json')) || !existsSync(join(shipped, 'run.json')) ? local : shipped;
}
export async function runReplay(cfg, t, dir, speedFlag, io, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    if (!dir) {
        io.err(t('replay.need_dir'));
        return 2;
    }
    const speed = str(speedFlag) !== undefined ? Number(speedFlag) : cfg.replay.speed;
    try {
        const run = readRun(replayDir(io.cwd, dir));
        await replay(run, t, makePaint(useColor(io.env, io.isTTY)), {
            speed: Number.isFinite(speed) && speed >= 0 ? speed : cfg.replay.speed, maxGapMs: cfg.replay.max_gap_ms, sleep, out: io.out,
        });
        return 0;
    }
    catch (e) {
        if (e instanceof RunFormatError) {
            io.err(t('replay.bad_run', { detail: e.message }));
            return 2;
        }
        throw e;
    }
}

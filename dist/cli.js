#!/usr/bin/env node
// Entry point: parses arguments, picks the language, dispatches commands.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runCanary } from "./canary.js";
import { renderCheckComment, renderRefusalComment } from "./check-comment.js";
import { exitCodeOf, newRunId, renderCheck, runCheck, saveRecord } from "./check.js";
import { hasJourneys, journeyCommand } from "./check-cli.js";
import { BudgetError } from "./journeys.js";
import { ROOT, loadConfig } from "./config.js";
import { freeBytesOf, renderChecks, runChecks } from "./doctor.js";
import { makeTranslator, pickLang } from "./i18n.js";
import { GitError } from "./git.js";
import { run } from "./proc.js";
import { httpStatus, portFree, SandboxError } from "./sandbox.js";
import { makePaint, useColor } from "./ui.js";
import { runReplay, runReport } from "./report-cli.js";
import { runCensusFind } from "./census.js";
import { runCensus } from "./census-run.js";
import { parsePrArgs, runPr } from "./pr-cli.js";
import { secretsFromEnv } from "./evidence.js";
import { httpFetcher } from "./notes.js";
export const COMMANDS = ['doctor', 'init', 'check', 'fix', 'pr', 'census', 'report', 'replay'];
export function version() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return pkg.version;
}
export function helpText(t) {
    const rows = COMMANDS.map((c) => `  ${c.padEnd(9)} ${t(`cli.cmd_${c}`)}`);
    return [
        t('cli.usage'), '', t('cli.commands_title'), ...rows, '', t('cli.options_title'),
        `  --lang <en|ms>  ${t('cli.opt_lang')}`,
        `  --base <ref>    ${t('cli.opt_base')}`,
        `  --head <ref>    ${t('cli.opt_head')}`,
        `  --dir <path>    ${t('cli.opt_dir')}`,
        `  --repo <path>   ${t('cli.opt_repo')}`,
        `  --markdown <f>  ${t('cli.opt_markdown')}`,
        `  --min-free-gb <n> ${t('cli.opt_min_free_gb')}`,
        `  --build-only    ${t('cli.opt_build_only')}`,
        `  --publish       ${t('cli.opt_publish')}`,
        `  --fix           ${t('cli.opt_fix')}`,
        `  --push-fix      ${t('cli.opt_push_fix')}`,
        `  --canary        ${t('cli.opt_canary')}`,
        `  --find          ${t('cli.opt_find')}`,
        `  --run           ${t('cli.opt_run')}`,
        `  --out <dir>     ${t('cli.opt_out')}`,
        `  --comment <run> ${t('cli.opt_comment')}`,
        `  --speed <n>     ${t('cli.opt_speed')}`,
        `  -h, --help      ${t('cli.opt_help')}`,
        `  -v, --version   ${t('cli.opt_version')}`,
    ].join('\n');
}
/** Returns the process exit code. */
export async function main(argv, io) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: false,
        options: {
            lang: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
            base: { type: 'string' },
            head: { type: 'string' },
            dir: { type: 'string' },
            repo: { type: 'string' },
            canary: { type: 'boolean' },
            find: { type: 'boolean' },
            run: { type: 'boolean' },
            limit: { type: 'string' },
            only: { type: 'string' },
            markdown: { type: 'string' },
            'min-free-gb': { type: 'string' },
            out: { type: 'string' },
            runs: { type: 'string' },
            census: { type: 'string' },
            comment: { type: 'string' },
            speed: { type: 'string' },
            'build-only': { type: 'boolean' },
            publish: { type: 'boolean' },
            fix: { type: 'boolean' },
        },
    });
    const cfg = loadConfig(io.cwd);
    const lang = pickLang(typeof values.lang === 'string' ? values.lang : undefined, io.env, cfg.lang);
    if (!cfg.languages.includes(lang)) {
        io.err(makeTranslator('en')('cli.bad_lang', { lang, list: cfg.languages.join(', ') }));
        return 2;
    }
    const t = makeTranslator(lang);
    if (values.version) {
        io.out(version());
        return 0;
    }
    const cmd = positionals[0];
    if (values.help || !cmd) {
        io.out(helpText(t));
        return cmd || values.help ? 0 : 1;
    }
    if (!COMMANDS.includes(cmd)) {
        io.err(t('cli.unknown_command', { name: cmd }));
        io.err(helpText(t));
        return 2;
    }
    if (!cfg.enabled) {
        io.out(t('cli.disabled'));
        return 0;
    }
    if (cmd === 'doctor') {
        const checks = await runChecks({ cfg, t, run, env: io.env, nodeVersion: process.version, freeBytes: freeBytesOf });
        io.out(renderChecks(checks, t, makePaint(useColor(io.env, io.isTTY))));
        return checks.every((c) => c.ok) ? 0 : 1;
    }
    // `fix --base --head` is `check --fix`; `fix --canary` is handled further down.
    if (cmd === 'check' || (cmd === 'fix' && !values.canary)) {
        const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
        const base = str(values.base);
        const head = str(values.head);
        if (!base || !head) {
            io.err(t(cmd === 'fix' ? 'fix.need_check' : 'check.need_refs'));
            return 2;
        }
        const wantFix = cmd === 'fix' || values.fix === true;
        const minFree = str(values['min-free-gb']);
        if (minFree !== undefined) {
            const n = Number(minFree);
            if (!Number.isFinite(n) || n < 0) {
                io.err(t('cli.bad_number', { option: '--min-free-gb', value: minFree }));
                return 2;
            }
            cfg.sandbox.min_free_gb = n;
        }
        const repo = str(values.repo) ?? io.cwd;
        const paint = makePaint(useColor(io.env, io.isTTY));
        const md = str(values.markdown);
        const mdOpts = { version: version(), repoUrl: cfg.report.repo_url, logLines: cfg.sandbox.log_tail_lines };
        const writeMd = (text) => {
            if (md)
                writeFileSync(resolve(io.cwd, md), text);
        };
        const sandbox = { cfg, run, freeBytes: freeBytesOf, probe: httpStatus, isPortFree: portFree, now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
        const opts = { repo, base, head, dir: str(values.dir) ?? cfg.app.dir, runId: newRunId() };
        try {
            if (!values['build-only'] && hasJourneys(cfg, repo, opts.dir)) {
                return await journeyCommand({ deps: { ...sandbox, env: io.env, ledgerRoot: io.cwd, version: version() }, opts,
                    publish: values.publish === true, cwd: io.cwd, out: io.out, err: io.err,
                    ...(wantFix ? { fix: { fetch: httpFetcher(cfg.notes.timeout_ms) } } : {}) }, t, paint);
            }
            const rec = await runCheck(sandbox, opts);
            io.out(renderCheck(rec, t, paint));
            io.out(t('check.record', { path: saveRecord(repo, rec) }));
            writeMd(renderCheckComment(rec, t, mdOpts));
            return exitCodeOf(rec.outcome);
        }
        catch (e) {
            let reason;
            if (e instanceof SandboxError)
                reason = t(`sandbox.refused_${e.code}`, { detail: e.message });
            else if (e instanceof BudgetError)
                reason = t('check.budget', { detail: e.message });
            else if (e instanceof GitError)
                reason = t('check.git_error', { detail: e.message });
            else
                throw e;
            io.err(e instanceof SandboxError ? t('check.refused', { reason }) : reason);
            writeMd(renderRefusalComment(reason, t, mdOpts));
            return 2;
        }
    }
    if (cmd === 'fix') {
        io.out(t('fix.canary_running'));
        const r = await runCanary({ cfg, run, env: io.env });
        io.out(t(`fix.canary_${r.status}`, { date: r.date, detail: r.detail }));
        if (r.denied_tools.length > 0)
            io.out(t('fix.denied', { tools: r.denied_tools.join(', ') }));
        return r.status === 'pass' ? 0 : r.status === 'leak' ? 1 : 2;
    }
    if (cmd === 'pr') {
        const sandbox = { cfg, run, freeBytes: freeBytesOf, probe: httpStatus, isPortFree: portFree, now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
        return runPr({ deps: { ...sandbox, env: io.env, ledgerRoot: io.cwd, version: version() }, fetch: httpFetcher(cfg.notes.timeout_ms),
            version: version(), cwd: io.cwd, out: io.out, err: io.err }, parsePrArgs(argv), t, makePaint(useColor(io.env, io.isTTY)));
    }
    if (cmd === 'census' && values.run === true) {
        const limit = typeof values.limit === 'string' ? Number(values.limit) : cfg.census.run_limit;
        if (!Number.isInteger(limit) || limit < 1) {
            io.err(t('cli.bad_number', { option: '--limit', value: String(values.limit) }));
            return 2;
        }
        const sandbox = { cfg, run, freeBytes: freeBytesOf, probe: httpStatus, isPortFree: portFree, now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
        return runCensus({ ...sandbox, env: io.env, ledgerRoot: io.cwd, version: version(), fetch: httpFetcher(cfg.notes.timeout_ms),
            cwd: io.cwd, out: io.out, err: io.err }, { limit, ...(typeof values.only === 'string' ? { only: values.only } : {}) }, t, makePaint(useColor(io.env, io.isTTY)));
    }
    if (cmd === 'census') {
        if (!values.find) {
            io.err(t('census.need_find'));
            return 2;
        }
        const out = resolve(io.cwd, typeof values.out === 'string' && values.out ? values.out : cfg.census.candidates_path);
        return runCensusFind({ cfg, run, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), progress: (k, v) => io.err(t(k, v)) }, t, out, secretsFromEnv(io.env, cfg.publish.secret_env), io);
    }
    if (cmd === 'report')
        return runReport(cfg, t, values, io);
    if (cmd === 'replay')
        return runReplay(cfg, t, positionals[1], values.speed, io);
    io.err(t('cli.not_built', { name: cmd }));
    return 2;
}
/** True when run as the bin (also through an npm symlink), false when imported by tests. */
function isEntry() {
    const a = process.argv[1];
    if (!a)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(a)).href;
    }
    catch {
        return false;
    }
}
if (isEntry()) {
    process.exitCode = await main(process.argv.slice(2), {
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
        env: process.env,
        cwd: process.cwd(),
        isTTY: process.stdout.isTTY,
    });
}

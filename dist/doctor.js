// `bumpproof doctor`: one line per required tool, exit 0 only when every check passes.
// Identity output (Kane whoami, gh auth) is never printed: only the exit code is used.
import { statfsSync } from 'node:fs';
import { resolveChrome } from "./chrome.js";
import { firstLine } from "./proc.js";
export function freeBytesOf(path) {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
}
/** Pulls the first number out of a balance line; returns undefined when there is none. */
export function parseCredits(text) {
    const m = /(\d[\d,]*(?:\.\d+)?)/.exec(text);
    return m?.[1] ? Number(m[1].replace(/,/g, '')) : undefined;
}
export async function runChecks(d) {
    const { cfg, t, run, env } = d;
    const opts = { timeoutMs: cfg.doctor.timeout_ms, env };
    const failure = (r, fallback) => r.error === 'ENOENT' ? t('doctor.missing') : r.error === 'TIMEOUT' ? t('doctor.timeout') : fallback;
    const tool = async (id, cmd, args) => {
        const r = await run(cmd, args, opts);
        if (r.ok)
            return { id, ok: true, detail: firstLine(r.stdout || r.stderr) };
        return { id, ok: false, detail: failure(r, firstLine(r.stderr) || t('doctor.fail')) };
    };
    const loggedIn = async (id, cmd, args) => {
        const r = await run(cmd, args, opts);
        return { id, ok: r.ok, detail: r.ok ? t('doctor.logged_in') : failure(r, t('doctor.not_logged_in')) };
    };
    const balance = async () => {
        const r = await run(cfg.kane.command, ['balance'], opts);
        if (!r.ok)
            return { id: 'kane_balance', ok: false, detail: failure(r, t('doctor.not_logged_in')) };
        const n = parseCredits(r.stdout);
        return { id: 'kane_balance', ok: true, detail: n === undefined ? t('doctor.credits_unknown') : t('doctor.credits', { n }) };
    };
    const chrome = async () => {
        const found = resolveChrome(cfg, env);
        if (!found)
            return { id: 'chrome', ok: false, detail: t('doctor.missing') };
        const r = await run(found.path, ['--version'], opts);
        return { id: 'chrome', ok: r.ok, detail: r.ok ? `${firstLine(r.stdout)} (${found.source})` : failure(r, t('doctor.fail')) };
    };
    const major = Number(/^v?(\d+)/.exec(d.nodeVersion)?.[1] ?? 0);
    const node = {
        id: 'node',
        ok: major >= cfg.node.min_major,
        detail: major >= cfg.node.min_major ? d.nodeVersion : t('doctor.node_old', { found: d.nodeVersion, min: cfg.node.min_major }),
    };
    let free = 0;
    try {
        free = d.freeBytes(cfg.sandbox.disk_path) / 1e9;
    }
    catch {
        free = 0;
    }
    const disk = {
        id: 'disk',
        ok: free >= cfg.sandbox.min_free_gb,
        detail: t('doctor.disk_free', { free: free.toFixed(1), min: cfg.sandbox.min_free_gb }),
    };
    // Promise.all keeps the display order fixed while the tools run in parallel.
    return Promise.all([
        node,
        tool('docker', 'docker', ['version', '--format', '{{.Server.Version}}']),
        tool('kane_version', cfg.kane.command, ['--version']),
        loggedIn('kane_login', cfg.kane.command, ['whoami']),
        balance(),
        chrome(),
        loggedIn('gh', cfg.github.command, ['auth', 'status']),
        tool('fixer', cfg.fixer.command, ['--version']),
        disk,
    ]);
}
export function renderChecks(checks, t, p) {
    const label = (c) => t(`doctor.${c.id}`);
    const width = Math.max(...checks.map((c) => label(c).length));
    const okWord = t('doctor.ok');
    const failWord = t('doctor.fail');
    const markWidth = Math.max(okWord.length, failWord.length);
    const lines = [p.bold(t('doctor.title')), ''];
    for (const c of checks) {
        const mark = c.ok ? p.ok(`✓ ${okWord.padEnd(markWidth)}`) : p.fail(`✗ ${failWord.padEnd(markWidth)}`);
        lines.push(`${mark}  ${label(c).padEnd(width)}  ${p.dim(c.detail)}`);
    }
    const failed = checks.filter((c) => !c.ok).length;
    lines.push('', failed === 0 ? t('doctor.summary_ok', { n: checks.length }) : t('doctor.summary_fail', { failed, n: checks.length }));
    return lines.join('\n');
}

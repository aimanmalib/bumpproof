// `bumpproof check`: builds and serves the base, then the head, one after the other on the same port (PRD D3),
// each in the Docker sandbox. Browser journeys plug in at `onReady`; without them this is a build-and-start check.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expandHome } from "./config.js";
import { cleanSubdir, exportTree, resolveRef, shortSha, sideDir } from "./git.js";
import { removeLabelled, startApp, stopApp } from "./sandbox.js";
export function newRunId(d = new Date(), rand = Math.random) {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
    return `${stamp}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`;
}
export function outcomeOf(sides) {
    const base = sides.find((s) => s.side === 'base');
    if (!base?.built)
        return 'base_build_failed';
    return sides.find((s) => s.side === 'head')?.built ? 'both_built' : 'head_build_failed';
}
/** Exit codes: 0 both sides built and answered, 1 the head did not, 2 the base did not (nothing to compare). */
export function exitCodeOf(o) {
    return o === 'both_built' ? 0 : o === 'head_build_failed' ? 1 : 2;
}
export function makeWorkDir(cfg, runId) {
    if (cfg.sandbox.work_dir) {
        const dir = join(expandHome(cfg.sandbox.work_dir), `bumpproof-${runId}`);
        mkdirSync(dir, { recursive: true });
        return dir;
    }
    return mkdtempSync(join(tmpdir(), `bumpproof-${runId}-`));
}
export async function runCheck(d, o) {
    const dir = cleanSubdir(o.dir);
    const baseSha = await resolveRef(d.run, o.repo, o.base);
    const headSha = await resolveRef(d.run, o.repo, o.head);
    const record = {
        schema_version: 1, run_id: o.runId, started_at: new Date(d.now()).toISOString(), app_dir: dir,
        base: { ref: o.base, sha: baseSha }, head: { ref: o.head, sha: headSha }, sides: [], outcome: 'base_build_failed',
        journeys_run: false,
    };
    const work = makeWorkDir(d.cfg, o.runId);
    try {
        // Containers left behind by an interrupted earlier run would hold the port.
        await removeLabelled(d.run, d.cfg);
        for (const [side, sha] of [['base', baseSha], ['head', headSha]]) {
            const appDir = sideDir(work, side);
            await exportTree(d.run, o.repo, sha, dir, appDir);
            const name = `${d.cfg.sandbox.container_prefix}-${o.runId}-${side}`;
            try {
                const res = await startApp(d, { name, runId: o.runId, side, appDir });
                record.sides.push(res);
                if (res.built && o.onReady)
                    await o.onReady(side, appDir, res);
            }
            finally {
                await stopApp(d.run, name);
            }
            if (side === 'base' && !record.sides[0]?.built)
                break;
        }
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
    record.outcome = outcomeOf(record.sides);
    return record;
}
/** Writes `<repo>/.bumpproof/runs/<id>/build.json` and returns its path relative to the repository. */
export function saveRecord(repo, rec) {
    const dir = join(repo, '.bumpproof', 'runs', rec.run_id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'build.json');
    writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
    return relative(repo, path);
}
export function renderCheck(rec, t, p) {
    const lines = [
        p.bold(t('check.title', { base: `${rec.base.ref} (${shortSha(rec.base.sha)})`, head: `${rec.head.ref} (${shortSha(rec.head.sha)})` })),
        t('check.app_dir', { dir: rec.app_dir || '.' }),
        '',
    ];
    for (const s of rec.sides) {
        const side = t(`check.side_${s.side}`);
        if (s.built) {
            lines.push(p.ok(`✓ ${t('check.side_ok', { side, s: s.seconds })}`));
            continue;
        }
        const where = s.failed_at === 'plan' ? t(`sandbox.plan_${s.plan_problem ?? 'unknown'}`) : t(`sandbox.failed_${s.failed_at ?? 'start'}`);
        lines.push(p.fail(`✗ ${t('check.side_fail', { side, where, s: s.seconds })}`));
        if (s.exit_code !== undefined && s.exit_code !== null)
            lines.push(p.dim(`  ${t('check.exit_code', { code: s.exit_code })}`));
        for (const l of s.log_tail)
            lines.push(p.dim(`  │ ${l}`));
    }
    if (!rec.sides.some((s) => s.side === 'head'))
        lines.push(p.dim(t('check.head_skipped')));
    lines.push('', t(`check.outcome_${rec.outcome}`));
    if (!rec.journeys_run)
        lines.push(p.dim(t('check.journeys_not_run')));
    return lines.join('\n');
}

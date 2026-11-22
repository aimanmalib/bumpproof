// `bumpproof check` with browser journeys: while each side is served, Kane CLI runs the app's `*_test.md` journeys.
// The base side's journeys are the oracle (PRD D2); each side runs on its own copy (§5.3), in a temporary folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffPackageJson, type Bump } from './bump.ts';
import { runCheck, type CheckOptions, type CheckRecord } from './check.ts';
import type { JsonObject } from './config.ts';
import { secretsFromEnv } from './evidence.ts';
import { cleanSubdir } from './git.ts';
import { copyJourneys, findJourneys, journeysDir, runSide, type JourneyFile, type KaneDeps, type SideRuns } from './journeys.ts';
import { buildRunReport, Timeline } from './run-record.ts';
import type { RunReport } from './report/run.ts';
import type { SandboxDeps } from './sandbox.ts';
import type { Runner } from './proc.ts';

export type JourneyCheckDeps = SandboxDeps & { run: Runner; env: NodeJS.ProcessEnv; ledgerRoot: string; version: string };

export interface JourneyCheck {
  check: CheckRecord;
  report: RunReport;
  journeys: JourneyFile[];
  base: SideRuns;
  head: SideRuns | null;
}

/** `package.json` of the app folder at one commit, or null when it is missing or not JSON. */
export async function packageAt(run: Runner, repo: string, sha: string, dir: string): Promise<JsonObject | null> {
  const path = dir ? `${dir}/package.json` : 'package.json';
  const r = await run('git', ['-C', repo, 'show', `${sha}:${path}`], { timeoutMs: 20000 });
  if (!r.ok) return null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

export async function runJourneyCheck(
  d: JourneyCheckDeps, o: Omit<CheckOptions, 'onReady'>, source?: Partial<RunReport['source']>,
): Promise<JourneyCheck> {
  const started = d.now();
  const tl = new Timeline(started, d.now);
  const kd: KaneDeps = { run: d.run, cfg: d.cfg, env: d.env, now: d.now, ledgerRoot: d.ledgerRoot };
  const tmp = mkdtempSync(join(tmpdir(), `bumpproof-journeys-${o.runId}-`));
  let journeys: JourneyFile[] = [];
  let base: SideRuns = new Map();
  let head: SideRuns | null = null;
  tl.add('started_local', { base: o.base, head: o.head });
  try {
    const check = await runCheck(d, {
      ...o,
      onReady: async (side, appDir, res) => {
        tl.add('built', { side, s: res.seconds }, 'ok');
        if (side === 'base') {
          const src = journeysDir(appDir, d.cfg);
          journeys = findJourneys(src, d.cfg.kane.journey_suffix);
          if (journeys.length === 0) return;
          copyJourneys(src, join(tmp, 'base'));
          copyJourneys(src, join(tmp, 'head'));
        }
        if (journeys.length === 0) return;
        const runs = await runSide(kd, join(tmp, side), journeys, side, o.runId, side === 'head' ? base : undefined,
          (name, a) => tl.add(a.kane.healed && a.kane.exit_code === 0 ? 'healed' : 'journey',
            { side, name, status: a.kane.status, s: a.kane.duration_s ?? a.seconds },
            a.kane.exit_code === 0 ? 'ok' : a.kane.exit_code === 1 ? 'fail' : 'warn'));
        if (side === 'base') base = runs;
        else head = runs;
      },
    });
    check.journeys_run = journeys.length > 0;
    // Build results are known only once runCheck returns; a side that failed has no onReady call.
    for (const s of check.sides) if (!s.built) tl.add('build_failed', { side: s.side, phase: s.failed_at ?? 'start' }, 'fail');
    const dir = cleanSubdir(o.dir);
    const [pa, pb] = await Promise.all([packageAt(d.run, o.repo, check.base.sha, dir), packageAt(d.run, o.repo, check.head.sha, dir)]);
    const bumps: Bump[] = pa && pb ? diffPackageJson(pa, pb, d.cfg.bump.dep_fields) : [];
    const kaneVersion = [...base.values()].flat()[0]?.kane.cli_version ?? null;
    const report = buildRunReport({
      check, journeys, base, head, bumps, kaneVersion, bumpproofVersion: d.version,
      durationS: Math.round((d.now() - started) / 1000), timeline: tl.entries, ...(source ? { source } : {}),
    }, d.cfg.compare, d.cfg.publish, secretsFromEnv(d.env, d.cfg.publish.secret_env));
    for (const b of bumps) report.timeline.splice(1, 0, { at_s: 0, key: 'bump', vars: { name: b.name, from: b.from ?? '?', to: b.to ?? '?', type: b.type }, tone: 'info' });
    report.timeline.push({ at_s: report.duration_s, key: 'verdict', vars: { verdict: report.verdict.verdict },
      tone: report.verdict.verdict === 'safe' ? 'ok' : report.verdict.verdict === 'unrunnable' ? 'warn' : 'fail' });
    return { check, report, journeys, base, head };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

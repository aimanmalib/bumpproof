// `check --fix`: after a check found a regression or a head that does not build, Claude Code patches a fresh copy of
// the head (fixer.ts, guarded), the sandbox rebuilds that copy, and Kane CLI replays the journeys: the failed ones
// first, then the rest (PRD §5.6). The verdict is still decided by compare.ts; this file only gathers the facts.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Bump } from './bump.ts';
import type { JourneyCheck, JourneyCheckDeps } from './check-journeys.ts';
import { makeWorkDir } from './check.ts';
import { compareJourney, prVerdict, type JourneyResult } from './compare.ts';
import { scrubText, secretsFromEnv } from './evidence.ts';
import { fixLoop, type FixFailure, type FixResult, type Verification } from './fixer.ts';
import { condenseNotes, kaneFacts, renderPromptFile } from './fixer-prompt.ts';
import { makeTranslator } from './i18n.ts';
import { cleanSubdir, exportTree } from './git.ts';
import { copyJourneys, factsOf, journeysDir, runSide, type JourneyFile, type KaneDeps, type SideRuns } from './journeys.ts';
import { fetchNotes, notesBlock, type Fetcher } from './notes.ts';
import { journeyRun, Timeline } from './run-record.ts';
import type { BuildRecord, RunReport } from './report/run.ts';
import { startApp, stopApp, type SideResult } from './sandbox.ts';

export type FixStageDeps = JourneyCheckDeps & { fetch: Fetcher };

/** The fixer runs only on a broken verdict that a code change could repair. */
export function fixNeeded(r: RunReport): boolean {
  return r.verdict.verdict === 'broken' && (r.verdict.reason === 'regression' || r.verdict.reason === 'head_build_failed');
}

/** The journey file without its front matter: the objective and steps the fixer has to make pass again. */
export function journeyObjective(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/** What the fixer is told about the failure: the build log tail, or the first journey that regressed. */
export function failureOf(res: JourneyCheck, journeysSrc: string): FixFailure {
  const head = res.check.sides.find((s) => s.side === 'head');
  if (head && !head.built) return { kind: 'build', phase: head.failed_at ?? 'start', log: head.log_tail };
  const j = res.report.journeys.find((x) => x.outcome === 'regression');
  if (!j) throw new Error('no regression to fix');
  const file = res.journeys.find((x) => x.name === j.name)?.file;
  const shots = res.head?.get(j.name)?.at(-1)?.evidence?.screenshots;
  return {
    kind: 'journey', journey: j.name,
    ...(file ? { objective: journeyObjective(readFileSync(join(journeysSrc, file), 'utf8')) } : {}),
    ...(j.head?.failed_step ? { step: j.head.failed_step } : {}),
    ...(j.head?.remark ? { remark: j.head.remark } : {}),
    console: j.new_console_errors, network: j.new_network_errors, ...(shots ? { screenshots: shots } : {}),
  };
}

/** Failed journeys first, then the others that passed on the base; a journey red on the base is never replayed. */
export function replayOrder(res: JourneyCheck): JourneyFile[] {
  const green = res.journeys.filter((j) => res.base.get(j.name)?.[0]?.kane.exit_code === 0);
  const failed = new Set(res.report.journeys.filter((j) => j.outcome === 'regression' || j.outcome === 'unrunnable').map((j) => j.name));
  const headBuilt = res.check.sides.find((s) => s.side === 'head')?.built === true;
  const first = headBuilt ? green.filter((j) => failed.has(j.name)) : green;
  return [...first, ...green.filter((j) => !first.includes(j))];
}

interface LastVerify { build: SideResult | null; runs: SideRuns }

/** Builds the patched copy and replays the journeys. Stops at the first journey that does not pass. */
export async function verifyFix(
  d: FixStageDeps, res: JourneyCheck, workCopy: string, journeysSrc: string, scratch: string, n: number, tl: Timeline, last: LastVerify,
): Promise<Verification> {
  const appDir = join(scratch, `fix-${n}`);
  const replay = join(scratch, `fix-${n}-journeys`);
  // The sandbox writes node_modules and build output into the folder it mounts, so it gets a copy, not the agent's folder.
  cpSync(workCopy, appDir, { recursive: true });
  copyJourneys(journeysSrc, replay);
  const name = `${d.cfg.sandbox.container_prefix}-${res.report.run_id}-fix`;
  last.runs = new Map();
  try {
    const build = await startApp(d, { name, runId: res.report.run_id, side: 'fix', appDir });
    last.build = build;
    if (!build.built) {
      tl.add('build_failed', { side: 'fix', phase: build.failed_at ?? 'start' }, 'fail');
      return { ok: false, detail: `the patched app did not build or start (${build.failed_at ?? 'start'}); last log lines:\n${build.log_tail.join('\n')}` };
    }
    tl.add('built', { side: 'fix', s: build.seconds }, 'ok');
    const kd: KaneDeps = { run: d.run, cfg: d.cfg, env: d.env, now: d.now, ledgerRoot: d.ledgerRoot, census: d.census === true };
    for (const j of replayOrder(res)) {
      const runs = await runSide(kd, replay, [j], 'after_fix', res.report.run_id, undefined,
        (nm, a) => tl.add('journey', { side: 'after_fix', name: nm, status: a.kane.status, s: a.kane.duration_s ?? a.seconds },
          a.kane.exit_code === 0 ? 'ok' : a.kane.exit_code === 1 ? 'fail' : 'warn'));
      const attempts = runs.get(j.name) ?? [];
      last.runs.set(j.name, attempts);
      const base = res.base.get(j.name)?.[0];
      const outcome = base ? compareJourney(j.name, factsOf(base), attempts.map(factsOf), d.cfg.compare).outcome : 'unrunnable';
      if (outcome !== 'same' && outcome !== 'shifted_ok') {
        const k = attempts.at(-1)?.kane;
        const why = k?.failed_step?.heading ? ` at step "${k.failed_step.heading}"` : '';
        return { ok: false, detail: `journey ${j.name} still does not pass${why}: ${k?.reason ?? outcome}` };
      }
    }
    return { ok: true, detail: 'every journey passes again' };
  } finally {
    await stopApp(d.run, name);
    rmSync(appDir, { recursive: true, force: true });
    rmSync(replay, { recursive: true, force: true });
  }
}

/** Folds the fix into the run record: the fix build, `after_fix` per journey, the fix summary, credits and the verdict. */
export function applyFix(
  r: RunReport, fix: FixResult, last: LastVerify, d: FixStageDeps, patchFile: string | null, promptFile: string | null = null,
): void {
  const secrets = secretsFromEnv(d.env, d.cfg.publish.secret_env);
  if (last.build) {
    const b: BuildRecord = { side: 'fix', built: last.build.built, seconds: last.build.seconds, failed_at: last.build.failed_at ?? null };
    r.builds.push(b);
  }
  const results: JourneyResult[] = [];
  for (const j of r.journeys) {
    j.after_fix = journeyRun(last.runs.get(j.name), d.cfg.publish, secrets);
    results.push({ journey: j.name, outcome: j.outcome, attempts: 1, new_console_errors: [], new_network_errors: [], failed_on: null });
  }
  const afterCredits = [...last.runs.values()].flat().reduce((s, a) => s + a.credits, 0);
  r.credits_consumed = Math.round((r.credits_consumed + afterCredits) * 1000) / 1000;
  const costs = fix.attempts.map((a) => a.agent.cost_usd).filter((c): c is number => c !== null);
  const ok = fix.status === 'fixed';
  r.fix = {
    status: fix.status,
    attempts: fix.attempts.length,
    changed_lines: ok ? (fix.attempts.at(-1)?.changed_lines ?? 0) : 0,
    cost_usd: costs.length > 0 ? Math.round(costs.reduce((s, c) => s + c, 0) * 100) / 100 : null,
    files: fix.changes.map((c) => c.path),
    explanation: scrubText(fix.explanation.trim(), d.cfg.publish, secrets),
    patch_file: ok ? patchFile : null,
    prompt_file: fix.prompts.length > 0 ? promptFile : null,
  };
  const v = prVerdict({
    base_built: r.builds.some((b) => b.side === 'base' && b.built),
    head_built: r.builds.some((b) => b.side === 'head' && b.built),
    journeys: results,
    fix: { attempts: fix.attempts.length, all_pass: ok },
  });
  r.verdict = { verdict: v.verdict, reason: v.reason, evaluated: v.evaluated };
}

/** A file the verified fix changed, relative to the app folder: its new text, or null when the fix deleted it. */
export interface FixedFile { path: string; content: string | null }

export interface FixStage {
  fix: FixResult; patch: string; files: FixedFile[]; afterFix: SideRuns;
  /** fixer-prompt.md: the prompts as sent, scrubbed, Kane CLI's lines marked ('' when the fixer did not run). */
  prompt: string;
}

/** The published copy of the prompts: scrubbed like every other run text, release notes condensed. */
export function promptCopy(r: RunReport, failure: FixFailure, prompts: string[], d: Pick<FixStageDeps, 'cfg' | 'env'>): string {
  if (prompts.length === 0) return '';
  const secrets = secretsFromEnv(d.env, d.cfg.publish.secret_env);
  const en = makeTranslator('en');
  const code = failure.kind === 'journey' ? r.journeys.find((j) => j.name === failure.journey)?.head?.result_code ?? null : null;
  return renderPromptFile(en, {
    run_id: r.run_id,
    kane: kaneFacts(failure, code).map((f) => ({ ...f, value: scrubText(f.value, d.cfg.publish, secrets) })),
    quoted: failure.kind === 'journey' && failure.objective ? [scrubText(failure.objective, d.cfg.publish, secrets)] : [],
    prompts: prompts.map((p) => condenseNotes(scrubText(p, d.cfg.publish, secrets), (kb) => en('prompt_file.notes_left_out', { kb }))),
  });
}

/**
 * Runs the fixer on a fresh export of the head. The record in `res.report` is updated in place;
 * the patch text is returned for `fix.patch` next to `run.json`.
 */
export async function runFixStage(d: FixStageDeps, res: JourneyCheck, repo: string, dir: string, patchFile: string): Promise<FixStage> {
  const r = res.report;
  const started = Date.parse(r.started_at);
  const tl = new Timeline(Number.isFinite(started) ? started : d.now(), d.now);
  const scratch = makeWorkDir(d.cfg, `${r.run_id}-fix`);
  const sub = cleanSubdir(dir);
  const workCopy = join(scratch, 'head');
  const journeysSrc = join(scratch, 'journeys');
  const last: LastVerify = { build: null, runs: new Map() };
  try {
    await exportTree(d.run, repo, r.head.sha, sub, workCopy);
    // The oracle is the base's journeys and recordings, whatever the head carries.
    await exportTree(d.run, repo, r.base.sha, journeysDir(sub, d.cfg), journeysSrc);
    const notes: string[] = [];
    for (const b of res.report.bumps) {
      if (b.to === null) continue;
      notes.push(notesBlock(await fetchNotes({ cfg: d.cfg, run: d.run, fetch: d.fetch }, b.name, b.from, b.to)));
    }
    let n = 0;
    const failure = failureOf(res, journeysSrc);
    const fix = await fixLoop({
      cfg: d.cfg, run: d.run, env: d.env, name: `${d.cfg.sandbox.container_prefix}-${r.run_id}-fixer`,
      onEvent: (key, vars, tone) => tl.add(key, key === 'fixer_rejected' ? { ...vars, reason: String(vars.reason).slice(0, 200) } : vars, tone),
      verify: () => verifyFix(d, res, workCopy, journeysSrc, scratch, ++n, tl, last),
    }, workCopy, { bumps: r.bumps.map((b): Bump => ({ ...b, type: b.type as Bump['type'] })), failure, notes });
    applyFix(r, fix, last, d, patchFile, d.cfg.fixer.prompt_file);
    const prompt = promptCopy(r, failure, fix.prompts, d);
    const verdict = r.timeline.findIndex((e) => e.key === 'verdict');
    const at = verdict === -1 ? r.timeline.length : verdict;
    r.timeline.splice(at, verdict === -1 ? 0 : 1, ...tl.entries,
      { at_s: Math.round((d.now() - (Number.isFinite(started) ? started : d.now())) / 1000), key: 'verdict', vars: { verdict: r.verdict.verdict },
        tone: r.verdict.verdict === 'fixed' ? 'ok' : 'fail' });
    r.duration_s = Math.max(r.duration_s, r.timeline.at(-1)!.at_s);
    const files: FixedFile[] = fix.status === 'fixed'
      ? fix.changes.map((c) => ({ path: c.path, content: existsSync(join(workCopy, c.path)) ? readFileSync(join(workCopy, c.path), 'utf8') : null }))
      : [];
    return { fix, patch: fix.patch, files, afterFix: last.runs, prompt };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

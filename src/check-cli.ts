// The journey part of `bumpproof check`: run, print, save the run record, and optionally publish it under docs/runs/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runJourneyCheck, type JourneyCheckDeps } from './check-journeys.ts';
import { renderCheck, saveRecord, type CheckOptions } from './check.ts';
import type { Config } from './config.ts';
import { scanText, secretsFromEnv } from './evidence.ts';
import { cleanSubdir } from './git.ts';
import type { Translate } from './i18n.ts';
import { findJourneys, journeysDir } from './journeys.ts';
import type { RunReport } from './report/run.ts';
import type { Paint } from './ui.ts';

/** True when the working tree has journeys for the app folder (the base export is what actually runs). */
export function hasJourneys(cfg: Config, repo: string, dir: string): boolean {
  return findJourneys(journeysDir(join(repo, cleanSubdir(dir)), cfg), cfg.kane.journey_suffix).length > 0;
}

/** Exit codes: 0 safe, 1 broken (a regression or the head did not build), 2 nothing could be compared. */
export function verdictExit(r: RunReport): number {
  return r.verdict.verdict === 'safe' || r.verdict.verdict === 'fixed' ? 0 : r.verdict.verdict === 'broken' ? 1 : 2;
}

export function renderJourneys(r: RunReport, t: Translate, p: Paint): string {
  const lines: string[] = [];
  for (const j of r.journeys) {
    for (const [side, run] of [['base', j.base], ['head', j.head]] as const) {
      if (!run) continue;
      const text = t('check.journey_line', {
        side: t(`side.${side}`), name: j.name, status: t(`status.${run.status}`), s: run.seconds ?? '?', credits: run.credits,
      });
      lines.push(run.status === 'passed' ? p.ok(`✓ ${text}`) : p.fail(`✗ ${text}`));
      if (run.status !== 'passed' && run.failed_step) lines.push(p.dim(`  │ ${run.failed_step}`));
      if (run.status !== 'passed' && run.remark) lines.push(p.dim(`  │ ${run.remark.split('\n')[0]}`));
    }
  }
  lines.push('', p.bold(t('check.verdict_line', {
    verdict: t(`verdict.${r.verdict.verdict}`), reason: t(`reason.${r.verdict.reason}`), evaluated: r.verdict.evaluated,
    credits: r.credits_consumed,
  })));
  return lines.join('\n');
}

/** Writes `run.json` to `dir` after the publication scan; returns the problems found (nothing is written then). */
export function writeRunJson(dir: string, r: RunReport, cfg: Config, env: NodeJS.ProcessEnv): string[] {
  const text = `${JSON.stringify(r, null, 2)}\n`;
  const findings = scanText('run.json', text, cfg.publish, secretsFromEnv(env, cfg.publish.secret_env));
  if (findings.length > 0) return findings.map((f) => `${f.kind} line ${f.line}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), text);
  return [];
}

export interface JourneyCommand {
  deps: JourneyCheckDeps;
  opts: Omit<CheckOptions, 'onReady'>;
  publish: boolean;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function journeyCommand(c: JourneyCommand, t: Translate, p: Paint): Promise<number> {
  const { cfg } = c.deps;
  const names = findJourneys(journeysDir(join(c.opts.repo, cleanSubdir(c.opts.dir)), cfg), cfg.kane.journey_suffix).map((j) => j.name);
  c.out(t('check.journeys_found', { n: names.length, names: names.join(', ') }));
  const res = await runJourneyCheck(c.deps, c.opts);
  c.out(renderCheck(res.check, t, p).replace(`\n${p.dim(t('check.journeys_not_run'))}`, ''));
  c.out(renderJourneys(res.report, t, p));
  c.out(t('check.record', { path: saveRecord(c.opts.repo, res.check) }));
  const local = join(c.opts.repo, '.bumpproof', 'runs', res.report.run_id);
  const problems = writeRunJson(local, res.report, cfg, c.deps.env);
  if (problems.length === 0) c.out(t('check.record', { path: relative(c.opts.repo, join(local, 'run.json')) }));
  if (c.publish) {
    const dest = resolve(c.cwd, cfg.report.runs_dir, res.report.run_id);
    if (problems.length > 0) c.err(t('check.publish_blocked', { n: problems.length, first: problems[0]! }));
    else {
      writeRunJson(dest, res.report, cfg, c.deps.env);
      c.out(t('check.published', { path: relative(c.cwd, join(dest, 'run.json')) }));
    }
  }
  return verdictExit(res.report);
}

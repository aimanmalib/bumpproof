// The journey part of `bumpproof check`: run, print, save the run record, and optionally publish it under docs/runs/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fixNeeded, runFixStage } from './check-fix.ts';
import { runJourneyCheck, type JourneyCheckDeps } from './check-journeys.ts';
import { renderCheck, saveRecord, type CheckOptions } from './check.ts';
import type { Config } from './config.ts';
import { scanText, secretsFromEnv } from './evidence.ts';
import { cleanSubdir } from './git.ts';
import type { Translate } from './i18n.ts';
import { findJourneys, journeysDir } from './journeys.ts';
import type { Fetcher } from './notes.ts';
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

/** The fix part of the terminal output: each journey after the fix, the files touched, then the new verdict. */
export function renderFix(r: RunReport, t: Translate, p: Paint): string {
  const lines: string[] = [];
  for (const j of r.journeys) {
    const a = j.after_fix;
    if (!a) continue;
    const text = t('check.journey_line', { side: t('side.after_fix'), name: j.name, status: t(`status.${a.status}`), s: a.seconds ?? '?', credits: a.credits });
    lines.push(a.status === 'passed' ? p.ok(`✓ ${text}`) : p.fail(`✗ ${text}`));
  }
  const f = r.fix;
  if (f) {
    lines.push(f.status === 'fixed'
      ? t('fix.fixed', { attempts: f.attempts, lines: f.changed_lines, files: f.files.join(', ') })
      : t('fix.failed', { attempts: f.attempts }));
  }
  lines.push('', p.bold(t('check.verdict_line', {
    verdict: t(`verdict.${r.verdict.verdict}`), reason: t(`reason.${r.verdict.reason}`), evaluated: r.verdict.evaluated,
    credits: r.credits_consumed,
  })));
  return lines.join('\n');
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

/**
 * Writes `run.json` (and the fix patch, when there is one) to `dir` after the publication scan of both;
 * returns the problems found (nothing is written then).
 */
export function writeRunJson(dir: string, r: RunReport, cfg: Config, env: NodeJS.ProcessEnv, patch = ''): string[] {
  const files: [string, string][] = [['run.json', `${JSON.stringify(r, null, 2)}\n`]];
  if (r.fix?.patch_file && patch) files.push([r.fix.patch_file, patch]);
  const secrets = secretsFromEnv(env, cfg.publish.secret_env);
  const findings = files.flatMap(([name, text]) => scanText(name, text, cfg.publish, secrets).map((f) => `${name}: ${f.kind} line ${f.line}`));
  if (findings.length > 0) return findings;
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  return [];
}

export interface JourneyCommand {
  deps: JourneyCheckDeps;
  opts: Omit<CheckOptions, 'onReady'>;
  publish: boolean;
  /** Present with `--fix`: run the fixer on a regression or a failed head build (release notes come through `fetch`). */
  fix?: { fetch: Fetcher };
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
  let patch = '';
  if (c.fix && fixNeeded(res.report)) {
    c.out(`\n${t('fix.running', { attempts: cfg.fixer.max_attempts })}`);
    patch = (await runFixStage({ ...c.deps, fetch: c.fix.fetch }, res, c.opts.repo, c.opts.dir, cfg.fixer.patch_file)).patch;
    c.out(renderFix(res.report, t, p));
  }
  c.out(t('check.record', { path: saveRecord(c.opts.repo, res.check) }));
  const local = join(c.opts.repo, '.bumpproof', 'runs', res.report.run_id);
  const problems = writeRunJson(local, res.report, cfg, c.deps.env, patch);
  if (problems.length === 0) c.out(t('check.record', { path: relative(c.opts.repo, join(local, 'run.json')) }));
  if (c.publish) {
    const dest = resolve(c.cwd, cfg.report.runs_dir, res.report.run_id);
    if (problems.length > 0) c.err(t('check.publish_blocked', { n: problems.length, first: problems[0]! }));
    else {
      writeRunJson(dest, res.report, cfg, c.deps.env, patch);
      c.out(t('check.published', { path: relative(c.cwd, join(dest, 'run.json')) }));
    }
  }
  return verdictExit(res.report);
}

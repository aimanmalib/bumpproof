// `report` and `replay` commands: argument handling and output; the work lives in src/report/ and src/replay.ts.
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.ts';
import { secretsFromEnv } from './evidence.ts';
import { makeTranslator, type Translate } from './i18n.ts';
import { replay } from './replay.ts';
import { buildSite } from './report/html.ts';
import { renderComment } from './report/markdown.ts';
import { RunFormatError, readRun } from './report/run.ts';
import { makePaint, useColor } from './ui.ts';
import { version, type Io } from './cli.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const at = (cwd: string, p: string): string => (isAbsolute(p) ? p : join(cwd, p));

export function runReport(cfg: Config, t: Translate, values: Record<string, unknown>, io: Io): number {
  try {
    const comment = str(values.comment);
    if (comment) {
      const run = readRun(at(io.cwd, comment));
      const runUrl = run.synthetic ? null : `${cfg.report.pages_url.replace(/\/?$/, '/')}runs/${run.run_id}/`;
      io.out(renderComment(run, t, { version: version(), runUrl, bugCode: cfg.kane.bug_result_code }));
      return 0;
    }
    const outDir = at(io.cwd, str(values.out) ?? cfg.report.out_dir);
    const runsDir = at(io.cwd, str(values.runs) ?? (str(values.out) ? join(str(values.out)!, 'runs') : cfg.report.runs_dir));
    const censusPath = at(io.cwd, str(values.census) ?? cfg.report.census_path);
    const translators = new Map(cfg.languages.map((l) => [l, makeTranslator(l)] as const));
    const res = buildSite(cfg, { outDir, runsDir, censusPath, version: version(), translators,
      candidatesPath: at(io.cwd, cfg.census.candidates_path), censusRunsDir: at(io.cwd, cfg.census.runs_dir),
      ledgerPath: at(io.cwd, cfg.kane.ledger_path),
      secrets: secretsFromEnv(io.env, cfg.publish.secret_env) });
    if (res.findings.length > 0) {
      io.err(t('report.scan_failed', { count: res.findings.length }));
      for (const f of res.findings) io.err(`  ${f.file}:${f.line} ${f.kind} ${f.match}`);
      return 1;
    }
    if (!res.census) io.out(t('report.census_missing', { path: str(values.census) ?? cfg.report.census_path }));
    io.out(t('report.written', { pages: res.pages.length, runs: res.runs, dir: str(values.out) ?? cfg.report.out_dir }));
    return 0;
  } catch (e) {
    if (e instanceof RunFormatError || e instanceof SyntaxError) {
      io.err(t('report.bad_input', { detail: e.message }));
      return 2;
    }
    throw e;
  }
}

export async function runReplay(cfg: Config, t: Translate, dir: string | undefined, speedFlag: unknown, io: Io,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  if (!dir) {
    io.err(t('replay.need_dir'));
    return 2;
  }
  const speed = str(speedFlag) !== undefined ? Number(speedFlag) : cfg.replay.speed;
  try {
    const run = readRun(at(io.cwd, dir));
    await replay(run, t, makePaint(useColor(io.env, io.isTTY)), {
      speed: Number.isFinite(speed) && speed >= 0 ? speed : cfg.replay.speed, maxGapMs: cfg.replay.max_gap_ms, sleep, out: io.out,
    });
    return 0;
  } catch (e) {
    if (e instanceof RunFormatError) {
      io.err(t('replay.bad_run', { detail: e.message }));
      return 2;
    }
    throw e;
  }
}

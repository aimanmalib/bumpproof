#!/usr/bin/env node
// Entry point: parses arguments, picks the language, dispatches commands.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runCanary } from './canary.ts';
import { renderCheckComment, renderRefusalComment, type CheckCommentOptions } from './check-comment.ts';
import { exitCodeOf, newRunId, renderCheck, runCheck, saveRecord } from './check.ts';
import { ROOT, loadConfig, type Config } from './config.ts';
import { freeBytesOf, renderChecks, runChecks } from './doctor.ts';
import { makeTranslator, pickLang, type Translate } from './i18n.ts';
import { GitError } from './git.ts';
import { run } from './proc.ts';
import { httpStatus, portFree, SandboxError } from './sandbox.ts';
import { makePaint, useColor } from './ui.ts';
import { runReplay, runReport } from './report-cli.ts';

export const COMMANDS = ['doctor', 'init', 'check', 'fix', 'pr', 'census', 'report', 'replay'] as const;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean | undefined;
}

export function version(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export function helpText(t: Translate): string {
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
    `  --canary        ${t('cli.opt_canary')}`,
    `  --out <dir>     ${t('cli.opt_out')}`,
    `  --comment <run> ${t('cli.opt_comment')}`,
    `  --speed <n>     ${t('cli.opt_speed')}`,
    `  -h, --help      ${t('cli.opt_help')}`,
    `  -v, --version   ${t('cli.opt_version')}`,
  ].join('\n');
}

/** Returns the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
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
      markdown: { type: 'string' },
      'min-free-gb': { type: 'string' },
      out: { type: 'string' },
      runs: { type: 'string' },
      census: { type: 'string' },
      comment: { type: 'string' },
      speed: { type: 'string' },
    },
  });
  const cfg: Config = loadConfig(io.cwd);
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
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
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
  if (cmd === 'check') {
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const base = str(values.base);
    const head = str(values.head);
    if (!base || !head) {
      io.err(t('check.need_refs'));
      return 2;
    }
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
    const mdOpts: CheckCommentOptions = { version: version(), repoUrl: cfg.report.repo_url, logLines: cfg.sandbox.log_tail_lines };
    const writeMd = (text: string) => {
      if (md) writeFileSync(resolve(io.cwd, md), text);
    };
    try {
      const rec = await runCheck(
        { cfg, run, freeBytes: freeBytesOf, probe: httpStatus, isPortFree: portFree, now: Date.now,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        { repo, base, head, dir: str(values.dir) ?? cfg.app.dir, runId: newRunId() },
      );
      io.out(renderCheck(rec, t, paint));
      io.out(t('check.record', { path: saveRecord(repo, rec) }));
      writeMd(renderCheckComment(rec, t, mdOpts));
      return exitCodeOf(rec.outcome);
    } catch (e) {
      let reason: string;
      if (e instanceof SandboxError) reason = t(`sandbox.refused_${e.code}`, { detail: e.message });
      else if (e instanceof GitError) reason = t('check.git_error', { detail: e.message });
      else throw e;
      io.err(e instanceof SandboxError ? t('check.refused', { reason }) : reason);
      writeMd(renderRefusalComment(reason, t, mdOpts));
      return 2;
    }
  }
  if (cmd === 'fix') {
    if (!values.canary) {
      io.err(t('fix.need_check'));
      return 2;
    }
    io.out(t('fix.canary_running'));
    const r = await runCanary({ cfg, run, env: io.env });
    io.out(t(`fix.canary_${r.status}`, { date: r.date, detail: r.detail }));
    if (r.denied_tools.length > 0) io.out(t('fix.denied', { tools: r.denied_tools.join(', ') }));
    return r.status === 'pass' ? 0 : r.status === 'leak' ? 1 : 2;
  }
  if (cmd === 'report') return runReport(cfg, t, values, io);
  if (cmd === 'replay') return runReplay(cfg, t, positionals[1], values.speed, io);
  io.err(t('cli.not_built', { name: cmd }));
  return 2;
}

/** True when run as the bin (also through an npm symlink), false when imported by tests. */
function isEntry(): boolean {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(a)).href;
  } catch {
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

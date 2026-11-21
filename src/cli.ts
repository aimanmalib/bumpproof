#!/usr/bin/env node
// Entry point: parses arguments, picks the language, dispatches commands.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ROOT, loadConfig, type Config } from './config.ts';
import { freeBytesOf, renderChecks, runChecks } from './doctor.ts';
import { makeTranslator, pickLang, type Translate } from './i18n.ts';
import { run } from './proc.ts';
import { makePaint, useColor } from './ui.ts';

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

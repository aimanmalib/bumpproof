// Adds fixer-prompt.md to a fixed run recorded before `check --fix` saved the prompt (runs from 22 Nov 2026 and earlier).
// It rebuilds the first attempt's prompt with the same code (buildPrompt) from what the run recorded:
//   node scripts/add-prompt.ts docs/runs/<id> [--pack <head.evidence>] [--build-log <terminal log of the run>]
// --pack: the Kane CLI evidence pack of the failed journey's last head run (gives the screenshot file names).
// --build-log: the run's terminal output; the head's build log is the `  │ ` block under the failed head build.
// Anything not recorded is named in the file. The publication scan guards the output, as for every run file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunJson } from '../src/check-cli.ts';
import { journeyObjective } from '../src/check-fix.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { readPack, scrubText, secretsFromEnv, summarize } from '../src/evidence.ts';
import { buildPrompt, type FixFailure } from '../src/fixer.ts';
import { condenseNotes, kaneFacts, renderPromptFile } from '../src/fixer-prompt.ts';
import { makeTranslator } from '../src/i18n.ts';
import { NOTES_TAG } from '../src/notes.ts';
import { parseRun } from '../src/report/run.ts';
import type { Bump } from '../src/bump.ts';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (name: string) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };
if (!dir) {
  console.error('usage: node scripts/add-prompt.ts docs/runs/<id> [--pack <head.evidence>] [--build-log <file>]');
  process.exit(2);
}
const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
const cfg = loadConfig(ROOT);
const en = makeTranslator('en');
const raw = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>;
const report = parseRun(raw);
if (!report.fix) { console.error('this run has no fix'); process.exit(2); }
// A second attempt's prompt carries the reasons the first was refused, which no run recorded.
if (report.fix.attempts !== 1) { console.error('only a run fixed on its first attempt can be rebuilt'); process.exit(2); }

// The templates must be the ones the run used: refuse when prompts/ changed after the run started.
const [tplSha, tplDate] = git('log', '-1', '--format=%h %cI', '--', 'prompts/').trim().split(' ');
if (!tplSha || !tplDate || Date.parse(tplDate) > Date.parse(report.started_at)) {
  console.error(`prompts/ changed after the run (${tplSha} ${tplDate}); the rebuild would not be the prompt that was sent`);
  process.exit(1);
}

const missing: string[] = ['the release notes and their sources'];
let failure: FixFailure;
const headBuild = report.builds.find((b) => b.side === 'head');
if (headBuild && !headBuild.built) {
  const logFile = opt('--build-log');
  let log: string[] = [];
  if (logFile) {
    // The block printed under the failed head build: lines that start with `  │ `.
    const lines = readFileSync(logFile, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('✗ Head'));
    for (const l of lines.slice(start + 1)) {
      if (l.startsWith('  │ ')) log.push(l.slice(4));
      else if (log.length > 0) break;
    }
  }
  if (log.length === 0) { missing.push('the build log'); log = ['(not recorded)']; }
  failure = { kind: 'build', phase: headBuild.failed_at ?? 'start', log };
} else {
  const j = report.journeys.find((x) => x.outcome === 'regression');
  if (!j) { console.error('no regression in this run'); process.exit(2); }
  const file = `${cfg.kane.journeys_dir}/${j.name}${cfg.kane.journey_suffix}`.replace(/^\.\//, '');
  const objective = journeyObjective(git('show', `${report.base.sha}:${report.app_dir ? `${report.app_dir}/` : ''}${file}`));
  const pack = opt('--pack');
  let screenshots: string[] | undefined;
  if (pack) {
    screenshots = summarize(readPack(readFileSync(pack)), cfg.publish, {
      min_status: cfg.compare.network_min_status, image_exts: cfg.evidence.image_exts,
    }).screenshots;
  } else missing.push('the screenshot file names');
  failure = {
    kind: 'journey', journey: j.name, objective,
    ...(j.head?.failed_step ? { step: j.head.failed_step } : {}), ...(j.head?.remark ? { remark: j.head.remark } : {}),
    console: j.new_console_errors, network: j.new_network_errors, ...(screenshots ? { screenshots } : {}),
  };
}

const attr = (s: string | null) => (s ?? 'unknown').replace(/["<>]/g, '');
const notes = report.bumps.filter((b) => b.to !== null)
  .map((b) => `<${NOTES_TAG} package="${attr(b.name)}" from="${attr(b.from)}" to="${attr(b.to)}" sources="not recorded">\n-\n</${NOTES_TAG}>`);
const bumps = report.bumps.map((b): Bump => ({ ...b, type: b.type as Bump['type'] }));
const secrets = secretsFromEnv(process.env, cfg.publish.secret_env);
const prompt = condenseNotes(scrubText(buildPrompt(cfg, { bumps, failure, notes }), cfg.publish, secrets),
  () => en('prompt_file.notes_not_recorded'));
const code = failure.kind === 'journey' ? report.journeys.find((x) => x.name === failure.journey)?.head?.result_code ?? null : null;
const text = renderPromptFile(en, {
  run_id: report.run_id, prompts: [prompt],
  kane: kaneFacts(failure, code).map((f) => ({ ...f, value: scrubText(f.value, cfg.publish, secrets) })),
  quoted: failure.kind === 'journey' && failure.objective ? [scrubText(failure.objective, cfg.publish, secrets)] : [],
  rebuilt: { templates: `last changed in ${tplSha}, ${tplDate.slice(0, 10)}`, missing },
});

const fix = raw.fix as Record<string, unknown>;
fix.prompt_file = cfg.fixer.prompt_file;
const next = parseRun(raw);
const scratch = mkdtempSync(join(tmpdir(), 'bumpproof-add-prompt-'));
const problems = writeRunJson(scratch, next, cfg, process.env, '', [], text);
rmSync(scratch, { recursive: true, force: true });
if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1); }
writeFileSync(join(dir, cfg.fixer.prompt_file), text);
writeFileSync(join(dir, 'run.json'), `${JSON.stringify(raw, null, 2)}\n`);
console.log(`${join(dir, cfg.fixer.prompt_file)} ${Buffer.byteLength(text)} bytes; not recorded: ${missing.join('; ')}`);

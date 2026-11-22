// The fixer: Claude Code (`claude -p`) with file tools only, confined to the working copy (PRD D5).
// Our code fetches the release notes, writes the prompt from prompts/*.md, runs the agent, then the
// guards judge the patch. A rejected or unverified attempt is undone and its reasons go into the next prompt.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bump } from './bump.ts';
import { ROOT, type Config } from './config.ts';
import {
  checkGuards, diffTrees, renderPatch, restoreTree, snapshotTree, type FileChange, type Violation,
} from './guards.ts';
import type { Runner } from './proc.ts';
import { labelPair, sandboxUser } from './sandbox.ts';

export type FixFailure =
  | { kind: 'journey'; journey: string; objective?: string; step?: string; remark?: string;
      console?: string[]; network?: string[]; screenshots?: string[] }
  | { kind: 'build'; phase: string; log: string[] };

export interface FixInput {
  bumps: Bump[];
  failure: FixFailure;
  /** Pre-wrapped `<untrusted_release_notes>` blocks, one per package. */
  notes: string[];
}

export class PromptError extends Error {}

/** Fills `{{name}}`. A placeholder without a value is a bug in the template or the caller, so it throws. */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const left = /\{\{(\w+)\}\}/.exec(out);
  if (left) throw new PromptError(`template placeholder without a value: ${left[1]}`);
  return out;
}

export function readPrompt(name: string, root: string = ROOT): string {
  return readFileSync(join(root, 'prompts', `${name}.md`), 'utf8');
}

const list = (xs: string[] | undefined) => (xs && xs.length > 0 ? xs.map((x) => `\`${x}\``).join(', ') : '(none)');
const or = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : '(none)');

export function describePackages(bumps: Bump[]): string {
  return bumps.map((b) => `- \`${b.name}\`: ${b.from ?? '(new)'} -> ${b.to ?? '(removed)'} (${b.type})`).join('\n') || '- (unknown)';
}

export function describeFailure(f: FixFailure, cfg: Config, root: string = ROOT): string {
  if (f.kind === 'build') {
    return fillTemplate(readPrompt('failure-build', root), {
      phase: f.phase, log: f.log.slice(-cfg.fixer.build_log_lines).join('\n'),
    }).trim();
  }
  return fillTemplate(readPrompt('failure-journey', root), {
    journey: f.journey, objective: or(f.objective), step: or(f.step), remark: or(f.remark),
    console: list(f.console), network: list(f.network), screenshots: list(f.screenshots),
  }).trim();
}

export function buildPrompt(cfg: Config, input: FixInput, rejected: string[] = [], root: string = ROOT): string {
  const previous = rejected.length === 0 ? ''
    : fillTemplate(readPrompt('fixer-retry', root), { reasons: rejected.map((r) => `- ${r}`).join('\n') });
  return fillTemplate(readPrompt('fixer', root), {
    packages: describePackages(input.bumps),
    failure: describeFailure(input.failure, cfg, root),
    max_lines: String(cfg.fixer.max_patch_lines),
    explanation_file: cfg.fixer.explanation_file,
    notes: input.notes.join('\n\n') || '(no release notes found)',
    previous,
  });
}

export interface Invocation {
  cmd: string;
  args: string[];
  cwd: string;
}

/** Host mode runs `fixer.command` in the working copy; container mode runs it in Docker with only that folder mounted (D6). */
export function fixerInvocation(cfg: Config, workDir: string, prompt: string, name: string, user = sandboxUser(cfg)): Invocation {
  const f = cfg.fixer;
  const agentArgs = [...f.args.map((a) => a.replace('{model}', f.model)), prompt];
  if (f.mode !== 'container') return { cmd: f.command, args: agentArgs, cwd: workDir };
  const c = f.container;
  const s = cfg.sandbox;
  const [lk] = labelPair(cfg);
  return {
    cmd: 'docker',
    cwd: workDir,
    args: [
      'run', '--rm', '--name', name,
      '--label', s.label, '--label', `${lk}.side=fixer`,
      '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      `--cpus=${s.cpus}`, `--memory=${s.memory}`, `--pids-limit=${s.pids_limit}`,
      '--tmpfs', '/tmp', '--env', `HOME=${s.home}`, '--env', `npm_config_cache=${s.home}/.npm`,
      // Names only: Docker copies each value from our environment, so no key is ever on the command line.
      ...c.env.flatMap((k) => ['--env', k]),
      '--volume', `${workDir}:${c.work_dir}`, '--workdir', c.work_dir,
      c.image, ...c.command, ...agentArgs,
    ],
  };
}

export interface AgentReport {
  ok: boolean;
  result: string;
  cost_usd: number | null;
  turns: number | null;
  denied_tools: string[];
  error?: string;
}

/** Reads the `--output-format json` summary. Anything else is reported as a failed run with the raw tail. */
export function parseAgentOutput(stdout: string, code: number | null): AgentReport {
  try {
    const d = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>;
    const denials = Array.isArray(d.permission_denials) ? d.permission_denials : [];
    return {
      ok: code === 0 && d.is_error !== true,
      result: typeof d.result === 'string' ? d.result : '',
      cost_usd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
      turns: typeof d.num_turns === 'number' ? d.num_turns : null,
      denied_tools: denials.map((x) => String((x as { tool_name?: unknown }).tool_name ?? '?')),
    };
  } catch {
    return { ok: false, result: stdout.slice(-2000), cost_usd: null, turns: null, denied_tools: [], error: 'unreadable agent output' };
  }
}

export async function runAgent(run: Runner, cfg: Config, inv: Invocation, env: NodeJS.ProcessEnv): Promise<AgentReport & { stdout: string; stderr: string }> {
  const r = await run(inv.cmd, inv.args, { cwd: inv.cwd, env, timeoutMs: cfg.fixer.timeout_s * 1000 });
  const rep = parseAgentOutput(r.stdout, r.code);
  return { ...rep, ...(r.error ? { ok: false, error: r.error } : {}), stdout: r.stdout, stderr: r.stderr };
}

export interface Verification {
  ok: boolean;
  detail: string;
}

export interface Attempt {
  n: number;
  agent: AgentReport;
  violations: Violation[];
  changed_lines: number;
  verification?: Verification;
}

export interface FixResult {
  status: 'fixed' | 'failed';
  attempts: Attempt[];
  patch: string;
  explanation: string;
  changes: FileChange[];
}

export interface FixDeps {
  cfg: Config;
  run: Runner;
  env: NodeJS.ProcessEnv;
  /** Rebuilds the head and replays the journeys (B2 wires the sandbox and Kane CLI here). */
  verify: (changes: FileChange[]) => Promise<Verification>;
  root?: string;
  name?: string;
  /** Timeline hook: `fixer_start`, `fixer_rejected`, `fixer_done` (locale keys under `timeline.`). */
  onEvent?: (key: string, vars: Record<string, string | number>, tone: 'info' | 'ok' | 'fail') => void;
}

const reason = (v: Violation) => `${v.rule}${v.path ? ` (${v.path})` : ''}: ${v.detail}`;

/** Up to `fixer.max_attempts` tries. The working copy is left fixed on success and as it started on failure. */
export async function fixLoop(d: FixDeps, workDir: string, input: FixInput): Promise<FixResult> {
  const { cfg } = d;
  const before = snapshotTree(workDir, cfg.fixer.snapshot_skip);
  const attempts: Attempt[] = [];
  const rejected: string[] = [];
  for (let n = 1; n <= cfg.fixer.max_attempts; n++) {
    const prompt = buildPrompt(cfg, input, rejected, d.root);
    d.onEvent?.('fixer_start', { attempt: n }, 'info');
    const agent = await runAgent(d.run, cfg, fixerInvocation(cfg, workDir, prompt, `${d.name ?? 'bumpproof-fixer'}-${n}`), d.env);
    const after = snapshotTree(workDir, cfg.fixer.snapshot_skip);
    const changes = diffTrees(before, after);
    const violations = checkGuards(before, after, changes, cfg);
    const changedLines = changes.filter((c) => c.path !== cfg.fixer.explanation_file)
      .reduce((s, c) => s + c.added.length + c.removed.length, 0);
    const attempt: Attempt = { n, agent: strip(agent), violations, changed_lines: changedLines };
    attempts.push(attempt);
    if (violations.length === 0) {
      attempt.verification = await d.verify(changes);
      if (attempt.verification.ok) {
        d.onEvent?.('fixer_done', { lines: changedLines }, 'ok');
        const note = after.get(cfg.fixer.explanation_file)?.data.toString('utf8') ?? '';
        return { status: 'fixed', attempts, patch: renderPatch(changes), explanation: note, changes };
      }
      rejected.push(`the patch passed the guards but the check still fails: ${attempt.verification.detail}`);
    } else {
      rejected.push(...violations.map(reason));
    }
    d.onEvent?.('fixer_rejected', { attempt: n, reason: rejected[rejected.length - 1] ?? '' }, 'fail');
    restoreTree(workDir, before, changes);
  }
  return { status: 'failed', attempts, patch: '', explanation: '', changes: [] };
}

function strip(a: AgentReport & { stdout?: string; stderr?: string }): AgentReport {
  const { stdout: _o, stderr: _e, ...rest } = a;
  return rest;
}

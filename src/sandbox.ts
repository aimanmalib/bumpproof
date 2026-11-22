// Docker sandbox for the app under test (PRD D7). The app's own code (install, build, serve) only ever runs in here.
// Flags: non-root user, no capabilities, no-new-privileges, CPU/memory/PID limits, port bound to 127.0.0.1 only,
// no host environment or secrets, dependency install with --ignore-scripts. Every container carries the label from
// config, and cleanup only ever touches containers with that label.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Runner } from './proc.ts';

export class SandboxError extends Error {
  readonly code: 'disk' | 'port' | 'docker';
  constructor(code: 'disk' | 'port' | 'docker', message: string) {
    super(message);
    this.code = code;
  }
}

export type Phase = 'install' | 'build' | 'serve';
/** Where a side stopped: a setup phase, the container not starting, the app not answering, or no usable plan. */
export type FailedAt = Phase | 'start' | 'health' | 'plan';

export interface AppPlan {
  pm: string;
  install: string;
  build: string;
  serve: string;
}

export interface SandboxFacts {
  image: string;
  user: string;
  cap_drop: string[];
  security_opt: string[];
  nano_cpus: number;
  memory_bytes: number;
  pids_limit: number;
  ports: string[];
  labels: Record<string, string>;
}

export interface SideResult {
  side: 'base' | 'head' | 'fix';
  built: boolean;
  failed_at?: FailedAt;
  /** Plan problem key (locales `sandbox.plan_*`) when failed_at is `plan`. */
  plan_problem?: string;
  exit_code?: number | null;
  seconds: number;
  plan?: AppPlan;
  log_tail: string[];
  sandbox?: SandboxFacts;
}

const MARK = '##bumpproof phase=';

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Picks package manager and commands from lockfiles and package.json; explicit `app.*` config wins. */
export function planApp(dir: string, cfg: Config): AppPlan | { problem: string } {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return { problem: 'no_package_json' };
  let pkg: Pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Pkg;
  } catch {
    return { problem: 'bad_package_json' };
  }
  const s = cfg.sandbox;
  const lock = Object.keys(s.lockfiles).find((f) => existsSync(join(dir, f)));
  const pm = lock ? s.lockfiles[lock]! : undefined;
  const install = cfg.app.install || (pm ? s.install[pm] : undefined);
  if (!pm || !install) return { problem: 'no_lockfile' };
  const runner = s.run_script[pm] ?? s.run_script.npm!;
  const scripts = pkg.scripts ?? {};
  const build = cfg.app.build || (scripts[s.build_script] ? `${runner} ${s.build_script}` : '');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const preset = s.serve_presets.find((p) => p.dependency in deps);
  const script = s.serve_scripts.find((n) => scripts[n]);
  const serve = cfg.app.serve || preset?.command || (script ? `${runner} ${script}` : '');
  if (!serve) return { problem: 'no_serve' };
  return { pm, install, build, serve: serve.replaceAll('{port}', String(cfg.port)) };
}

/** The one shell script the container runs. Phase markers let the host tell install, build and serve failures apart. */
export function setupScript(plan: AppPlan): string {
  return [
    'set -e',
    `echo '${MARK}install'`,
    plan.install,
    `echo '${MARK}build'`,
    plan.build || ':',
    `echo '${MARK}serve'`,
    `exec ${plan.serve}`,
  ].join('\n');
}

export function lastPhase(logs: string): Phase | undefined {
  let phase: Phase | undefined;
  for (const line of logs.split(/\r?\n/)) {
    if (line.startsWith(MARK)) {
      const p = line.slice(MARK.length).trim();
      if (p === 'install' || p === 'build' || p === 'serve') phase = p;
    }
  }
  return phase;
}

/** Host uid:gid so files written into the mounted folder stay removable; never root. */
export function sandboxUser(cfg: Config, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0): string {
  if (cfg.sandbox.user) return cfg.sandbox.user;
  return uid > 0 ? `${uid}:${gid}` : 'node';
}

export interface RunArgs {
  name: string;
  runId: string;
  side: 'base' | 'head' | 'fix';
  appDir: string;
  user: string;
  script: string;
}

export function labelPair(cfg: Config): [string, string] {
  const [k, v = ''] = cfg.sandbox.label.split('=');
  return [k!, v];
}

/** Every D7 flag in one place, so a test can read them. The host environment is never passed through. */
export function dockerRunArgs(cfg: Config, a: RunArgs): string[] {
  const s = cfg.sandbox;
  const [lk] = labelPair(cfg);
  const env = { ...s.env, HOME: s.home, npm_config_cache: `${s.home}/.npm`, COREPACK_HOME: `${s.home}/.corepack`,
    HOST: '0.0.0.0', PORT: String(cfg.port) };
  return [
    'run', '--detach',
    '--name', a.name,
    '--label', s.label,
    '--label', `${lk}.run=${a.runId}`,
    '--label', `${lk}.side=${a.side}`,
    '--user', a.user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    `--cpus=${s.cpus}`,
    `--memory=${s.memory}`,
    `--pids-limit=${s.pids_limit}`,
    '--publish', `127.0.0.1:${cfg.port}:${cfg.port}`,
    '--volume', `${a.appDir}:/app`,
    '--workdir', '/app',
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    s.image,
    'sh', '-c', a.script,
  ];
}

export function diskFreeGb(cfg: Config, freeBytes: (p: string) => number): number {
  try {
    return freeBytes(cfg.sandbox.disk_path) / 1e9;
  } catch {
    return 0;
  }
}

/** True when nothing on the host is listening on 127.0.0.1:<port>. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function httpStatus(url: string, timeoutMs = 3000): Promise<number | undefined> {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return r.status;
  } catch {
    return undefined;
  }
}

export interface SandboxDeps {
  cfg: Config;
  run: Runner;
  freeBytes: (p: string) => number;
  probe: (url: string) => Promise<number | undefined>;
  isPortFree: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function tail(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith(MARK));
  return lines.slice(-n);
}

async function state(run: Runner, name: string): Promise<{ running: boolean; exit: number | null }> {
  const r = await run('docker', ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name], { timeoutMs: 30000 });
  if (!r.ok) return { running: false, exit: null };
  const [running, exit] = r.stdout.trim().split(' ');
  return { running: running === 'true', exit: running === 'true' ? null : Number(exit) };
}

async function logs(run: Runner, name: string): Promise<{ out: string; all: string }> {
  const r = await run('docker', ['logs', name], { timeoutMs: 30000 });
  return { out: r.stdout, all: `${r.stdout}\n${r.stderr}` };
}

/** Reads the flags back from Docker, so the run record shows what was really applied. */
export async function inspectFacts(run: Runner, name: string): Promise<SandboxFacts | undefined> {
  const r = await run('docker', ['inspect', name], { timeoutMs: 30000 });
  if (!r.ok) return undefined;
  try {
    const [c] = JSON.parse(r.stdout) as Array<{
      Config: { Image: string; User: string; Labels: Record<string, string> | null };
      HostConfig: { CapDrop: string[] | null; SecurityOpt: string[] | null; NanoCpus: number; Memory: number;
        PidsLimit: number | null; PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> | null };
    }>;
    if (!c) return undefined;
    const h = c.HostConfig;
    const ports = Object.entries(h.PortBindings ?? {}).flatMap(([p, b]) => b.map((x) => `${x.HostIp}:${x.HostPort}->${p}`));
    return { image: c.Config.Image, user: c.Config.User, cap_drop: h.CapDrop ?? [], security_opt: h.SecurityOpt ?? [],
      nano_cpus: h.NanoCpus, memory_bytes: h.Memory, pids_limit: h.PidsLimit ?? 0, ports, labels: c.Config.Labels ?? {} };
  } catch {
    return undefined;
  }
}

/** Removes one container and its anonymous volumes. Safe to call when it is already gone. */
export async function stopApp(run: Runner, name: string): Promise<void> {
  await run('docker', ['rm', '--force', '--volumes', name], { timeoutMs: 60000 });
}

/** Removes every container carrying the Bumpproof label (and only those). Returns how many. */
export async function removeLabelled(run: Runner, cfg: Config): Promise<number> {
  const r = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=${cfg.sandbox.label}`], { timeoutMs: 30000 });
  const ids = r.stdout.split(/\s+/).filter(Boolean);
  if (ids.length > 0) await run('docker', ['rm', '--force', '--volumes', ...ids], { timeoutMs: 120000 });
  return ids.length;
}

/**
 * Starts one side and waits until it answers HTTP on 127.0.0.1:<port>, or fails.
 * Host problems (disk, busy port, Docker refusing) throw SandboxError; app problems return built=false.
 * The container is left running on success; the caller stops it with `stopApp`.
 */
export async function startApp(d: SandboxDeps, a: Omit<RunArgs, 'script' | 'user'>): Promise<SideResult> {
  const { cfg, run } = d;
  const s = cfg.sandbox;
  const t0 = d.now();
  const secs = () => Math.round((d.now() - t0) / 100) / 10;
  const free = diskFreeGb(cfg, d.freeBytes);
  if (free < s.min_free_gb) throw new SandboxError('disk', `${free.toFixed(1)} GB free, ${s.min_free_gb} GB needed`);
  if (!(await d.isPortFree(cfg.port))) throw new SandboxError('port', `127.0.0.1:${cfg.port} is in use`);
  const plan = planApp(a.appDir, cfg);
  if ('problem' in plan) return { side: a.side, built: false, failed_at: 'plan', plan_problem: plan.problem, seconds: secs(), log_tail: [] };

  const started = await run('docker', dockerRunArgs(cfg, { ...a, user: sandboxUser(cfg), script: setupScript(plan) }), {
    timeoutMs: s.setup_timeout_s * 1000,
  });
  if (!started.ok) {
    await stopApp(run, a.name);
    throw new SandboxError('docker', (started.stderr || started.error || '').trim().split('\n').pop() ?? 'docker run failed');
  }
  const url = `http://127.0.0.1:${cfg.port}${s.health_path}`;
  const setupDeadline = t0 + s.setup_timeout_s * 1000;
  let serveSince: number | undefined;
  const done = async (built: boolean, failed_at?: FailedAt, exit_code?: number | null): Promise<SideResult> => {
    const l = await logs(run, a.name);
    const sandbox = await inspectFacts(run, a.name);
    return { side: a.side, built, ...(failed_at ? { failed_at, exit_code } : {}), seconds: secs(), plan,
      log_tail: built ? [] : tail(l.all, s.log_tail_lines), ...(sandbox ? { sandbox } : {}) };
  };
  for (;;) {
    const st = await state(run, a.name);
    const phase = lastPhase((await logs(run, a.name)).out);
    if (!st.running) return done(false, phase ?? 'start', st.exit);
    if (phase === 'serve') {
      serveSince ??= d.now();
      const code = await d.probe(url);
      if (code !== undefined && code <= s.health_max_status) return done(true);
      if (d.now() - serveSince > s.serve_timeout_s * 1000) return done(false, 'health', null);
    } else if (d.now() > setupDeadline) {
      return done(false, phase ?? 'start', null);
    }
    await d.sleep(s.poll_ms);
  }
}

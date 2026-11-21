// A stand-in for the docker binary: each poll of the container moves one step along a scripted timeline.
// Calls to other binaries (git, tar) go to the real runner, so git plumbing is tested for real.
import { loadConfig, type Config } from '../../src/config.ts';
import { run as realRun, type ProcResult, type Runner } from '../../src/proc.ts';
import type { SandboxDeps } from '../../src/sandbox.ts';

export interface Step {
  running: boolean;
  exit?: number;
  /** Container stdout so far (phase markers live here). */
  out: string;
  err?: string;
}

export interface FakeDocker {
  run: Runner;
  calls: string[][];
  deps: (over?: Partial<SandboxDeps>) => SandboxDeps;
}

const ok = (stdout = ''): ProcResult => ({ ok: true, code: 0, stdout, stderr: '' });

/** `timelines` holds one timeline per container started, in start order. */
export function fakeDocker(timelines: Step[][], opts: { runFails?: boolean; probe?: number | undefined; cfg?: Config } = {}): FakeDocker {
  const calls: string[][] = [];
  let container = -1;
  let i = 0;
  let clock = 0;
  const cfg = opts.cfg ?? loadConfig('/nonexistent');
  const step = (): Step => {
    const tl = timelines[container] ?? [];
    return tl[Math.min(i, tl.length - 1)] ?? { running: false, exit: 1, out: '' };
  };
  const run: Runner = async (cmd, args, o) => {
    if (cmd !== 'docker') return realRun(cmd, args, o);
    calls.push(args);
    const [verb] = args;
    if (verb === 'run') {
      if (opts.runFails) return { ok: false, code: 125, stdout: '', stderr: 'docker: Error response from daemon: pull access denied' };
      container++;
      i = 0;
      return ok('abc123\n');
    }
    if (verb === 'inspect' && args[1] === '--format') {
      const s = step();
      i++;
      return ok(`${s.running} ${s.exit ?? 0}\n`);
    }
    if (verb === 'inspect') {
      const c = { Config: { Image: cfg.sandbox.image, User: '1000:1000', Labels: { bumpproof: '1' } },
        HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NanoCpus: 2e9, Memory: 3221225472, PidsLimit: 512,
          PortBindings: { '4173/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } } };
      return ok(JSON.stringify([c]));
    }
    if (verb === 'logs') {
      const s = timelines[container]?.[Math.max(0, i - 1)] ?? step();
      return { ok: true, code: 0, stdout: s.out, stderr: s.err ?? '' };
    }
    if (verb === 'ps') return ok('');
    return ok();
  };
  const deps = (over: Partial<SandboxDeps> = {}): SandboxDeps => ({
    cfg,
    run,
    freeBytes: () => 100e9,
    probe: async () => ('probe' in opts ? opts.probe : 200),
    isPortFree: async () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  });
  return { run, calls, deps };
}

export const MARK = '##bumpproof phase=';
export const phases = (...p: string[]) => p.map((x) => `${MARK}${x}`).join('\n');

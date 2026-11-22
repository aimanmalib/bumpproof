import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deepMerge, loadConfig, type Config, type JsonObject } from '../src/config.ts';
import {
  dockerRunArgs, lastPhase, planApp, removeLabelled, sandboxUser, SandboxError, setupScript, startApp, tail,
} from '../src/sandbox.ts';
import { fakeDocker, phases } from './support/fake-docker.ts';

const base = loadConfig('/nonexistent');
const cfgWith = (over: JsonObject): Config => deepMerge(base as unknown as JsonObject, over) as unknown as Config;

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-plan-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const pkg = (o: object) => JSON.stringify(o);

test('planApp picks npm ci with --ignore-scripts from package-lock.json and the vite preset for serving', () => {
  const dir = app({ 'package.json': pkg({ scripts: { build: 'vite build', preview: 'vite preview --host 127.0.0.1' },
    devDependencies: { vite: '6.4.6' } }), 'package-lock.json': '{}' });
  const plan = planApp(dir, base);
  assert.ok(!('problem' in plan));
  assert.equal(plan.pm, 'npm');
  assert.match(plan.install, /^npm ci .*--ignore-scripts/);
  assert.equal(plan.build, 'npm run build');
  // The app's own preview script binds 127.0.0.1, which is unreachable through the port mapping; the preset binds 0.0.0.0.
  assert.match(plan.serve, /vite preview --host 0\.0\.0\.0 --port 4173 --strictPort/);
});

test('planApp: yarn and pnpm installs are frozen and skip scripts', () => {
  for (const [lock, pm] of [['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm']] as const) {
    const plan = planApp(app({ 'package.json': pkg({ scripts: { start: 'node s.js' } }), [lock]: '' }), base);
    assert.ok(!('problem' in plan));
    assert.equal(plan.pm, pm);
    assert.match(plan.install, /--frozen-lockfile/);
    assert.match(plan.install, /--ignore-scripts/);
    assert.equal(plan.build, '');
    assert.equal(plan.serve, `corepack ${pm} run start`);
  }
});

test('planApp reports why an app cannot be planned', () => {
  assert.deepEqual(planApp(app({}), base), { problem: 'no_package_json' });
  assert.deepEqual(planApp(app({ 'package.json': '{oops' }), base), { problem: 'bad_package_json' });
  assert.deepEqual(planApp(app({ 'package.json': pkg({ scripts: { start: 'x' } }) }), base), { problem: 'no_lockfile' });
  assert.deepEqual(planApp(app({ 'package.json': pkg({}), 'package-lock.json': '{}' }), base), { problem: 'no_serve' });
});

test('planApp: app.* config wins over detection', () => {
  const cfg = cfgWith({ app: { build: 'make site', serve: 'node serve.js --port {port}' } });
  const plan = planApp(app({ 'package.json': pkg({ scripts: { build: 'x', start: 'y' } }), 'package-lock.json': '{}' }), cfg);
  assert.ok(!('problem' in plan));
  assert.equal(plan.build, 'make site');
  assert.equal(plan.serve, 'node serve.js --port 4173');
});

test('setupScript marks each phase and execs the server', () => {
  const s = setupScript({ pm: 'npm', install: 'npm ci --ignore-scripts', build: '', serve: 'npm run start' });
  assert.equal(lastPhase(s.split('\n').filter((l) => l.startsWith('echo')).map((l) => l.slice(6, -1)).join('\n')), 'serve');
  assert.match(s, /^set -e\n/);
  assert.match(s, /\n:\n/);
  assert.match(s, /\nexec npm run start$/);
});

test('lastPhase reads the latest marker and ignores look-alikes', () => {
  assert.equal(lastPhase(''), undefined);
  assert.equal(lastPhase(`${phases('install', 'build')}\nnpm ERR! x`), 'build');
  assert.equal(lastPhase('  ##bumpproof phase=serve\n##bumpproof phase=nope'), undefined);
});

test('dockerRunArgs carries every D7 flag and nothing from the host environment', () => {
  const args = dockerRunArgs(base, { name: 'bumpproof-r-head', runId: 'r', side: 'head', appDir: '/w/head', user: '1000:1000', script: 'true' });
  const joined = args.join(' ');
  for (const flag of ['--user 1000:1000', '--cap-drop ALL', '--security-opt no-new-privileges', '--cpus=2', '--memory=3g',
    '--pids-limit=512', '--publish 127.0.0.1:4173:4173', '--label bumpproof=1', '--label bumpproof.run=r', '--volume /w/head:/app']) {
    assert.ok(joined.includes(flag), `missing ${flag}`);
  }
  assert.ok(!joined.includes('--privileged'));
  assert.ok(!args.includes('--env-file'));
  assert.ok(!/(^| )-p (?!127\.0\.0\.1)/.test(joined), 'port must bind 127.0.0.1 only');
  const envs = args.flatMap((a, i) => (args[i - 1] === '--env' ? [a.split('=')[0]] : []));
  assert.deepEqual(envs.sort(), ['CI', 'COREPACK_HOME', 'HOME', 'HOST', 'NODE_ENV', 'PORT', 'npm_config_cache', 'npm_config_update_notifier']);
  assert.equal(args.at(-4), base.sandbox.image);
});

test('sandboxUser never picks root', () => {
  assert.equal(sandboxUser(base, 1000, 1000), '1000:1000');
  assert.equal(sandboxUser(base, 0, 0), 'node');
  assert.equal(sandboxUser(cfgWith({ sandbox: { user: '2000:2000' } }), 0, 0), '2000:2000');
});

test('tail drops markers and blank lines', () => {
  assert.deepEqual(tail(`a\n\n${phases('build')}\nb\nc`, 2), ['b', 'c']);
});

const shop = () => app({ 'package.json': pkg({ scripts: { build: 'b', start: 's' } }), 'package-lock.json': '{}' });
const args = (appDir: string) => ({ name: 'bumpproof-t-head', runId: 't', side: 'head' as const, appDir });

test('startApp: answers on the port = built, with the applied flags recorded', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install') }, { running: true, out: phases('install', 'build', 'serve') }]]);
  const r = await startApp(fd.deps(), args(shop()));
  assert.equal(r.built, true);
  assert.equal(r.failed_at, undefined);
  assert.deepEqual(r.sandbox?.cap_drop, ['ALL']);
  assert.deepEqual(r.log_tail, []);
});

test('startApp: a build that exits non-zero is a failed build, with the log tail kept', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install') },
    { running: false, exit: 1, out: phases('install', 'build'), err: 'Error: broken on purpose' }]]);
  const r = await startApp(fd.deps(), args(shop()));
  assert.equal(r.built, false);
  assert.equal(r.failed_at, 'build');
  assert.equal(r.exit_code, 1);
  assert.ok(r.log_tail.some((l) => l.includes('broken on purpose')));
});

test('startApp: install failure and a server that exits are told apart', async () => {
  const inst = await startApp(fakeDocker([[{ running: false, exit: 1, out: phases('install') }]]).deps(), args(shop()));
  assert.equal(inst.failed_at, 'install');
  const srv = await startApp(fakeDocker([[{ running: false, exit: 1, out: phases('install', 'build', 'serve') }]]).deps(), args(shop()));
  assert.equal(srv.failed_at, 'serve');
});

test('startApp: a server that never answers fails on health after serve_timeout_s', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install', 'build', 'serve') }]], { probe: undefined });
  const r = await startApp(fd.deps(), args(shop()));
  assert.equal(r.failed_at, 'health');
  assert.ok(r.seconds > base.sandbox.serve_timeout_s);
});

test('startApp: a 5xx answer is not healthy', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install', 'build', 'serve') }]], { probe: 502 });
  assert.equal((await startApp(fd.deps(), args(shop()))).failed_at, 'health');
});

test('startApp: setup that runs past setup_timeout_s fails at the phase it was in', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install') }]]);
  const r = await startApp(fd.deps(), args(shop()));
  assert.equal(r.failed_at, 'install');
});

test('startApp refuses to start on low disk or a busy port, before touching Docker', async () => {
  const fd = fakeDocker([]);
  await assert.rejects(startApp(fd.deps({ freeBytes: () => 10e9 }), args(shop())), (e) => e instanceof SandboxError && e.code === 'disk');
  await assert.rejects(startApp(fd.deps({ isPortFree: async () => false }), args(shop())), (e) => e instanceof SandboxError && e.code === 'port');
  assert.equal(fd.calls.length, 0);
});

test('startApp waits for a port another program holds for a while, then starts', async () => {
  const fd = fakeDocker([[{ running: true, out: phases('install', 'build', 'serve') }]]);
  let busy = 3;
  const r = await startApp(fd.deps({ isPortFree: async () => busy-- <= 0 }), args(shop()));
  assert.equal(r.built, true);
  assert.equal(busy, -1, 'asked until the port was free');
});

test('startApp: Docker refusing to run is a host problem, and the half-made container is removed', async () => {
  const fd = fakeDocker([], { runFails: true });
  await assert.rejects(startApp(fd.deps(), args(shop())), (e) => e instanceof SandboxError && e.code === 'docker');
  assert.deepEqual(fd.calls.at(-1)?.slice(0, 3), ['rm', '--force', '--volumes']);
});

test('startApp: an app that cannot be planned never starts a container', async () => {
  const fd = fakeDocker([]);
  const r = await startApp(fd.deps(), args(app({ 'package.json': pkg({ scripts: { start: 's' } }) })));
  assert.equal(r.failed_at, 'plan');
  assert.equal(r.plan_problem, 'no_lockfile');
  assert.equal(fd.calls.length, 0);
});

test('removeLabelled filters on the Bumpproof label only', async () => {
  const fd = fakeDocker([]);
  await removeLabelled(fd.run, base);
  assert.deepEqual(fd.calls[0], ['ps', '--all', '--quiet', '--filter', 'label=bumpproof=1']);
  assert.equal(fd.calls.length, 1, 'nothing to remove means no rm call');
});

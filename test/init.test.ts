import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, type Io } from '../src/cli.ts';
import { loadConfig, loadDefaults } from '../src/config.ts';
import { fileRoute, findRoutes, routeSlug } from '../src/init.ts';

function io(cwd: string, env: NodeJS.ProcessEnv = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s), env, cwd, isTTY: false };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A small Vite + React Router app: lockfile, build script, three routes (one with a parameter). */
function viteApp(root: string): void {
  write(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'vite build' }, dependencies: { 'react-router-dom': '6.0.0' }, devDependencies: { vite: '5.0.0' },
  }));
  write(join(root, 'package-lock.json'), '{}');
  write(join(root, 'src', 'App.jsx'), [
    '<Route path="/" element={<Home />} />',
    '<Route path="/account" element={<Account />} />',
    '<Route path="/orders/:id" element={<Order />} />',
    '<Link to="/account">Account</Link>',
    '<a href="/about">About</a>',
  ].join('\n'));
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bumpproof-init-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('init writes a config that check can load and three draft journeys', withTmp(async (dir) => {
  viteApp(dir);
  const o = io(dir);
  assert.equal(await main(['init'], o), 0, o.stderr.join('\n'));
  const cfg = loadConfig(dir);
  const port = cfg.port;
  assert.match(cfg.app.install, /^npm ci /);
  assert.equal(cfg.app.build, 'npm run build');
  assert.match(cfg.app.serve, /vite preview .*--port \{port\}/, 'the port stays a placeholder');
  const jdir = join(dir, cfg.kane.journeys_dir);
  assert.deepEqual(readdirSync(jdir).sort(), ['account_test.md', 'home_test.md', 'nav_test.md']);
  const account = readFileSync(join(jdir, 'account_test.md'), 'utf8');
  assert.match(account, new RegExp(`url: http://127\\.0\\.0\\.1:${port}/account\\n`));
  assert.doesNotMatch(account + readFileSync(join(jdir, 'home_test.md'), 'utf8'), /\{(port|path)\}/);
  assert.match(o.stdout.join('\n'), /Routes in the source: \/account, \/, \/about/);
  assert.match(o.stdout.join('\n'), /drafts/);
}));

test('init refuses to replace an existing config unless --force, and keeps edited journeys', withTmp(async (dir) => {
  viteApp(dir);
  assert.equal(await main(['init'], io(dir)), 0);
  const home = join(dir, loadConfig(dir).kane.journeys_dir, 'home_test.md');
  writeFileSync(home, 'edited');
  const again = io(dir);
  assert.equal(await main(['init'], again), 2);
  assert.match(again.stderr[0] ?? '', /already exists/);
  assert.equal(readFileSync(home, 'utf8'), 'edited');
  const forced = io(dir);
  assert.equal(await main(['init', '--force'], forced), 0);
  assert.notEqual(readFileSync(home, 'utf8'), 'edited');
}));

test('init with --dir writes the config at the top and the journeys in the app folder', withTmp(async (dir) => {
  viteApp(join(dir, 'web'));
  const o = io(dir, { BUMPPROOF_LANG: 'ms' });
  assert.equal(await main(['init', '--dir', 'web'], o), 0);
  assert.equal(loadConfig(dir).app.dir, 'web');
  assert.ok(existsSync(join(dir, 'web', '.bumpproof', 'journeys', 'home_test.md')));
  assert.match(o.stdout.join('\n'), /Perjalanan ini draf/);
}));

test('init writes nothing when the app cannot be planned or the folder leaves the repository', withTmp(async (dir) => {
  write(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  const o = io(dir);
  assert.equal(await main(['init'], o), 2);
  assert.match(o.stderr[0] ?? '', /no lockfile/);
  assert.equal(existsSync(join(dir, '.bumpproof')), false);
  const up = io(dir);
  assert.equal(await main(['init', '--dir', '../x'], up), 2);
  assert.match(up.stderr[0] ?? '', /must stay inside/);
}));

test('routes from Next file routers skip parameters, API routes and private files', withTmp((dir) => {
  const ic = loadDefaults() as unknown as { init: Parameters<typeof fileRoute>[1] };
  assert.equal(fileRoute(join('app', 'page.tsx'), ic.init), '/');
  assert.equal(fileRoute(join('app', '(shop)', 'cart', 'page.tsx'), ic.init), '/cart');
  assert.equal(fileRoute(join('app', 'cart', 'layout.tsx'), ic.init), undefined);
  assert.equal(fileRoute(join('app', 'blog', '[slug]', 'page.tsx'), ic.init), undefined);
  assert.equal(fileRoute(join('pages', 'index.js'), ic.init), '/');
  assert.equal(fileRoute(join('pages', 'pricing.js'), ic.init), '/pricing');
  assert.equal(fileRoute(join('pages', '_app.js'), ic.init), undefined);
  assert.equal(fileRoute(join('pages', 'api', 'hello.js'), ic.init), undefined);
  write(join(dir, 'app', 'settings', 'page.tsx'), 'export default () => null');
  write(join(dir, 'node_modules', 'x', 'src', 'y.js'), 'path: "/hidden"');
  assert.deepEqual(findRoutes(dir, ic.init), ['/settings']);
  assert.equal(routeSlug('/account/orders'), 'account-orders');
  assert.equal(routeSlug('/nav'), 'page-nav');
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

test('demo shop pins every dependency to an exact version', () => {
  const pkg = JSON.parse(read('examples/shop/package.json')) as Record<string, Record<string, string>>;
  const all = { ...pkg['dependencies'], ...pkg['devDependencies'] };
  assert.ok(Object.keys(all).length > 0);
  for (const [name, range] of Object.entries(all)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${range}`);
  }
});

test('demo shop lockfile matches package.json', () => {
  const pkg = JSON.parse(read('examples/shop/package.json')) as Record<string, Record<string, string>>;
  const lock = JSON.parse(read('examples/shop/package-lock.json')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  const all = { ...pkg['dependencies'], ...pkg['devDependencies'] };
  for (const [name, version] of Object.entries(all)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} in lockfile`);
  }
});

test('dependabot watches the demo shop and ignores the framework itself', () => {
  const yml = read('.github/dependabot.yml');
  assert.match(yml, /package-ecosystem: npm/);
  assert.match(yml, /directory: "\/examples\/shop"/);
  assert.match(yml, /open-pull-requests-limit: \d+/);
  for (const name of ['react', 'react-dom', 'vite', '"@vitejs/plugin-react"']) {
    assert.ok(yml.includes(`dependency-name: ${name}\n`), `ignores ${name}`);
  }
});

test('demo shop serves on the sandbox port from config', () => {
  const pkg = JSON.parse(read('examples/shop/package.json')) as { scripts: Record<string, string> };
  const { port } = JSON.parse(read('config/defaults.json')) as { port: number };
  assert.ok(pkg.scripts['preview']?.includes(`--host 127.0.0.1 --port ${port} --strictPort`));
});

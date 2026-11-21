import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deepMerge, expandHome, loadConfig, loadDefaults } from '../src/config.ts';

test('defaults hold the values the code reads (shape, not owner data)', () => {
  const d = loadDefaults();
  for (const k of ['schema_version', 'lang', 'languages', 'port', 'sandbox', 'kane', 'fixer', 'doctor', 'publish']) {
    assert.ok(k in d, `defaults.json is missing ${k}`);
  }
  const cfg = loadConfig(tmpdir());
  assert.equal(typeof cfg.port, 'number');
  assert.equal(typeof cfg.sandbox.min_free_gb, 'number');
  assert.equal(typeof cfg.fixer.model, 'string');
  assert.ok(Array.isArray(cfg.kane.chrome_names));
});

test('deepMerge merges objects and replaces arrays and scalars', () => {
  const out = deepMerge({ a: { b: 1, c: 2 }, l: [1, 2], s: 'x' }, { a: { c: 3 }, l: [9], s: 'y' });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, l: [9], s: 'y' });
});

test('project .bumpproof/config.json overrides defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-cfg-'));
  try {
    mkdirSync(join(dir, '.bumpproof'));
    writeFileSync(join(dir, '.bumpproof', 'config.json'), JSON.stringify({ port: 5000, sandbox: { min_free_gb: 1 } }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.port, 5000);
    assert.equal(cfg.sandbox.min_free_gb, 1);
    assert.equal(cfg.sandbox.image, loadConfig(tmpdir()).sandbox.image, 'untouched keys keep defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a project config that is not an object is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-cfg-'));
  try {
    mkdirSync(join(dir, '.bumpproof'));
    writeFileSync(join(dir, '.bumpproof', 'config.json'), '[1]');
    assert.throws(() => loadConfig(dir), /must hold an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandHome only expands a leading ~', () => {
  assert.equal(expandHome('~/x', '/h'), '/h/x');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('/a/~/b', '/h'), '/a/~/b');
});

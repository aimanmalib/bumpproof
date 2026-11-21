import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findInDir, resolveChrome } from '../src/chrome.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { parseCredits, renderChecks, runChecks } from '../src/doctor.ts';
import { makeTranslator } from '../src/i18n.ts';
import type { ProcResult, Runner } from '../src/proc.ts';
import { makePaint } from '../src/ui.ts';

const SECRET_IDENTITY = 'someone@private.test';

function fakeRunner(table: Record<string, Partial<ProcResult>>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const hit = Object.entries(table).find(([k]) => key.startsWith(k));
    if (!hit) return { ok: false, code: null, stdout: '', stderr: '', error: 'ENOENT' };
    return { ok: true, code: 0, stdout: '', stderr: '', ...hit[1] };
  };
  return { run, calls };
}

function cfgWithChrome(chrome: string): Config {
  const cfg = loadConfig(tmpdir());
  cfg.kane.chrome_path = chrome;
  return cfg;
}

const allGood = {
  'docker version': { stdout: '27.3.1\n' },
  'kane-cli --version': { stdout: '0.10.7\n' },
  'kane-cli whoami': { stdout: `${SECRET_IDENTITY}\n` },
  'kane-cli balance': { stdout: 'Credits: 9,876.5 remaining\n' },
  '/opt/chrome --version': { stdout: 'Google Chrome for Testing 158.0\n' },
  'gh auth status': { stdout: `Logged in as ${SECRET_IDENTITY}\n` },
  'claude --version': { stdout: '2.0.0 (Claude Code)\n' },
};

test('all checks pass when every tool answers', async () => {
  const t = makeTranslator('en');
  const { run } = fakeRunner(allGood);
  const checks = await runChecks({ cfg: cfgWithChrome('/opt/chrome'), t, run, env: {}, nodeVersion: 'v22.23.1', freeBytes: () => 40e9 });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(checks.find((c) => c.id === 'kane_balance')?.detail, '9876.5 credits');
  const text = renderChecks(checks, t, makePaint(false));
  assert.match(text, /All 9 checks passed/);
  assert.ok(!text.includes(SECRET_IDENTITY), 'identity output from whoami / gh must never be printed');
});

test('missing Kane login, old Node and low disk each fail on their own line', async () => {
  const t = makeTranslator('en');
  const table: Record<string, Partial<ProcResult>> = { ...allGood };
  table['kane-cli whoami'] = { ok: false, code: 1, stderr: `not logged in as ${SECRET_IDENTITY}` };
  table['kane-cli balance'] = { ok: false, code: 2 };
  const { run } = fakeRunner(table);
  const checks = await runChecks({ cfg: cfgWithChrome('/opt/chrome'), t, run, env: {}, nodeVersion: 'v18.19.0', freeBytes: () => 10e9 });
  const failed = checks.filter((c) => !c.ok).map((c) => c.id).sort();
  assert.deepEqual(failed, ['disk', 'kane_balance', 'kane_login', 'node']);
  const text = renderChecks(checks, t, makePaint(false));
  assert.match(text, /4 of 9 checks failed/);
  assert.ok(!text.includes(SECRET_IDENTITY));
});

test('a tool that is not installed reads "not found"', async () => {
  const t = makeTranslator('en');
  const { run } = fakeRunner({});
  const checks = await runChecks({ cfg: cfgWithChrome('/opt/chrome'), t, run, env: {}, nodeVersion: 'v22.0.0', freeBytes: () => 99e9 });
  assert.equal(checks.find((c) => c.id === 'kane_version')?.detail, 'not found');
  assert.equal(checks.find((c) => c.id === 'docker')?.ok, false);
});

test('Malay output translates every label and the summary', async () => {
  const t = makeTranslator('ms');
  const { run } = fakeRunner(allGood);
  const checks = await runChecks({ cfg: cfgWithChrome('/opt/chrome'), t, run, env: {}, nodeVersion: 'v22.23.1', freeBytes: () => 40e9 });
  const text = renderChecks(checks, t, makePaint(false));
  assert.match(text, /Semua 9 semakan lulus/);
  assert.match(text, /Log masuk Kane CLI/);
});

test('parseCredits reads the first number and handles none', () => {
  assert.equal(parseCredits('Balance: 10,000 credits'), 10000);
  assert.equal(parseCredits('12.5'), 12.5);
  assert.equal(parseCredits('no balance'), undefined);
});

test('Chrome resolution: env beats config beats Chrome for Testing dir beats PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-chrome-'));
  try {
    const bin = join(dir, 'chrome', 'linux-1.0', 'chrome-linux64');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'chrome'), '#!/bin/sh\n');
    chmodSync(join(bin, 'chrome'), 0o755);
    const pathDir = join(dir, 'bin');
    mkdirSync(pathDir);
    writeFileSync(join(pathDir, 'chromium'), '#!/bin/sh\n');
    chmodSync(join(pathDir, 'chromium'), 0o755);

    const cfg = loadConfig(tmpdir());
    cfg.kane.chrome_path = '';
    cfg.kane.chrome_dir = dir;
    assert.equal(findInDir(dir), join(bin, 'chrome'));
    assert.deepEqual(resolveChrome(cfg, { KANE_CLI_CHROME_PATH: '/x/chrome' }), { path: '/x/chrome', source: 'env' });
    assert.equal(resolveChrome(cfg, { PATH: pathDir })?.source, 'chrome_dir');
    cfg.kane.chrome_dir = join(dir, 'empty');
    assert.deepEqual(resolveChrome(cfg, { PATH: pathDir }), { path: join(pathDir, 'chromium'), source: 'path' });
    assert.equal(resolveChrome(cfg, { PATH: '' }), undefined);
    cfg.kane.chrome_path = '/cfg/chrome';
    assert.equal(resolveChrome(cfg, { PATH: pathDir })?.source, 'config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool that hangs past the timeout is reported as timed out', async () => {
  const t = makeTranslator('en');
  const table: Record<string, Partial<ProcResult>> = { ...allGood };
  table['kane-cli --version'] = { ok: false, code: null, error: 'TIMEOUT' };
  const { run } = fakeRunner(table);
  const checks = await runChecks({ cfg: cfgWithChrome('/opt/chrome'), t, run, env: {}, nodeVersion: 'v22.0.0', freeBytes: () => 99e9 });
  assert.deepEqual(checks.find((c) => c.id === 'kane_version'), { id: 'kane_version', ok: false, detail: 'timed out' });
});

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCanary } from '../src/canary.ts';
import { deepMerge, loadConfig, type Config, type JsonObject } from '../src/config.ts';
import { run as realRun, type Runner } from '../src/proc.ts';
import { tempDir } from './support/tmp.ts';

const base = loadConfig('/nonexistent');
const home = () => tempDir('bumpproof-home-');
const json = (o: object) => JSON.stringify(o);

test('canary passes when the agent is refused and the token stays out', async () => {
  const h = home();
  const run: Runner = async () => ({ ok: true, code: 0, stderr: '',
    stdout: json({ is_error: false, result: 'The read was blocked.', permission_denials: [{ tool_name: 'Read' }] }) });
  const r = await runCanary({ cfg: base, run, env: {}, home: h, now: () => new Date('2026-11-21T23:00:00Z') });
  assert.equal(r.status, 'pass');
  assert.equal(r.mode, 'host');
  assert.deepEqual(r.denied_tools, ['Read']);
  assert.equal(r.date, '2026-11-21T23:00:00.000Z');
  const file = join(h, '.cache/bumpproof/kanari.txt');
  assert.match(readFileSync(file, 'utf8'), /^BUMPPROOF-CANARY-[0-9a-f]{32}\n$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('canary fails over to container mode when the token reaches a file in the working copy', async () => {
  const h = home();
  const run: Runner = async (_c, _a, opts) => {
    writeFileSync(join(opts!.cwd!, 'canary-out.txt'), readFileSync(join(h, '.cache/bumpproof/kanari.txt')));
    return { ok: true, code: 0, stdout: json({ is_error: false, result: 'copied' }), stderr: '' };
  };
  const r = await runCanary({ cfg: base, run, env: {}, home: h });
  assert.equal(r.status, 'leak');
  assert.equal(r.mode, 'container');
});

test('canary fails over when the token only appears in the reply', async () => {
  const h = home();
  const run: Runner = async () => ({ ok: true, code: 0, stderr: '',
    stdout: json({ is_error: false, result: readFileSync(join(h, '.cache/bumpproof/kanari.txt'), 'utf8') }) });
  assert.equal((await runCanary({ cfg: base, run, env: {}, home: h })).status, 'leak');
});

test('canary reports an error, not a pass, when the agent never ran', async () => {
  const run: Runner = async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'ENOENT' });
  const r = await runCanary({ cfg: base, run, env: {}, home: home() });
  assert.equal(r.status, 'error');
  assert.equal(r.detail, 'ENOENT');
});

test('canary always tests host mode, even when config says container', async () => {
  const cfg = deepMerge(base as unknown as JsonObject, { fixer: { mode: 'container' } }) as unknown as Config;
  let cmd = '';
  const run: Runner = async (c) => { cmd = c; return { ok: true, code: 0, stdout: json({ is_error: false, result: 'no' }), stderr: '' }; };
  await runCanary({ cfg, run, env: {}, home: home() });
  assert.equal(cmd, 'claude');
});

// Real Claude Code run. Opt-in: it spends model tokens. `BUMPPROOF_KANARI=1 node --test test/canary.test.ts`
test('live canary with the installed claude CLI', { skip: process.env.BUMPPROOF_KANARI !== '1' }, async () => {
  const r = await runCanary({ cfg: base, run: realRun, env: process.env });
  assert.equal(r.status, 'pass', r.detail);
});

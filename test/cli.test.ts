import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMMANDS, main, version, type Io } from '../src/cli.ts';
import { ROOT } from '../src/config.ts';
import { useColor, makePaint } from '../src/ui.ts';

function io(env: NodeJS.ProcessEnv = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s), env, cwd: tmpdir(), isTTY: false };
}

test('--help lists every command in English and Malay', async () => {
  const en = io();
  assert.equal(await main(['--help'], en), 0);
  for (const c of COMMANDS) assert.match(en.stdout.join('\n'), new RegExp(`\\b${c}\\b`));
  const ms = io({ BUMPPROOF_LANG: 'ms' });
  assert.equal(await main(['--help'], ms), 0);
  assert.match(ms.stdout.join('\n'), /Guna: bumpproof/);
});

test('--version prints the package version', async () => {
  const o = io();
  assert.equal(await main(['--version'], o), 0);
  assert.equal(o.stdout[0], version());
});

test('unknown command and unsupported language exit 2', async () => {
  const a = io();
  assert.equal(await main(['frobnicate'], a), 2);
  assert.match(a.stderr[0] ?? '', /Unknown command: frobnicate/);
  const b = io();
  assert.equal(await main(['--lang', 'xx', 'doctor'], b), 2);
  assert.match(b.stderr[0] ?? '', /Unsupported language 'xx'/);
});

test('a listed command that is not built yet exits non-zero, so scripts and CI notice', async () => {
  const o = io();
  assert.equal(await main(['init'], o), 2);
  assert.match(o.stderr[0] ?? '', /'init' command is not built yet/);
});

test('census without --find or --run says which one to use; a bad --limit is refused', async () => {
  const o = io();
  assert.equal(await main(['census'], o), 2);
  assert.match(o.stderr[0] ?? '', /--find .* --run/);
  const b = io();
  assert.equal(await main(['census', '--run', '--limit', '0'], b), 2);
  assert.match(b.stderr[0] ?? '', /--limit/);
});

test('no arguments prints help and exits 1', async () => {
  const o = io();
  assert.equal(await main([], o), 1);
  assert.match(o.stdout[0] ?? '', /Usage/);
});

test('NO_COLOR turns colour off; FORCE_COLOR turns it on', () => {
  assert.equal(useColor({ NO_COLOR: '1' }, true), false);
  assert.equal(useColor({ FORCE_COLOR: '1' }, false), true);
  assert.equal(useColor({}, false), false);
  assert.equal(makePaint(false).ok('x'), 'x');
  assert.notEqual(makePaint(true).ok('x'), 'x');
});

test('the source entry point runs as a script', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), version());
});

test('the entry point also runs through a symlink, as npm installs the bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-bin-'));
  try {
    const link = join(dir, 'bumpproof.ts');
    symlinkSync(join(ROOT, 'src', 'cli.ts'), link);
    const r = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), version());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check needs both refs, and a bad ref is a git error, not a crash', async () => {
  const a = io();
  assert.equal(await main(['check', '--base', 'main'], a), 2);
  assert.match(a.stderr.join('\n'), /--base <ref> and --head <ref>/);
  const b = io();
  b.cwd = mkdtempSync(join(tmpdir(), 'bumpproof-nogit-'));
  assert.equal(await main(['check', '--base', 'a', '--head', 'b', '--repo', b.cwd], b), 2);
  assert.match(b.stderr.join('\n'), /^Git error: /);
  rmSync(b.cwd, { recursive: true, force: true });
});

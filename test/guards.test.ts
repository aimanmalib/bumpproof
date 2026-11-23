// "The agent cannot cheat": every patch guard has a case that must be rejected.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import {
  checkGuards, diffTrees, globToRegExp, lineDiff, packageJsonProblems, renderPatch, restoreTree, snapshotTree,
  type GuardRule,
} from '../src/guards.ts';
import { tempDir } from './support/tmp.ts';

const cfg = loadConfig('/nonexistent');
const PKG = JSON.stringify({ name: 'shop', scripts: { build: 'vite build' }, dependencies: { 'date-fns': '4.4.0', react: '18.3.1' } }, null, 2);
const NOTE = 'BUMPPROOF_FIX.md';

function app(files: Record<string, string>): string {
  const dir = tempDir('bumpproof-guard-');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const START = {
  'package.json': PKG,
  'src/date.js': "import { format } from 'date-fns';\nexport const show = (d) => format(d, 'yyyy-MM-dd');\n",
  '.bumpproof/journeys/checkout_test.md': '# Checkout\n- add to cart\n',
  'src/cart.test.js': 'test("x", () => {});\n',
  'node_modules/date-fns/index.js': 'skipped\n',
};

/** Applies `edit` to a fresh app and returns the rules the guards raise. */
function rulesAfter(edit: (dir: string) => void, withNote = true): GuardRule[] {
  const dir = app(START);
  const before = snapshotTree(dir, cfg.fixer.snapshot_skip);
  edit(dir);
  if (withNote) writeFileSync(join(dir, NOTE), 'Changed format call. Release notes: "format now ..."\n');
  const after = snapshotTree(dir, cfg.fixer.snapshot_skip);
  return [...new Set(checkGuards(before, after, diffTrees(before, after), cfg).map((v) => v.rule))].sort();
}

const fixCode = (dir: string) =>
  writeFileSync(join(dir, 'src/date.js'), "import { format } from 'date-fns';\nexport const show = (d) => format(new Date(d), 'yyyy-MM-dd');\n");

test('a small code fix with an explanation passes every guard', () => {
  assert.deepEqual(rulesAfter(fixCode), []);
});

test('editing a journey file is rejected', () => {
  assert.deepEqual(rulesAfter((d) => { fixCode(d); writeFileSync(join(d, '.bumpproof/journeys/checkout_test.md'), '# Checkout\n'); }), ['protected_path']);
});

test('a *_test.md outside .bumpproof, a test file, CI and Kane output are all protected', () => {
  for (const rel of ['journeys/login_test.md', 'src/cart.test.js', 'src/__tests__/a.js', 'src/b.spec.ts', '.github/workflows/ci.yml', 'output-123/x.json']) {
    assert.deepEqual(rulesAfter((d) => { fixCode(d); mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), 'x\n'); }), ['protected_path'], rel);
  }
});

test('downgrading the bumped package is rejected', () => {
  assert.deepEqual(rulesAfter((d) => { fixCode(d); writeFileSync(join(d, 'package.json'), PKG.replace('"4.4.0"', '"2.30.0"')); }), ['package_json']);
});

test('removing a dependency or changing a script in package.json is rejected', () => {
  const p = JSON.parse(PKG) as { dependencies: Record<string, string>; scripts: Record<string, string> };
  assert.deepEqual(packageJsonProblems(Buffer.from(PKG), Buffer.from(JSON.stringify({ ...p, dependencies: { react: '18.3.1' } })), cfg.bump.dep_fields),
    ['dependencies.date-fns was removed']);
  assert.deepEqual(packageJsonProblems(Buffer.from(PKG), Buffer.from(JSON.stringify({ ...p, scripts: { build: 'echo ok' } })), cfg.bump.dep_fields),
    ['fields other than new dependencies changed']);
});

test('adding a companion package is allowed, and key order does not matter', () => {
  const p = JSON.parse(PKG) as { dependencies: Record<string, string> };
  const added = JSON.stringify({ dependencies: { ...p.dependencies, '@date-fns/tz': '1.2.0' }, scripts: { build: 'vite build' }, name: 'shop' });
  assert.deepEqual(packageJsonProblems(Buffer.from(PKG), Buffer.from(added), cfg.bump.dep_fields), []);
  assert.deepEqual(packageJsonProblems(Buffer.from(PKG), Buffer.from(JSON.stringify({ ...p, devDependencies: { x: '1.0.0' }, name: 'shop', scripts: { build: 'vite build' } })), cfg.bump.dep_fields), []);
});

test('adding child_process, eval( or new Function( is rejected', () => {
  for (const line of ["import { exec } from 'node:child_process';", 'eval(code);', 'const f = new Function("return 1");']) {
    assert.deepEqual(rulesAfter((d) => writeFileSync(join(d, 'src/date.js'), `${line}\n`)), ['denied_pattern'], line);
  }
});

test('a patch over the line limit is rejected', () => {
  const big = Array.from({ length: cfg.fixer.max_patch_lines + 1 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  assert.deepEqual(rulesAfter((d) => writeFileSync(join(d, 'src/big.js'), `${big}\n`)), ['too_many_lines']);
});

test('no explanation file, or no code change at all, is rejected', () => {
  assert.deepEqual(rulesAfter(fixCode, false), ['no_explanation']);
  assert.deepEqual(rulesAfter(() => undefined), ['no_change']);
});

test('symbolic links and binary files are rejected', () => {
  assert.deepEqual(rulesAfter((d) => { fixCode(d); symlinkSync('/etc/passwd', join(d, 'src/link.js')); }), ['symlink']);
  assert.deepEqual(rulesAfter((d) => { fixCode(d); writeFileSync(join(d, 'src/blob.bin'), Buffer.from([1, 0, 2])); }), ['binary']);
});

test('node_modules is not part of the patch', () => {
  assert.deepEqual(rulesAfter((d) => { fixCode(d); writeFileSync(join(d, 'node_modules/date-fns/index.js'), 'changed\n'); }), []);
});

test('restoreTree undoes additions, edits and deletions', () => {
  const dir = app(START);
  const before = snapshotTree(dir, cfg.fixer.snapshot_skip);
  fixCode(dir);
  writeFileSync(join(dir, 'new.js'), 'x\n');
  writeFileSync(join(dir, 'src/cart.test.js'), '');
  const after = snapshotTree(dir, cfg.fixer.snapshot_skip);
  restoreTree(dir, before, diffTrees(before, after));
  assert.equal(existsSync(join(dir, 'new.js')), false);
  assert.equal(readFileSync(join(dir, 'src/date.js'), 'utf8'), START['src/date.js']);
  assert.deepEqual(diffTrees(before, snapshotTree(dir, cfg.fixer.snapshot_skip)), []);
});

test('lineDiff counts only the lines that changed', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), { added: ['x', 'e'], removed: ['b'] });
  assert.deepEqual(lineDiff([], ['a']), { added: ['a'], removed: [] });
});

test('globs: ** spans folders, * stays in one segment', () => {
  assert.ok(globToRegExp('**/*_test.md').test('a_test.md'));
  assert.ok(globToRegExp('**/*_test.md').test('x/y/a_test.md'));
  assert.ok(!globToRegExp('output-*/**').test('src/output-1/a'));
  assert.ok(globToRegExp('**/*.test.*').test('src/cart.test.js'));
  assert.ok(!globToRegExp('**/*.test.*').test('src/contest.js'));
});

test('renderPatch shows removed and added lines per file', () => {
  const dir = app(START);
  const before = snapshotTree(dir, cfg.fixer.snapshot_skip);
  fixCode(dir);
  const patch = renderPatch(diffTrees(before, snapshotTree(dir, cfg.fixer.snapshot_skip)));
  assert.match(patch, /^--- a\/src\/date\.js\n\+\+\+ b\/src\/date\.js\n-export const show = \(d\) => format\(d,/);
  assert.match(patch, /\+export const show = \(d\) => format\(new Date\(d\)/);
});

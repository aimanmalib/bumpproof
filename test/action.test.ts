// Contract tests for action.yml: no YAML library (PRD D10), so these read the small subset the file uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { helpText } from '../src/cli.ts';
import { ROOT } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';

const text = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const lines = text.split('\n');

/** Lines of a top-level block (`name:` at column 0) up to the next top-level key. */
function block(name: string): string[] {
  const start = lines.indexOf(`${name}:`);
  assert.ok(start >= 0, `action.yml has ${name}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

const keysAt = (b: string[], indent: number) =>
  b.map((l) => new RegExp(`^ {${indent}}([a-z][a-z0-9-]*):`).exec(l)?.[1]).filter((k): k is string => !!k);

interface Step { text: string; run: string; uses?: string; id?: string; shell?: string }
function steps(): Step[] {
  const b = block('runs');
  const out: Step[] = [];
  for (const l of b) {
    if (/^ {4}- /.test(l)) out.push({ text: '', run: '' });
    const s = out.at(-1);
    if (s) s.text += `${l}\n`;
  }
  for (const s of out) {
    s.uses = /uses: (\S+)/.exec(s.text)?.[1];
    s.id = /\n? {6}id: (\S+)/.exec(s.text)?.[1];
    s.shell = /\n {6}shell: (\S+)/.exec(s.text)?.[1];
    const m = /\n {6}run: \|?\n?([\s\S]*)$/.exec(s.text);
    s.run = m?.[1] ?? '';
  }
  return out;
}

test('composite action with inputs that all have a description and are all used', () => {
  assert.match(text, /^ {2}using: composite$/m);
  const inputs = block('inputs');
  const names = keysAt(inputs, 2);
  assert.ok(names.length >= 5, `inputs: ${names.join(', ')}`);
  for (const n of names) {
    const i = inputs.findIndex((l) => l === `  ${n}:`);
    const body = inputs.slice(i + 1, i + 4).join('\n');
    assert.match(body, /description: \S/, `${n} has a description`);
  }
  const used = new Set([...text.matchAll(/inputs\.([a-z0-9-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((u) => !names.includes(u!)), [], 'every inputs.x is declared');
  assert.deepEqual(names.filter((n) => !used.has(n)), [], 'every declared input is used');
});

test('outputs point at a step that exists', () => {
  const ids = new Set(steps().map((s) => s.id).filter(Boolean));
  const refs = [...block('outputs').join('\n').matchAll(/steps\.([a-z0-9-]+)\.outputs/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  for (const r of refs) assert.ok(ids.has(r), `step ${r} exists`);
});

test('no LLM key, no account key, no fix mode: check and comment only (PRD D9)', () => {
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /ANTHROPIC|CLAUDE_|KANE_|access[_-]?key/i);
  const scripts = steps().map((s) => s.run).join('\n');
  assert.doesNotMatch(scripts, /--fix|--push-fix|\bclaude\b/);
  assert.doesNotMatch(text, /pull_request_target/);
});

test('every run step names its shell and never expands ${{ }} inside the script (injection)', () => {
  const all = steps();
  assert.ok(all.length >= 5);
  for (const s of all) {
    if (s.uses) {
      assert.match(s.uses, /^[\w.-]+\/[\w.-]+@v\d+$/, `${s.uses} pinned to a major version`);
      continue;
    }
    assert.equal(s.shell, 'bash', s.text);
    assert.ok(s.run.trim(), s.text);
    assert.doesNotMatch(s.run, /\$\{\{/, `run block reads env, not expressions:\n${s.run}`);
  }
});

test('the CLI options the action passes exist, and the outcome names match the comment', () => {
  const check = steps().find((s) => s.id === 'check');
  assert.ok(check);
  assert.match(check.run, /node "\$BP_CLI" check /);
  const help = helpText(makeTranslator('en'));
  const flags = [...check.run.matchAll(/(--[a-z][a-z-]+)/g)].map((m) => m[1]!);
  assert.ok(flags.includes('--markdown') && flags.includes('--base'));
  for (const f of flags) assert.ok(help.includes(`${f} `), `${f} is a bumpproof option`);
  assert.match(check.run, /bumpproof-outcome: /, 'reads the outcome line written by src/check-comment.ts');
  assert.match(text, /<!-- bumpproof-action -->/, 'finds its earlier comment by the same marker');
});

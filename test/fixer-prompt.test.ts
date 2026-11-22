import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeRunJson } from '../src/check-cli.ts';
import { promptCopy } from '../src/check-fix.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { scanText } from '../src/evidence.ts';
import { buildPrompt, type FixInput } from '../src/fixer.ts';
import { condenseNotes, factLines, kaneFacts, numbered, renderPromptFile } from '../src/fixer-prompt.ts';
import { makeTranslator } from '../src/i18n.ts';
import { runPage } from '../src/report/run-page.ts';
import { parseRun, readRun } from '../src/report/run.ts';

const cfg = loadConfig('/nonexistent');
const en = makeTranslator('en');
const NOTES = '<untrusted_release_notes package="lib" from="1.0.0" to="2.0.0" sources="https://example.org/r">\n'
  + `${'Breaking: the default export is gone.\n'.repeat(60)}</untrusted_release_notes>`;
const INPUT: FixInput = {
  bumps: [{ name: 'lib', from: '1.0.0', to: '2.0.0', type: 'major', field: 'dependencies' }],
  failure: { kind: 'journey', journey: 'account', objective: '# Account\n\n## Use the tabs again\nClick "Orders".',
    step: 'Use the tabs again', remark: 'assertion_failed: @ step 4', console: ['TypeError: x is undefined'], network: [] },
  notes: [NOTES],
};
const fixture = () => parseRun(JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'synthetic-run', 'run.json'), 'utf8')));

test('kaneFacts: step, remark, result code and errors for a journey; nothing for a build failure', () => {
  assert.deepEqual(kaneFacts(INPUT.failure, 710).map((f) => f.label), ['step', 'remark', 'result_code', 'console']);
  assert.deepEqual(kaneFacts({ kind: 'build', phase: 'build', log: ['x'] }, 710), []);
});

test('factLines: whole values only, and not inside the journey text people wrote', () => {
  const p = 'objective heading: ## Use the tabs again\n- Step that failed: Use the tabs again\ncode 17100\ncode 710';
  const facts = [{ label: 'step', value: 'Use the tabs again' }, { label: 'result_code', value: '710' }];
  assert.deepEqual(factLines(p, facts), [[1, 2], [4]]);
  assert.deepEqual(factLines(p, facts, ['## Use the tabs again']), [[2], [4]]);
});

test('condenseNotes keeps the opening line and replaces the text with its size', () => {
  const out = condenseNotes(`before\n${NOTES}\nafter`, (kb) => `[${kb} KB left out]`);
  assert.equal(out, 'before\n<untrusted_release_notes package="lib" from="1.0.0" to="2.0.0" sources="https://example.org/r">\n'
    + '[2 KB left out]\n</untrusted_release_notes>\nafter');
});

test('renderPromptFile marks Kane CLI lines, says what was not sent, and cannot be closed by backticks in the prompt', () => {
  const prompt = buildPrompt(cfg, INPUT);
  const text = renderPromptFile(en, { run_id: 'r1', prompts: [prompt, `${prompt}\n\`\`\`\`\`\`\nretry`],
    kane: kaneFacts(INPUT.failure, 710), quoted: [INPUT.failure.kind === 'journey' ? INPUT.failure.objective! : ''] });
  assert.match(text, /^# What the agent was told: run r1\n/);
  assert.match(text, /saved during the run/);
  assert.match(text, /\| Result code \| `710` \| not sent to the agent \|/);
  const marked = text.split('\n').filter((l) => l.startsWith('K '));
  assert.equal(marked.length, 2 * 3, 'step, remark and console line in each attempt');
  assert.ok(marked.every((l) => /Step that failed|What Kane CLI saw|New console errors/.test(l)));
  assert.match(text, /## Attempt 2\n\n```````text\n/, 'fence longer than the six backticks in the prompt');
  assert.equal(numbered('a\nb', new Set([2])), '  1 │ a\nK 2 │ b');
  const rebuilt = renderPromptFile(en, { run_id: 'r2', prompts: ['x'], kane: [], rebuilt: { templates: 'abc', missing: ['the notes'] } });
  assert.match(rebuilt, /Rebuilt from the recorded inputs/);
  assert.match(rebuilt, /not shown: the notes\./);
  assert.match(rebuilt, /did not build, so Kane CLI ran no journey/);
});

test('promptCopy scrubs a secret from the environment and condenses the notes', () => {
  const r = fixture();
  const key = cfg.publish.secret_env[0]!;
  const secret = ['kane', 'user', 'demo42'].join('-');
  const input = { ...INPUT, failure: { ...INPUT.failure, remark: `token ${secret} leaked` } as FixInput['failure'] };
  const text = promptCopy(r, input.failure, [buildPrompt(cfg, input)], { cfg, env: { [key]: secret } });
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('default export is gone'));
  assert.match(text, /KB of release notes: the agent read them in full/);
  assert.equal(promptCopy(r, input.failure, [], { cfg, env: {} }), '');
});

test('writeRunJson writes fixer-prompt.md and refuses one that carries an e-mail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-prompt-'));
  try {
    const base = fixture();
    const r = { ...base, fix: { status: 'fixed' as const, attempts: 1, changed_lines: 1, cost_usd: null, files: [], explanation: '',
      patch_file: null, prompt_file: 'fixer-prompt.md' } };
    assert.notEqual(writeRunJson(join(dir, 'a'), r, cfg, {}, '', [], 'ask owner@private.test').length, 0);
    assert.equal(existsSync(join(dir, 'a')), false);
    assert.deepEqual(writeRunJson(join(dir, 'b'), r, cfg, {}, '', [], '# prompt\n'), []);
    assert.deepEqual(readdirSync(join(dir, 'b')).sort(), ['fixer-prompt.md', 'run.json']);
    assert.equal(parseRun(JSON.parse(readFileSync(join(dir, 'b', 'run.json'), 'utf8'))).fix?.prompt_file, 'fixer-prompt.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the run page links the prompt only when the file is there', () => {
  const r = fixture();
  const run = { ...r, fix: { status: 'fixed' as const, attempts: 1, changed_lines: 1, cost_usd: null, files: [], explanation: '',
    patch_file: null } };
  for (const lang of ['en', 'ms']) {
    const t = makeTranslator(lang);
    assert.ok(runPage(run, null, 'x', 'fixer-prompt.md').body(t, lang).includes(`<a href="fixer-prompt.md">${t('site.run_prompt')}</a>`));
    assert.ok(!runPage(run, null, 'x').body(t, lang).includes('fixer-prompt.md'));
  }
});

test('every published fixed run has its fixer-prompt.md, clean under the publication scan', () => {
  const runsDir = join(ROOT, 'docs', 'runs');
  const fixed = readdirSync(runsDir).map((id) => readRun(join(runsDir, id))).filter((r) => r.fix?.status === 'fixed');
  assert.ok(fixed.length > 0);
  for (const r of fixed) {
    const f = r.fix!.prompt_file;
    assert.ok(f, `${r.run_id}: fix.prompt_file`);
    const text = readFileSync(join(runsDir, r.run_id, f), 'utf8');
    assert.deepEqual(scanText(f, text, cfg.publish, []), [], r.run_id);
    assert.match(text, new RegExp(`^# What the agent was told: run ${r.run_id}\\n`));
    for (const j of r.journeys.filter((x) => x.outcome === 'regression').slice(0, 1)) {
      if (j.head?.failed_step) assert.match(text, /^K +\d+ │ - Step that failed: /m, `${r.run_id}: Kane CLI's step is marked`);
    }
  }
});

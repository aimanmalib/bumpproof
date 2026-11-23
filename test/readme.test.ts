import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { version } from '../src/cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';
import { buildSite } from '../src/report/html.ts';
import { measure } from '../src/report/metrics.ts';
import { README_END, README_START, prRuns, readmeBlock, replaceReadmeBlock } from '../src/report/readme.ts';
import { parseRun, readRun } from '../src/report/run.ts';

const cfg = loadConfig(tmpdir());
const en = makeTranslator('en');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURE, 'run.json'), 'utf8')) as Record<string, unknown>;
const empty = () => measure({ runs: [], census: null, censusRuns: [], candidates: null, ledger: null });

test('the README block lists real pull-request runs only, newest first, with escaped cells', () => {
  const base = raw();
  const src = base.source as Record<string, unknown>;
  const mk = (id: string, pr: number | null, extra: Record<string, unknown> = {}) => parseRun({ ...base, ...extra, run_id: id,
    synthetic: false, source: { ...src, pr, pr_url: pr === null ? null : `https://github.com/o/r/pull/${pr}` } });
  const runs = [mk('a', 3), mk('b', 9), mk('c', null), parseRun({ ...base, run_id: 'd' })];
  assert.deepEqual(prRuns(runs).map((r) => r.run_id), ['b', 'a']);
  const block = readmeBlock(en, runs, empty(), 'https://x.example/site');
  assert.ok(block.startsWith(README_START) && block.endsWith(README_END));
  assert.ok(block.indexOf('[#9]') < block.indexOf('[#3]'));
  assert.ok(block.includes('(https://x.example/site/runs/b/)'));
  assert.ok(!/\b(readme|site|verdict)\.[a-z_]+/.test(block), 'no unresolved locale keys');
  const piped = readmeBlock(en, [mk('e', 1, { bumps: [{ name: 'a|b', from: '1', to: '2', type: 'major' }] })], empty(), 'https://x.example/');
  assert.ok(piped.includes('a\\|b 1 → 2'));
});

test('no pull-request runs and no census: the block says so instead of showing numbers', () => {
  const block = readmeBlock(en, [], empty(), 'https://x.example/');
  assert.ok(block.includes(en('readme.empty')));
  assert.ok(block.includes(en('site.not_measured')));
});

test('replaceReadmeBlock touches only the marked block and refuses missing or repeated markers', () => {
  const doc = `top\n${README_START}\nold\n${README_END}\nbottom\n`;
  assert.equal(replaceReadmeBlock(doc, `${README_START}\nnew\n${README_END}`), `top\n${README_START}\nnew\n${README_END}\nbottom\n`);
  assert.equal(replaceReadmeBlock('no markers', 'x'), null);
  assert.equal(replaceReadmeBlock(`${README_END}\n${README_START}`, 'x'), null);
  assert.equal(replaceReadmeBlock(`${README_START}${README_START}${README_END}`, 'x'), null);
});

test('report rewrites the README block and refuses to write one that would publish an e-mail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-readme-'));
  try {
    const readme = join(dir, 'README.md');
    writeFileSync(readme, `# x\n${README_START}\n${README_END}\n`);
    const translators = new Map([['en', en], ['ms', makeTranslator('ms')]]);
    const opts = { outDir: join(dir, 'site'), runsDir: join(dir, 'runs'), censusPath: join(dir, 'none.json'), readmePath: readme,
      version: '9.9.9', translators, secrets: [] };
    assert.equal(buildSite(cfg, opts).readme, true);
    assert.ok(readFileSync(readme, 'utf8').includes(en('readme.empty')));
    writeFileSync(readme, `# x\n${README_START}\n${README_END}\nwrite to someone@example.org\n`);
    const res = buildSite(cfg, opts);
    assert.ok(res.findings.some((f) => f.file === 'README.md'));
    assert.ok(!readFileSync(readme, 'utf8').includes(en('readme.empty')), 'nothing written when the scan finds something');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed README numbers are what bumpproof report writes today', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-readme-now-'));
  try {
    const readme = join(dir, 'README.md');
    const committed = readFileSync(join(ROOT, 'README.md'), 'utf8');
    writeFileSync(readme, committed);
    buildSite(cfg, { outDir: join(dir, 'site'), runsDir: join(ROOT, 'docs', 'runs'), censusPath: join(ROOT, cfg.report.census_path),
      candidatesPath: join(ROOT, cfg.census.candidates_path), censusRunsDir: join(ROOT, cfg.census.runs_dir),
      ledgerPath: join(ROOT, cfg.kane.ledger_path), readmePath: readme, version: version(),
      translators: new Map([['en', en], ['ms', makeTranslator('ms')]]), secrets: [] });
    assert.equal(committed, readFileSync(readme, 'utf8'), 'README.md numbers are stale: run bumpproof report');
    assert.ok(readRun(join(ROOT, 'docs', 'runs', '20261122-0453-53ba')), 'the run the README links to for judges exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every `file#Lnn` link in the README points at the line it names. When code moves, this goes red until the README follows.
const README_LINES: Record<string, string> = {
  'config/defaults.json#L85': '"testmd_args"',
  'src/census-run.ts#L86': 'async function authorOnBase',
  'src/check-fix.ts#L34': 'export function failureOf',
  'src/check-fix.ts#L62': 'export async function verifyFix',
  'src/check-journeys.ts#L65': 'await runSide(',
  'src/compare.ts#L43': 'export function runOutcome',
  'src/compare.ts#L61': 'export function compareJourney',
  'src/evidence.ts#L27': 'export function readPack',
  'src/evidence.ts#L117': 'export function summarize',
  'src/journeys.ts#L92': 'export async function runJourney',
  'src/kane.ts#L57': 'export function parseNdjson',
  'src/kane.ts#L106': "case 'run_end'",
  'src/kane.ts#L139': 'export function testmdArgs',
  'src/kane.ts#L186': 'export function checkBudget',
  'src/report/markdown.ts#L44': 'o.bugCode',
};

test('README file#line links point at the code they name', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const links = [...new Set([...readme.matchAll(/\]\(([\w./-]+#L\d+)\)/g)].map((m) => m[1]!))].sort();
  assert.deepEqual(links, Object.keys(README_LINES).sort(), 'every README line link has an expected text here');
  for (const link of links) {
    const [file, line] = link.split('#L') as [string, string];
    const text = readFileSync(join(ROOT, file), 'utf8').split('\n')[Number(line) - 1] ?? '';
    assert.ok(text.includes(README_LINES[link]!), `${link} is now: ${text.trim()}`);
  }
});

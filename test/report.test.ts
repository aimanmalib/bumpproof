import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { version } from '../src/cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';
import { buildSite, readCensus } from '../src/report/html.ts';
import { renderComment } from '../src/report/markdown.ts';
import { parseRun, readRun, readRuns, RunFormatError } from '../src/report/run.ts';
import { patchHtml } from '../src/report/run-page.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURE, 'run.json'), 'utf8')) as Record<string, unknown>;
const cfg = loadConfig(tmpdir());
const en = makeTranslator('en');
const ms = makeTranslator('ms');
const translators = new Map([['en', en], ['ms', ms]]);
const UNRESOLVED = /(^|[\s>(])(site|timeline|comment|status|side|verdict|outcome|reason|replay|duration)\.[a-z_]+/m;

function siteDir(runs: Record<string, unknown>[], census?: unknown): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bp-report-'));
  for (const r of runs) {
    const d = join(dir, 'runs', String(r.run_id));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'run.json'), JSON.stringify(r));
    cpSync(join(FIXTURE, 'fix.patch'), join(d, 'fix.patch'));
  }
  if (census !== undefined) writeFileSync(join(dir, 'results.json'), JSON.stringify(census));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const build = (dir: string, secrets: string[] = []) => buildSite(cfg, { outDir: dir, runsDir: join(dir, 'runs'),
  censusPath: join(dir, 'results.json'), version: '9.9.9', translators, secrets });

test('the synthetic run record parses and keeps its shape', () => {
  const run = readRun(FIXTURE);
  assert.equal(run.synthetic, true);
  assert.equal(run.verdict.verdict, 'fixed');
  assert.deepEqual(run.journeys.map((j) => j.outcome), ['same', 'shifted_ok', 'regression']);
  assert.equal(run.journeys[2]!.head!.result_code, 740);
  assert.equal(run.fix?.patch_file, 'fix.patch');
});

test('a run record with a wrong field is refused with the field named', () => {
  const cases: [string, (r: Record<string, unknown>) => void, RegExp][] = [
    ['schema', (r) => { r.schema_version = 2; }, /schema_version/],
    ['verdict', (r) => { (r.verdict as Record<string, unknown>).verdict = 'probably fine'; }, /verdict\.verdict/],
    ['run id escapes', (r) => { r.run_id = '../../etc'; }, /run_id/],
    ['patch escapes', (r) => { (r.fix as Record<string, unknown>).patch_file = '../secret'; }, /fix\.patch_file/],
    ['shot escapes', (r) => { r.shots = [{ journey: 'a', side: 'head', file: '/etc/passwd' }]; }, /shots\[0\]\.file/],
    ['outcome', (r) => { ((r.journeys as Record<string, unknown>[])[0]!).outcome = 'ok'; }, /journeys\[0\]\.outcome/],
    ['missing base', (r) => { delete ((r.journeys as Record<string, unknown>[])[0]!).base; }, /journeys\[0\]\.base/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = raw();
    mutate(r);
    assert.throws(() => parseRun(r), (e: unknown) => e instanceof RunFormatError && re.test(e.message), name);
  }
});

test('readRuns lists newest first and stops on a broken record', () => {
  const a = { ...raw(), run_id: 'a-old', started_at: '2026-11-20T00:00:00Z' };
  const b = { ...raw(), run_id: 'b-new', started_at: '2026-11-22T00:00:00Z' };
  const s = siteDir([a, b]);
  try {
    assert.deepEqual(readRuns(join(s.dir, 'runs')).map((r) => r.run_id), ['b-new', 'a-old']);
    writeFileSync(join(s.dir, 'runs', 'a-old', 'run.json'), '{ not json');
    assert.throws(() => readRuns(join(s.dir, 'runs')), RunFormatError);
  } finally {
    s.done();
  }
  assert.deepEqual(readRuns(join(tmpdir(), 'bp-no-such-dir')), []);
});

test('the PR comment shows verdict, journeys, failure, fix and footer in both languages', () => {
  const run = readRun(FIXTURE);
  const md = renderComment(run, en, { version: '1.2.3', runUrl: 'https://example.com/runs/x/', bugCode: 740 });
  assert.match(md, /^## 🛠️ Bumpproof: Fixed$/m);
  assert.match(md, /Synthetic example/);
  assert.equal(md.split('\n').filter((l) => l.startsWith('| `')).length, 3);
  assert.match(md, /\| `account` \| Passed · 37 s \| Failed · 33 s \| Passed · 36 s \| Regression \|/);
  assert.match(md, /product bug \(result code 740\)/);
  assert.match(md, /RangeError: Invalid time value/);
  assert.match(md, /`src\/pages\/Account\.jsx`/);
  assert.match(md, /https:\/\/example\.com\/runs\/x\//);
  assert.match(md, /Verified with Kane CLI 0\.10\.7 · Bumpproof 1\.2\.3/);
  assert.doesNotMatch(md, UNRESOLVED);
  const bm = renderComment(run, ms, { version: '1.2.3', runUrl: null, bugCode: 740 });
  assert.match(bm, /Bumpproof: Dibaiki/);
  assert.match(bm, /\| Perjalanan \| Asas \|/);
  assert.doesNotMatch(bm, /Verified with|Synthetic example|Run page/);
  assert.doesNotMatch(bm, UNRESOLVED);
});

test('the PR comment keeps untrusted text inside its table cell and drops the bug line for other codes', () => {
  const r = raw();
  (r.source as Record<string, unknown>).pr_title = 'Bump x | y\n## injected';
  ((r.journeys as Record<string, unknown>[])[0]!).name = 'a|b`c';
  const md = renderComment(parseRun(r), en, { version: '1', runUrl: null, bugCode: 999 });
  assert.match(md, /Pull request: Bump x \\\| y ## injected/);
  assert.match(md, /\| `a\\\|b'c` \|/);
  assert.doesNotMatch(md, /product bug/);
});

test('report writes every page in English and Malay, escaped, with no unresolved keys', () => {
  const r = raw();
  ((r.journeys as Record<string, unknown>[])[2]!.head as Record<string, unknown>).remark = '<script>alert(1)</script>';
  const s = siteDir([r]);
  try {
    const res = build(s.dir);
    assert.deepEqual(res.findings, []);
    assert.deepEqual(res.pages.sort(), ['census.html', 'index.html', 'judges.html', `runs/${r.run_id}/index.html`]);
    for (const p of res.pages) {
      const html = readFileSync(join(s.dir, p), 'utf8');
      assert.match(html, /data-lang="en"/, p);
      assert.match(html, /data-lang="ms" hidden/, p);
      assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), UNRESOLVED, p);
      assert.doesNotMatch(html, /backdrop-filter/);
    }
    const page = readFileSync(join(s.dir, 'runs', String(r.run_id), 'index.html'), 'utf8');
    assert.ok(!page.includes('<script>alert'), 'remark must be escaped');
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /class="d-add"/);
    assert.match(page, /Synthetic example made for tests/);
    assert.match(page, /Contoh sintetik untuk ujian/);
    assert.match(page, /href="\.\.\/\.\.\/assets\/site\.css"/);
    for (const f of ['assets/site.css', 'assets/site.js', 'assets/fonts/OFL.txt', '.nojekyll']) assert.ok(existsSync(join(s.dir, f)), f);
    assert.doesNotMatch(readFileSync(join(s.dir, 'assets', 'site.css'), 'utf8'), /backdrop-filter\s*:|filter:\s*blur/);
    // Only a synthetic run exists: judges get no replay command for it.
    const judges = readFileSync(join(s.dir, 'judges.html'), 'utf8');
    assert.match(judges, /No run is recorded yet/);
    assert.doesNotMatch(judges, /replay docs\/runs/);
  } finally {
    s.done();
  }
});

test('report refuses to write pages that would publish a secret or an e-mail', () => {
  const r = raw();
  ((r.journeys as Record<string, unknown>[])[2]!.head as Record<string, unknown>).remark = 'Signed in as kaneuser01 (someone@private-mail.test)';
  const s = siteDir([r]);
  try {
    const res = build(s.dir, ['kaneuser01']);
    assert.ok(res.findings.some((f) => f.kind === 'secret'));
    assert.ok(res.findings.some((f) => f.kind === 'email'));
    assert.deepEqual(res.pages, []);
    assert.equal(existsSync(join(s.dir, 'index.html')), false);
  } finally {
    s.done();
  }
});

test('census page: empty state without results, filterable table with them', () => {
  const s = siteDir([]);
  try {
    build(s.dir);
    assert.match(readFileSync(join(s.dir, 'census.html'), 'utf8'), /The census has not run yet/);
    assert.match(readFileSync(join(s.dir, 'index.html'), 'utf8'), /No runs recorded yet/);
    writeFileSync(join(s.dir, 'results.json'), JSON.stringify({ schema_version: 1, repos: [
      { repo: 'a/one', verdict: 'safe', bump: 'x 1 → 2', license: 'MIT', ci: 'success', control: 'same' },
      { repo: 'b/two', verdict: 'broken', pr_url: 'https://github.com/b/two/pull/3' },
    ] }));
    build(s.dir);
    const html = readFileSync(join(s.dir, 'census.html'), 'utf8');
    assert.equal((html.match(/<tr data-verdict="/g) ?? []).length, 4, 'two rows in each language');
    assert.match(html, /data-filter="broken"/);
    assert.match(html, /2 repositories/);
    assert.match(html, /2 repositori/);
    writeFileSync(join(s.dir, 'results.json'), JSON.stringify({ repos: [{ repo: 'a/one' }] }));
    assert.throws(() => readCensus(join(s.dir, 'results.json')), RunFormatError);
  } finally {
    s.done();
  }
});

test('patch lines are classed and escaped', () => {
  const html = patchHtml('--- a/x\n+++ b/x\n-<b>old</b>\n+new\n same\n');
  assert.match(html, /<span class="d-file">--- a\/x<\/span>/);
  assert.match(html, /<span class="d-del">-&lt;b&gt;old&lt;\/b&gt;<\/span>/);
  assert.match(html, /<span class="d-add">\+new<\/span>/);
});

test('the committed docs/ pages are what bumpproof report writes today', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bp-docs-'));
  try {
    const runs = join(ROOT, 'docs', 'runs');
    const res = buildSite(cfg, { outDir: tmp, runsDir: runs, censusPath: join(ROOT, 'census', 'results.json'), version: version(),
      translators, secrets: [] });
    for (const p of res.pages) {
      assert.equal(readFileSync(join(ROOT, 'docs', p), 'utf8'), readFileSync(join(tmp, p), 'utf8'), `docs/${p} is stale: run bumpproof report`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('run page: the "UI changed, behaviour kept" tag only on a journey that passed after healing', async () => {
  const { runPage } = await import('../src/report/run-page.ts');
  const t = makeTranslator('en');
  const r = raw();
  const j = (r.journeys as Record<string, unknown>[])[0]!;
  const head = { status: 'failed', seconds: 197, credits: 17, healed: true, failed_step: 'x', remark: 'y', result_code: 740 };
  const html = (h: Record<string, unknown>) => runPage(parseRun({ ...r, journeys: [{ ...j, head: h, outcome: 'regression' }] }), null, 'x')
    .body(t, 'en');
  const tag = `<span class="tag">${t('outcome.shifted_ok')}</span>`;
  assert.ok(!html(head).includes(tag), 'Kane CLI tried a heal and still failed: not a shifted pass');
  assert.ok(html({ ...head, status: 'passed' }).includes(tag));
});

// Link previews and the version people see: favicon, Open Graph and X card tags on every report page,
// and the real package version in the pull request comment footer.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { version } from '../src/cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { makeTranslator } from '../src/i18n.ts';
import { buildSite } from '../src/report/html.ts';
import { siteUrl } from '../src/report/layout.ts';
import { renderComment } from '../src/report/markdown.ts';
import { readRun } from '../src/report/run.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const cfg = loadConfig(tmpdir());
const en = makeTranslator('en');
const translators = new Map([['en', en], ['ms', makeTranslator('ms')]]);
/** Same limit as scripts/share-assets.py: chat apps drop larger preview images. */
const OG_MAX_BYTES = 300_000;

/** The `<head>` tags a link-preview bot reads: property/name → content. */
function previewTags(html: string): Map<string, string> {
  const head = html.slice(0, html.indexOf('</head>'));
  const out = new Map<string, string>();
  for (const m of head.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)) out.set(m[1]!, m[2]!);
  const icon = /<link rel="icon" href="([^"]+)"/.exec(head);
  if (icon) out.set('icon', icon[1]!);
  return out;
}

function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', path);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('siteUrl gives the bare site address for the home page and full paths for the rest', () => {
  assert.equal(siteUrl('https://x.example/site', 'index.html'), 'https://x.example/site/');
  assert.equal(siteUrl('https://x.example/site/', 'runs/a/index.html'), 'https://x.example/site/runs/a/');
  assert.equal(siteUrl('https://x.example/site/', 'assets/og.png'), 'https://x.example/site/assets/og.png');
});

test('every report page carries a favicon and preview tags that point at real files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-share-'));
  try {
    const run = JSON.parse(readFileSync(join(FIXTURE, 'run.json'), 'utf8')) as { run_id: string };
    mkdirSync(join(dir, 'runs', run.run_id), { recursive: true });
    writeFileSync(join(dir, 'runs', run.run_id, 'run.json'), JSON.stringify(run));
    cpSync(join(FIXTURE, 'fix.patch'), join(dir, 'runs', run.run_id, 'fix.patch'));
    const res = buildSite(cfg, { outDir: dir, runsDir: join(dir, 'runs'), censusPath: join(dir, 'none.json'), version: '9.9.9',
      translators, secrets: [] });
    assert.deepEqual(res.findings, []);
    assert.ok(existsSync(join(dir, 'favicon.ico')), 'favicon.ico at the site root');
    const base = cfg.report.pages_url.replace(/\/?$/, '/');
    for (const page of res.pages) {
      const html = readFileSync(join(dir, page), 'utf8');
      const tags = previewTags(html);
      assert.ok(existsSync(join(dir, page, '..', tags.get('icon')!)), `${page}: icon ${tags.get('icon')}`);
      assert.equal(tags.get('twitter:card'), 'summary_large_image', page);
      assert.equal(tags.get('og:title'), /<title>([^<]+)<\/title>/.exec(html)![1], page);
      assert.equal(tags.get('og:description'), en('site.tagline'), page);
      assert.equal(tags.get('og:url'), page === 'index.html' ? base : base + page.replace(/index\.html$/, ''), page);
      const image = tags.get('og:image')!;
      assert.ok(image.startsWith(base), `${page}: og:image must be absolute, got ${image}`);
      assert.equal(tags.get('twitter:image'), image, page);
      assert.ok(tags.get('og:image:alt'), page);
      assert.doesNotMatch(html, /noindex|nosnippet|noimageindex/, `${page}: robots must not block previews`);
    }
    const imagePath = join(dir, cfg.report.share_image);
    assert.deepEqual(pngSize(imagePath), [1200, 630]);
    assert.ok(statSync(imagePath).size <= OG_MAX_BYTES, `${cfg.report.share_image} is ${statSync(imagePath).size} bytes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the package version is a real release with a changelog entry, and the comment footer shows it', () => {
  const v = version();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.notEqual(v, '0.0.0', 'package.json still has the placeholder version');
  assert.match(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${v.replace(/\./g, '\\.')} \\(`, 'm'));
  const md = renderComment(readRun(FIXTURE), en, { version: v, runUrl: null, bugCode: 740 });
  assert.match(md.trimEnd().split('\n').at(-1)!, new RegExp(`Bumpproof ${v.replace(/\./g, '\\.')}</sub>$`));
});

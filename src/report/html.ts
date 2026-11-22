// `bumpproof report`: builds the static site in `docs/` from the run records and census/results.json.
// Pages are checked by the publication scan before anything is written (PRD §5.5): no identities, no private links.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT, type Config } from '../config.ts';
import { scanText, type Finding } from '../evidence.ts';
import type { Translate } from '../i18n.ts';
import { renderPage, type SiteInfo } from './layout.ts';
import { measure, readCandidates, readLedger } from './metrics.ts';
import { censusPage, homePage, judgesPage, type CensusRow, type SiteData } from './pages.ts';
import { RunFormatError, readRuns, type RunReport } from './run.ts';
import { runPage } from './run-page.ts';

export interface ReportOptions {
  outDir: string;
  runsDir: string;
  censusPath: string;
  /** Optional census inputs for the measured numbers (H2, H5, H6); left out, those numbers show a dash. */
  candidatesPath?: string;
  censusRunsDir?: string;
  ledgerPath?: string;
  version: string;
  translators: Map<string, Translate>;
  secrets: string[];
}

export interface ReportResult {
  pages: string[];
  runs: number;
  census: boolean;
  findings: Finding[];
}

/** Reads census/results.json leniently; the census writer (A7/C1) owns the full shape. */
export function readCensus(path: string): CensusRow[] | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as { repos?: unknown };
  if (!Array.isArray(data.repos)) throw new RunFormatError(`${path}: expected a "repos" list`);
  const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return data.repos.map((r: unknown, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const repo = s(o.repo);
    const verdict = s(o.verdict);
    if (!repo || !verdict) throw new RunFormatError(`${path}: repos[${i}] needs "repo" and "verdict"`);
    return { repo, verdict, url: s(o.url), license: s(o.license), pr_url: s(o.pr_url), bump: s(o.bump) ?? '—', ci: s(o.ci),
      control: s(o.control), ci_green_but_broken: o.ci_green_but_broken === true, run_id: s(o.run_id) };
  });
}

function patchOf(runsDir: string, run: RunReport): string | null {
  const f = run.fix?.patch_file;
  if (!f) return null;
  const p = join(runsDir, run.run_id, f);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * The site's CSS, script and fonts live once, in this repository's `docs/assets/` (served by Pages and shipped in the
 * package). A report written anywhere else gets a copy.
 */
export function copyAssets(outDir: string, root: string = ROOT): string[] {
  const src = join(root, 'docs', 'assets');
  const dest = join(outDir, 'assets');
  if (resolve(src) === resolve(dest)) return [];
  const out: string[] = [];
  for (const sub of ['', 'fonts']) {
    mkdirSync(join(dest, sub), { recursive: true });
    for (const f of readdirSync(join(src, sub), { withFileTypes: true })) {
      if (!f.isFile()) continue;
      copyFileSync(join(src, sub, f.name), join(dest, sub, f.name));
      out.push(join('assets', sub, f.name));
    }
  }
  return out;
}

export function buildSite(cfg: Config, o: ReportOptions): ReportResult {
  const runs = readRuns(o.runsDir);
  const census = readCensus(o.censusPath);
  const censusRuns = o.censusRunsDir ? readRuns(o.censusRunsDir) : [];
  const metrics = measure({ runs, census, censusRuns, candidates: readCandidates(o.candidatesPath), ledger: readLedger(o.ledgerPath) });
  const data: SiteData = {
    runs, census, metrics, repoUrl: cfg.report.repo_url, installCommand: cfg.report.install_command,
    replayCommand: cfg.report.replay_command, proofLinks: cfg.report.proof_links,
  };
  const site = (root: string): SiteInfo => ({ version: o.version, repoUrl: cfg.report.repo_url, root, languages: cfg.languages,
    translators: o.translators });
  const pages = new Map<string, string>([
    ['index.html', renderPage(homePage(data), site(''))],
    ['census.html', renderPage(censusPage(data), site(''))],
    ['judges.html', renderPage(judgesPage(data), site(''))],
  ]);
  for (const r of runs) pages.set(`runs/${r.run_id}/index.html`, renderPage(runPage(r, patchOf(o.runsDir, r), cfg.report.replay_command), site('../../')));

  const findings = [...pages].flatMap(([file, html]) => scanText(file, html, cfg.publish, o.secrets));
  if (findings.length > 0) return { pages: [], runs: runs.length, census: census !== null, findings };
  for (const [file, html] of pages) {
    const path = join(o.outDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
  copyAssets(o.outDir);
  if (!existsSync(join(o.outDir, '.nojekyll'))) writeFileSync(join(o.outDir, '.nojekyll'), '');
  return { pages: [...pages.keys()], runs: runs.length, census: census !== null, findings };
}

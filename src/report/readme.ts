// The measured block of README.md: the demo pull-request table and H2–H6, from the same run records and metrics as the
// pages. `bumpproof report` rewrites only the text between the two markers; a test fails when the committed block is stale.
import type { Translate } from '../i18n.ts';
import { round1, type Metrics } from './metrics.ts';
import type { RunReport } from './run.ts';
import { numberTiles } from './numbers.ts';
import { duration } from './words.ts';

export const README_START = '<!-- bumpproof:numbers:start -->';
export const README_END = '<!-- bumpproof:numbers:end -->';

/** Markdown table cells must not break the row. */
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function verdictDetail(t: Translate, r: RunReport): string {
  const n = r.journeys.length;
  const after = r.journeys.filter((j) => j.after_fix?.status === 'passed').length;
  const failed = r.journeys.filter((j) => j.outcome === 'regression').length;
  const lines = r.fix?.changed_lines ?? 0;
  const v = r.verdict.verdict;
  if (v === 'safe') return t('readme.cell_safe', { same: r.journeys.filter((j) => j.outcome === 'same' || j.outcome === 'shifted_ok').length, n });
  if (v === 'fixed' && r.verdict.reason === 'regression') return t('readme.cell_fixed_regression', { failed, n, lines, passed: after });
  if (v === 'fixed') return t('readme.cell_fixed_build', { n, lines, passed: after });
  if (v === 'broken') return t('readme.cell_broken', { failed, n });
  return t('readme.cell_unrunnable');
}

/** Real runs on pull requests, newest pull request first. */
export function prRuns(runs: RunReport[]): RunReport[] {
  return runs.filter((r) => !r.synthetic && r.source.pr !== null && r.source.pr_url !== null)
    .sort((a, b) => b.source.pr! - a.source.pr!);
}

export function readmeBlock(t: Translate, runs: RunReport[], m: Metrics, pagesUrl: string): string {
  const base = pagesUrl.replace(/\/?$/, '/');
  const prs = prRuns(runs);
  const cols = ['col_pr', 'col_change', 'col_ci', 'col_verdict', 'col_credits', 'col_fixer', 'col_time'].map((k) => t(`readme.${k}`));
  const table = prs.length === 0 ? [t('readme.empty')] : [
    `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`,
    ...prs.map((r) => '| ' + [
      `[#${r.source.pr}](${r.source.pr_url})`,
      r.bumps.map((b) => `${b.name} ${b.from ?? '?'} → ${b.to ?? '?'}`).join(', ') || '—',
      r.source.ci ?? '—',
      `[${t(`verdict.${r.verdict.verdict}`)}](${base}runs/${r.run_id}/): ${verdictDetail(t, r)}`,
      String(round1(r.credits_consumed)),
      r.fix?.cost_usd != null ? `$${r.fix.cost_usd.toFixed(2)}` : '—',
      duration(t, r.duration_s),
    ].map(cell).join(' | ') + ' |'),
  ];
  const facts = numberTiles(t, m).filter((x) => x.id !== 'h1')
    .map((x) => `- **${x.id.toUpperCase()} ${t(`site.${x.id}_title`)}: ${x.big ?? '—'}.** ${x.body ?? t('site.not_measured')} `
      + t('readme.source', { files: x.source }));
  return [README_START, '', t('readme.table_intro'), '', ...table, '', t('readme.facts_intro'), '', ...facts, '', README_END].join('\n');
}

/** Replaces the marked block; null when the file has no (or broken) markers, so nothing is written. */
export function replaceReadmeBlock(readme: string, block: string): string | null {
  const a = readme.indexOf(README_START);
  const b = readme.indexOf(README_END);
  if (a < 0 || b < a || readme.indexOf(README_START, a + 1) >= 0) return null;
  return readme.slice(0, a) + block + readme.slice(b + README_END.length);
}

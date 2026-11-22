// Overview, census and "For judges" pages. Numbers come from the run records and census/results.json only.
import type { Translate } from '../i18n.ts';
import { anchor, code, esc, stamp, type PageSpec } from './layout.ts';
import type { Metrics } from './metrics.ts';
import { censusSummary, numbersSection } from './numbers.ts';
import type { RunReport } from './run.ts';
import { sourceLabel } from './words.ts';

export interface CensusRow {
  repo: string;
  url: string | null;
  license: string | null;
  pr_url: string | null;
  bump: string;
  ci: string | null;
  verdict: string;
  control: string | null;
  ci_green_but_broken: boolean;
  run_id: string | null;
}

export interface SiteData {
  runs: RunReport[];
  census: CensusRow[] | null;
  metrics: Metrics;
  installCommand: string;
  replayCommand: string;
  repoUrl: string;
  proofLinks: { key: string; path: string }[];
}

const STEPS = ['build', 'kane', 'verdict', 'fix'] as const;

export function runsTable(t: Translate, runs: RunReport[], root: string): string {
  if (runs.length === 0) return `<p class="empty">${esc(t('site.runs_empty'))}</p>`;
  const rows = runs.map((r) => `<tr><td><a href="${root}runs/${esc(r.run_id)}/index.html">${esc(sourceLabel(t, r))}</a>`
    + `${r.source.pr_title ? `<span class="sub">${esc(r.source.pr_title)}</span>` : ''}`
    + `${r.synthetic ? `<span class="sub warn">${esc(t('site.synthetic'))}</span>` : ''}</td>`
    + `<td>${stamp(t, r.verdict.verdict)}</td><td class="num">${r.journeys.length}</td>`
    + `<td class="num">${r.credits_consumed}</td><td class="num">${esc(r.started_at.slice(0, 10))}</td></tr>`).join('');
  return `<p class="count">${esc(t('site.run_count', { n: runs.length }))}</p><div class="scroll"><table class="ledger">`
    + `<thead><tr><th scope="col">${esc(t('site.col_pr'))}</th><th scope="col">${esc(t('site.col_verdict'))}</th>`
    + `<th scope="col" class="num">${esc(t('site.col_journeys'))}</th><th scope="col" class="num">${esc(t('site.col_credits'))}</th>`
    + `<th scope="col" class="num">${esc(t('site.col_when'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function homePage(d: SiteData): PageSpec {
  return {
    id: 'home',
    title: (t) => `Bumpproof · ${t('site.tagline')}`,
    body: (t, lang) => {
      const steps = STEPS.map((s, i) => `<li><span class="step-n">${i + 1}</span><h3>${esc(t(`site.step_${s}`))}</h3>`
        + `<p>${esc(t(`site.step_${s}_body`))}</p></li>`).join('');
      return `<section class="hero"><h1>${esc(t('site.hero_title'))}</h1><p class="lede">${esc(t('site.hero_body'))}</p>`
        + `<p class="links"><a class="btn" href="#${anchor('runs', lang)}">${esc(t('site.nav_runs'))}</a>`
        + `<a class="btn btn-quiet" href="judges.html">${esc(t('site.nav_judges'))}</a></p></section>`
        + `<section aria-labelledby="how-${lang}"><h2 id="how-${lang}">${esc(t('site.how_title'))}</h2>`
        + `<ol class="pipeline">${steps}</ol></section>`
        + numbersSection(t, d.metrics, lang)
        + `<section id="${anchor('runs', lang)}"><h2>${esc(t('site.runs_title'))}</h2>${runsTable(t, d.runs, '')}</section>`
        + `<section><h2>${esc(t('site.install_title'))}</h2><p>${esc(t('site.install_body'))}</p>${code(d.installCommand)}</section>`
        + `<section class="note"><h2>${esc(t('site.status_title'))}</h2><p>${esc(t('site.status_body'))}</p></section>`;
    },
  };
}

export function censusPage(d: SiteData): PageSpec {
  return {
    id: 'census',
    title: (t) => `${t('site.census_title')} · Bumpproof`,
    body: (t) => {
      const intro = `<h1>${esc(t('site.census_title'))}</h1><p class="lede">${esc(t('site.census_body'))}</p>`;
      if (!d.census || d.census.length === 0) return `${intro}<p class="empty">${esc(t('site.census_empty'))}</p>`;
      const verdicts = [...new Set(d.census.map((c) => c.verdict))];
      const filters = [`<button type="button" data-filter="" aria-pressed="true">${esc(t('site.census_all'))}</button>`,
        ...verdicts.map((v) => `<button type="button" data-filter="${esc(v)}" aria-pressed="false">${esc(t(`verdict.${v}`))}</button>`)].join('');
      const cols = ['col_repo', 'col_bump', 'col_ci', 'col_verdict', 'col_control', 'col_license'];
      const td = (i: number, html: string) => `<td data-label="${esc(t(`site.${cols[i]}`))}">${html}</td>`;
      const rows = d.census.map((c) => `<tr data-verdict="${esc(c.verdict)}">`
        + td(0, c.url ? `<a href="${esc(c.url)}">${esc(c.repo)}</a>` : esc(c.repo))
        + td(1, c.pr_url ? `<a href="${esc(c.pr_url)}">${esc(c.bump)}</a>` : esc(c.bump)) + td(2, esc(c.ci ?? '—'))
        + td(3, `${stamp(t, c.verdict)}${c.ci_green_but_broken ? `<span class="sub warn">${esc(t('site.ci_green_broken'))}</span>` : ''}`)
        + td(4, esc(c.control ? t(`site.control_${c.control}`) : '—')) + td(5, esc(c.license ?? '—')) + '</tr>').join('');
      return `${intro}${censusSummary(t, d.metrics)}<div class="filters" role="group" aria-label="${esc(t('site.census_filter'))}">${filters}</div>`
        + `<p class="count">${esc(t('site.census_count', { n: d.census.length }))}</p><div class="scroll"><table class="ledger" data-census>`
        + `<thead><tr>${cols.map((k) => `<th scope="col">${esc(t(`site.${k}`))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
        + `<p class="count">${esc(t('site.census_attribution'))}</p>`;
    },
  };
}

export function judgesPage(d: SiteData): PageSpec {
  const real = d.runs.find((r) => !r.synthetic);
  return {
    id: 'judges',
    title: (t) => `${t('site.judges_title')} · Bumpproof`,
    body: (t) => {
      const step1 = real
        ? `<li><p>${esc(t('site.judges_step1'))}</p><p><a href="runs/${esc(real.run_id)}/index.html">${esc(sourceLabel(t, real))}</a> ${stamp(t, real.verdict.verdict)}</p></li>`
        : `<li><p>${esc(t('site.judges_step1'))}</p><p class="empty">${esc(t('site.runs_empty'))}</p></li>`;
      const step2 = real
        ? `<li><p>${esc(t('site.judges_step2'))}</p>${code(d.replayCommand.replace('{id}', real.run_id))}</li>`
        : `<li><p>${esc(t('site.judges_step2'))}</p><p class="empty">${esc(t('site.judges_no_run'))}</p></li>`;
      const step3 = `<li><p>${esc(t('site.judges_step3'))}</p><ul class="files">`
        + `<li><a href="${esc(d.repoUrl)}/tree/main/docs/runs"><code>docs/runs/*/run.json</code></a></li>`
        + `<li><a href="${esc(d.repoUrl)}/blob/main/census/results.json"><code>census/results.json</code></a></li></ul></li>`;
      const proof = d.proofLinks.map((p) => `<li><a href="${esc(d.repoUrl)}/blob/main/${esc(p.path)}">${esc(t(`site.${p.key}`))}</a>`
        + ` <code>${esc(p.path)}</code></li>`).join('');
      return `<h1>${esc(t('site.judges_title'))}</h1><p class="lede">${esc(t('site.judges_body'))}</p>`
        + `<section><h2>${esc(t('site.judges_steps_title'))}</h2><ol class="steps">${step1}${step2}${step3}</ol></section>`
        + `<section><h2>${esc(t('site.judges_proof_title'))}</h2><ul class="files">${proof}</ul></section>`;
    },
  };
}

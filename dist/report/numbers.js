import { esc } from "./layout.js";
import { duration } from "./words.js";
const dash = '—';
const num = (n) => (n === null ? dash : String(n));
export function numberTiles(t, m) {
    const { h1, h2, h3, h4, h5, h6 } = m;
    return [
        { id: 'h1', big: h1.prs > 0 ? String(h1.prs) : null, source: 'docs/runs/*/run.json',
            body: h1.prs > 0 ? t('site.h1_body', { safe: h1.safe, regression: h1.fixed_regression, build: h1.fixed_build, broken: h1.broken })
                : null },
        { id: 'h2', big: h2 ? t('site.of', { a: h2.runnable, b: h2.run }) : null, source: 'census/results.json · census/candidates.json',
            body: h2 ? t('site.h2_body', { evaluated: num(h2.evaluated), eligible: num(h2.eligible), run: h2.run, runnable: h2.runnable }) : null },
        { id: 'h3', big: h3 ? String(h3.count) : null, source: 'census/results.json',
            body: h3 ? t('site.h3_body', { n: h3.count, runnable: h3.runnable }) : null },
        { id: 'h4', big: h4 && h4.checked > 0 ? t('site.of', { a: h4.false_alarm, b: h4.checked }) : null, source: 'census/results.json',
            body: h4 && h4.checked > 0 ? t('site.h4_body', { same: h4.same, alarm: h4.false_alarm, inconclusive: h4.inconclusive }) : null },
        { id: 'h5', big: h5.loop_median_s === null ? null : duration(t, h5.loop_median_s), source: 'docs/runs/*/run.json · census/kredit.json',
            body: h5.loop_median_s === null ? null : [
                t('site.h5_loop', { n: h5.loops }),
                h5.pr_credits_median === null ? '' : t('site.h5_pr', { credits: h5.pr_credits_median, n: h5.prs }),
                h5.ratio === null ? '' : t('site.h5_ratio', { author: num(h5.author_mean), replay: num(h5.replay_mean), ratio: h5.ratio }),
            ].filter(Boolean).join(' ') },
        { id: 'h6', big: h6.total.attempted > 0 ? t('site.of', { a: h6.total.fixed, b: h6.total.attempted }) : null,
            source: 'docs/runs/*/run.json · census/runs/*/run.json',
            body: h6.total.attempted > 0 ? t('site.h6_body', { demo: h6.demo.fixed, demo_n: h6.demo.attempted, census: h6.census.fixed,
                census_n: h6.census.attempted, attempts: h6.total.attempts }) : null },
    ];
}
export function numbersSection(t, m, lang) {
    const id = lang === 'en' ? 'measured' : `measured-${lang}`;
    const items = numberTiles(t, m).map((x) => `<li class="metric"><p class="metric-id">${x.id.toUpperCase()}</p>`
        + `<p class="metric-n${x.big === null ? ' metric-none' : ''}">${esc(x.big ?? dash)}</p>`
        + `<h3>${esc(t(`site.${x.id}_title`))}</h3><p>${esc(x.body ?? t('site.not_measured'))}</p>`
        + `<p class="metric-src"><code>${esc(x.source)}</code></p></li>`).join('');
    return `<section aria-labelledby="${id}"><h2 id="${id}">${esc(t('site.measured_title'))}</h2>`
        + `<p class="count">${esc(t('site.measured_body'))}</p><ul class="metrics">${items}</ul></section>`;
}
/** One line over the census table, from the same numbers as the overview. */
export function censusSummary(t, m) {
    if (!m.h2 || !m.h3 || !m.h4)
        return '';
    return `<p class="facts">${esc(t('site.census_summary', { run: m.h2.run, runnable: m.h2.runnable, evaluated: num(m.h2.evaluated),
        green: m.h3.count, alarm: m.h4.false_alarm, checked: m.h4.checked }))}</p>`;
}

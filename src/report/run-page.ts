// One page per run: verdict, journeys on both sides, where it broke, the fix and its patch, the timeline.
import type { Translate } from '../i18n.ts';
import { anchor, code, esc, stamp, type PageSpec } from './layout.ts';
import { short, type JourneyRun, type RunReport } from './run.ts';
import { bumpList, duration, sourceLabel, timelineText } from './words.ts';

function cell(t: Translate, r: JourneyRun | null): string {
  if (!r) return '<td class="dim">—</td>';
  const healed = r.healed && r.status === 'passed' ? ` <span class="tag">${esc(t('outcome.shifted_ok'))}</span>` : '';
  const secs = r.seconds === null ? '' : `<span class="sub num">${esc(duration(t, r.seconds))}</span>`;
  return `<td><span class="st st-${esc(r.status)}">${esc(t(`status.${r.status}`))}</span>${healed}${secs}</td>`;
}

/** Diff lines get a class so additions and removals read at a glance; everything is escaped. */
export function patchHtml(patch: string): string {
  const lines = patch.replace(/\n$/, '').split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') ? 'd-file' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : '';
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  });
  return `<pre class="patch"><code>${lines.join('\n')}</code></pre>`;
}

export function runPage(run: RunReport, patch: string | null, replayCommand: string): PageSpec {
  return {
    id: 'run',
    title: (t) => `${t('site.run_title', { id: run.run_id })} · Bumpproof`,
    body: (t, lang) => {
      const parts: string[] = [`<p class="crumb"><a href="../../index.html#${anchor('runs', lang)}">${esc(t('site.run_back'))}</a></p>`];
      if (run.synthetic) parts.push(`<p class="banner">${esc(t('site.synthetic'))}</p>`);
      const pr = run.source.pr_url
        ? `<a href="${esc(run.source.pr_url)}">${esc(sourceLabel(t, run))}</a>` : esc(sourceLabel(t, run));
      parts.push(`<section class="verdict-head"><div>${stamp(t, run.verdict.verdict, 'big')}</div><div>`
        + `<h1>${esc(run.source.pr_title ?? t('site.run_title', { id: run.run_id }))}</h1><p class="src">${pr}</p>`
        + `<p class="lede">${esc(t(`reason.${run.verdict.reason}`))}</p>`
        + `<p class="facts num">${esc(t('site.run_facts', { time: duration(t, run.duration_s), credits: run.credits_consumed,
          kane: run.kane_cli_version ?? '?' }))}</p>`
        + (run.source.ci ? `<p class="facts">${esc(t('site.ci', { ci: run.source.ci }))}</p>` : '')
        + `</div></section>`);
      parts.push(`<section><h2>${esc(t('site.run_bumps'))}</h2><p class="mono">${esc(bumpList(run, t('comment.none')))}</p>`
        + `<p class="facts mono">${esc(t('replay.refs', { base: run.base.ref, base_sha: short(run.base.sha), head: run.head.ref,
          head_sha: short(run.head.sha) }))}</p></section>`);

      const withFix = run.journeys.some((j) => j.after_fix);
      const rows = run.journeys.map((j) => `<tr><th scope="row" class="mono">${esc(j.name)}</th>${cell(t, j.base)}${cell(t, j.head)}`
        + `${withFix ? cell(t, j.after_fix) : ''}<td><span class="oc oc-${esc(j.outcome)}">${esc(t(`outcome.${j.outcome}`))}</span></td></tr>`).join('');
      parts.push(`<section><h2>${esc(t('site.run_journeys'))}</h2><div class="scroll"><table class="ledger"><thead><tr>`
        + `<th scope="col">${esc(t('comment.col_journey'))}</th><th scope="col">${esc(t('side.base'))}</th>`
        + `<th scope="col">${esc(t('side.head'))}</th>${withFix ? `<th scope="col">${esc(t('side.after_fix'))}</th>` : ''}`
        + `<th scope="col">${esc(t('comment.col_outcome'))}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);

      const broke = run.journeys.filter((j) => (j.head?.status === 'failed' && j.head.failed_step)
        || j.new_console_errors.length || j.new_network_errors.length);
      if (broke.length) {
        parts.push(`<section><h2>${esc(t('site.run_failure'))}</h2>${broke.map((j) => `<div class="failure"><h3 class="mono">${esc(j.name)}</h3>`
          + (j.head?.failed_step ? `<p>${esc(j.head.failed_step)}</p>` : '')
          + (j.head?.remark ? `<blockquote>${esc(j.head.remark)}</blockquote>` : '')
          + (j.new_console_errors.length ? `<p class="warnline">${esc(t('site.console_warn'))}: <code>${esc(j.new_console_errors.join(' · '))}</code></p>` : '')
          + (j.new_network_errors.length ? `<p class="warnline">${esc(t('site.network_warn'))}: <code>${esc(j.new_network_errors.join(' · '))}</code></p>` : '')
          + '</div>').join('')}</section>`);
      }

      if (run.fix) {
        const meta = [t('site.fix_attempts', { attempts: run.fix.attempts, lines: run.fix.changed_lines }),
          ...(run.fix.cost_usd === null ? [] : [t('site.fix_cost', { usd: run.fix.cost_usd.toFixed(2) })])].join(' · ');
        parts.push(`<section><h2>${esc(t('site.run_fix'))}</h2><p class="facts num">${esc(meta)}</p>`
          + (run.fix.explanation ? `<blockquote>${esc(run.fix.explanation)}</blockquote>` : '')
          + `<h3>${esc(t('site.run_patch'))}</h3>${patch ? patchHtml(patch) : `<p class="empty">${esc(t('site.no_patch'))}</p>`}</section>`);
      }

      if (run.shots.length) {
        parts.push(`<section><h2>${esc(t('site.run_shots'))}</h2><p>${esc(t('site.run_shots_note'))}</p><div class="shots">${run.shots.map((s) => `<figure>`
          + `<a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(t('site.shot_alt', { journey: s.journey, side: t(`side.${s.side}`) }))}" loading="lazy"></a>`
          + `<figcaption><span class="mono">${esc(s.journey)}</span> · ${esc(t(`side.${s.side}`))}</figcaption></figure>`).join('')}</div></section>`);
      }

      const timeline = [...run.timeline].sort((a, b) => a.at_s - b.at_s).map((e) => `<li class="tl-${esc(e.tone)}">`
        + `<span class="tl-at num">${esc(duration(t, e.at_s))}</span><span>${esc(timelineText(t, e))}</span></li>`).join('');
      parts.push(`<section><h2>${esc(t('site.run_timeline'))}</h2><ol class="timeline">${timeline}</ol>`
        + `<p>${esc(t('site.run_replay'))}</p>${code(replayCommand.replace('{id}', run.run_id))}</section>`);
      return parts.join('');
    },
  };
}

// The pull request comment the GitHub Action posts (PRD D9: check and comment only, no LLM key in GitHub).
// It describes a build-and-start check, so it says plainly that browser journeys and fixes did not run.
import { shortSha } from "./git.js";
import { cell } from "./report/markdown.js";
/** First line of every Action comment; the Action finds and updates its earlier comment by it. */
export const ACTION_MARKER = '<!-- bumpproof-action -->';
/** Second line: the outcome in a form the Action reads without depending on the comment language. */
export const outcomeLine = (o) => `<!-- bumpproof-outcome: ${o} -->`;
const ICON = { both_built: '✅', head_build_failed: '❌', base_build_failed: '⚠️' };
function footer(t, o) {
    return ['', `> ${t('action.no_journeys')}`, '', `<sub>${t('action.footer', { version: o.version, url: o.repoUrl })}</sub>`];
}
export function renderCheckComment(rec, t, o) {
    const ref = (r) => `\`${shortSha(r.sha)}\``;
    const out = [ACTION_MARKER, outcomeLine(rec.outcome), `## ${ICON[rec.outcome]} ${t('action.title')}`, '',
        t('check.title', { base: ref(rec.base), head: ref(rec.head) }), '', t('check.app_dir', { dir: `\`${cell(rec.app_dir || '.')}\`` }), ''];
    for (const s of rec.sides) {
        const side = t(`check.side_${s.side}`);
        if (s.built) {
            out.push(`- ✓ ${t('check.side_ok', { side, s: s.seconds })}`);
            continue;
        }
        const where = s.failed_at === 'plan' ? t(`sandbox.plan_${s.plan_problem ?? 'unknown'}`) : t(`sandbox.failed_${s.failed_at ?? 'start'}`);
        out.push(`- ✗ ${t('check.side_fail', { side, where, s: s.seconds })}`);
        const tail = s.log_tail.slice(-o.logLines).map((l) => l.replace(/```/g, "'''"));
        if (tail.length > 0)
            out.push('', `<details><summary>${t('action.log', { side })}</summary>`, '', '```text', ...tail, '```', '', '</details>', '');
    }
    if (!rec.sides.some((s) => s.side === 'head'))
        out.push(`- ${t('check.head_skipped')}`);
    out.push('', `**${t(`check.outcome_${rec.outcome}`)}**`);
    return [...out, ...footer(t, o)].join('\n') + '\n';
}
/** Comment for a check that never started (disk, port, Docker or git), so the PR still gets an answer. */
export function renderRefusalComment(reason, t, o) {
    return [ACTION_MARKER, outcomeLine('not_started'), `## ⚠️ ${t('action.title')}`, '', t('check.refused', { reason: cell(reason) }), ...footer(t, o)].join('\n') + '\n';
}

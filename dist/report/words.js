import { splitSeconds } from "./run.js";
export function duration(t, seconds) {
    const { m, s } = splitSeconds(seconds);
    return m > 0 ? t('duration.minutes', { m, s: String(s).padStart(2, '0') }) : t('duration.seconds', { s });
}
/** Translates the values that are themselves keys (side, status, verdict); the rest pass through. */
export function timelineText(t, e) {
    const vars = { ...e.vars, key: e.key };
    if (typeof vars.side === 'string')
        vars.side = t(`side.${vars.side}`);
    if (typeof vars.status === 'string')
        vars.status = t(`status.${vars.status}`).toLowerCase();
    if (typeof vars.verdict === 'string')
        vars.verdict = t(`verdict.${vars.verdict}`);
    const key = `timeline.${e.key}`;
    const text = t(key, vars);
    return text === key ? t('timeline.unknown', vars) : text;
}
/** One cell of the journeys table: "Passed · 41 s", "Passed, healed", "Failed". */
export function runCell(t, r) {
    if (!r)
        return '—';
    const label = t(`status.${r.status}`);
    return r.seconds === null ? label : `${label} · ${duration(t, r.seconds)}`;
}
export function bumpList(run, none) {
    if (run.bumps.length === 0)
        return none;
    return run.bumps.map((b) => `${b.name} ${b.from ?? '?'} → ${b.to ?? '?'}`).join(', ');
}
/** `https://github.com/owner/repo` (or a bare `owner/repo` in older records) as `github.com/owner/repo`. */
export function repoName(repo) {
    const r = repo.trim().replace(/^https?:\/\//, '').replace(/(\.git)?\/*$/, '');
    return /^[^/]+\.[^/]+\//.test(r) ? r : `github.com/${r}`;
}
/** Pull request label: "github.com/owner/repo #7" or the two refs for a local run. */
export function sourceLabel(t, run) {
    if (run.source.repo && run.source.pr !== null)
        return `${repoName(run.source.repo)} #${run.source.pr}`;
    return `${t('site.local_run')}: ${run.base.ref} → ${run.head.ref}`;
}
export const VERDICT_ICON = { safe: '✅', fixed: '🛠️', broken: '❌', unrunnable: '⚠️' };

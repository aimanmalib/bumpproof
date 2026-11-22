import { bumpList, duration, runCell, VERDICT_ICON } from "./words.js";
/** Pipes and line breaks would break a table row; backticks would open code. */
export function cell(s) {
    return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'").trim();
}
export function renderComment(run, t, o) {
    const v = run.verdict.verdict;
    const out = [`## ${VERDICT_ICON[v]} ${t('comment.title', { verdict: t(`verdict.${v}`) })}`, ''];
    if (run.synthetic)
        out.push(`> ${t('comment.synthetic')}`, '');
    out.push(t(`reason.${run.verdict.reason}`), '');
    if (run.source.pr_title)
        out.push(t('comment.pr', { title: cell(run.source.pr_title) }));
    out.push(t('comment.bumps', { list: cell(bumpList(run, t('comment.none'))) }), '');
    const withFix = run.journeys.some((j) => j.after_fix);
    const head = [t('comment.col_journey'), t('comment.col_base'), t('comment.col_head'),
        ...(withFix ? [t('comment.col_fix')] : []), t('comment.col_outcome')];
    out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const j of run.journeys) {
        const row = [`\`${cell(j.name)}\``, runCell(t, j.base), runCell(t, j.head), ...(withFix ? [runCell(t, j.after_fix)] : []),
            t(`outcome.${j.outcome}`)];
        out.push(`| ${row.join(' | ')} |`);
    }
    out.push('');
    for (const j of run.journeys) {
        if (j.head?.status === 'failed' && j.head.failed_step) {
            out.push(`- ${t('comment.failed_step', { name: cell(j.name), step: cell(j.head.failed_step) })}`);
            if (j.head.remark)
                out.push(`  ${t('comment.remark', { remark: cell(j.head.remark) })}`);
            if (j.head.result_code !== null && j.head.result_code === o.bugCode)
                out.push(`  ${t('comment.bug', { code: j.head.result_code })}`);
        }
        if (j.new_console_errors.length)
            out.push(`- ${t('comment.console', { list: j.new_console_errors.map(cell).join('; ') })}`);
        if (j.new_network_errors.length)
            out.push(`- ${t('comment.network', { list: j.new_network_errors.map(cell).join('; ') })}`);
    }
    if (out[out.length - 1] !== '')
        out.push('');
    if (run.fix) {
        out.push(`### ${t('comment.fix_title')}`, '');
        if (run.fix.status === 'fixed') {
            out.push(t('comment.fix_summary', { lines: run.fix.changed_lines, attempts: run.fix.attempts,
                files: run.fix.files.map((f) => `\`${cell(f)}\``).join(', ') || t('comment.none') }));
            if (run.fix.explanation)
                out.push('', ...run.fix.explanation.split('\n').map((l) => `> ${l}`));
        }
        else {
            out.push(t('comment.fix_failed', { attempts: run.fix.attempts }));
        }
        out.push('');
    }
    out.push(t('comment.cost', { credits: run.credits_consumed, time: duration(t, run.duration_s) }));
    if (o.runUrl)
        out.push('', t('comment.run_page', { url: o.runUrl }));
    out.push('', '---', `<sub>${t('comment.footer', { kane: run.kane_cli_version ?? '?', version: o.version })}</sub>`);
    return `${out.join('\n')}\n`;
}

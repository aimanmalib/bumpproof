import { NOTES_TAG } from "./notes.js";
/** Kane CLI's findings about the failure; a head that did not build has none. */
export function kaneFacts(f, resultCode) {
    if (f.kind === 'build')
        return [];
    return [
        ...(f.step ? [{ label: 'step', value: f.step }] : []),
        ...(f.remark ? [{ label: 'remark', value: f.remark }] : []),
        ...(resultCode === null ? [] : [{ label: 'result_code', value: String(resultCode) }]),
        ...(f.console ?? []).map((value) => ({ label: 'console', value })),
        ...(f.network ?? []).map((value) => ({ label: 'network', value })),
    ];
}
/** Keeps each release-notes block's opening line and replaces its text with one line saying what was left out. */
export function condenseNotes(prompt, body) {
    const re = new RegExp(`(<${NOTES_TAG}\\b[^>]*>)\\n([\\s\\S]*?)\\n(</${NOTES_TAG}>)`, 'g');
    return prompt.replace(re, (_m, open, text, close) => `${open}\n${body(Math.max(1, Math.round(Buffer.byteLength(text, 'utf8') / 1024)))}\n${close}`);
}
/** 1-based lines covered by each quoted text, so a step name that is also a journey heading is not taken for Kane CLI's. */
export function quotedLines(prompt, quoted) {
    const out = new Set();
    for (const q of quoted) {
        const at = q.trim() === '' ? -1 : prompt.indexOf(q);
        if (at === -1)
            continue;
        const first = prompt.slice(0, at).split('\n').length;
        q.split('\n').forEach((_l, i) => out.add(first + i));
    }
    return out;
}
/** The 1-based prompt lines that hold a fact's value, per fact, outside the quoted lines. */
export function factLines(prompt, facts, quoted = []) {
    const lines = prompt.split('\n');
    const skip = quotedLines(prompt, quoted);
    return facts.map((f) => {
        // Whole words only, so a short value such as a result code does not match inside another number.
        const re = new RegExp(`(?<![\\w])${f.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`);
        return lines.flatMap((l, i) => (re.test(l) && !skip.has(i + 1) ? [i + 1] : []));
    });
}
const cell = (s) => {
    const flat = s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return flat.includes('`') ? flat : `\`${flat}\``;
};
/** A fence longer than any backtick run inside the text, so the prompt cannot close it. */
function fence(text) {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    return '`'.repeat(longest + 1);
}
/** The prompt with line numbers; lines that carry Kane CLI's words get a `K` in the gutter. */
export function numbered(prompt, kaneLines) {
    const lines = prompt.split('\n');
    const w = String(lines.length).length;
    return lines.map((l, i) => `${kaneLines.has(i + 1) ? 'K' : ' '} ${String(i + 1).padStart(w)} │ ${l}`.trimEnd()).join('\n');
}
export function renderPromptFile(t, c) {
    const out = [`# ${t('prompt_file.title', { id: c.run_id })}`, ''];
    out.push(c.rebuilt ? t('prompt_file.rebuilt', { templates: c.rebuilt.templates }) : t('prompt_file.saved'), '');
    if (c.rebuilt?.missing.length)
        out.push(t('prompt_file.missing', { list: c.rebuilt.missing.join('; ') }), '');
    out.push(t('prompt_file.notes'), '', `## ${t('prompt_file.kane_title')}`, '');
    if (c.kane.length === 0)
        out.push(t('prompt_file.no_kane'), '');
    else {
        const first = c.prompts[0] ?? '';
        const where = factLines(first, c.kane, c.quoted);
        out.push(`| ${t('prompt_file.col_fact')} | ${t('prompt_file.col_value')} | ${t('prompt_file.col_line')} |`, '|---|---|---|');
        c.kane.forEach((f, i) => {
            const at = where[i];
            out.push(`| ${t(`prompt_file.${f.label}`)} | ${cell(f.value)} | ${at.length ? at.join(', ') : t('prompt_file.not_sent')} |`);
        });
        out.push('', t('prompt_file.marked'), '');
    }
    c.prompts.forEach((p, i) => {
        const marked = new Set(factLines(p, c.kane, c.quoted).flat());
        const f = fence(p);
        out.push(`## ${t('prompt_file.attempt', { n: i + 1 })}`, '', `${f}text`, numbered(p, marked), f, '');
    });
    return `${out.join('\n').trimEnd()}\n`;
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const NAV = [
    { id: 'home', href: 'index.html', key: 'site.nav_home' },
    { id: 'runs', href: 'index.html#runs', key: 'site.nav_runs' },
    { id: 'census', href: 'census.html', key: 'site.nav_census' },
    { id: 'judges', href: 'judges.html', key: 'site.nav_judges' },
];
/** Ids are unique across the language copies: `runs`, `runs-ms`. */
export const anchor = (id, lang) => (lang === 'en' ? id : `${id}-${lang}`);
function header(t, s, page, lang) {
    const links = NAV.map((n) => {
        const href = n.href.includes('#') ? n.href.replace(/#(.+)$/, (_m, id) => `#${anchor(id, lang)}`) : n.href;
        const current = n.id === page || (page === 'run' && n.id === 'runs');
        return `<a href="${s.root}${href}"${current ? ' aria-current="page"' : ''}>${esc(t(n.key))}</a>`;
    }).join('');
    return `<header class="bar"><a class="mark" href="${s.root}index.html">Bumpproof</a>`
        + `<nav class="nav" aria-label="${esc(t('site.nav_home'))}">${links}</nav></header>`;
}
function langSwitch(s) {
    const t = s.translators.get('en');
    const buttons = s.languages.map((l, i) => `<button type="button" data-set="${esc(l)}" aria-pressed="${i === 0}">${esc(l === 'ms' ? 'BM' : l.toUpperCase())}</button>`).join('');
    return `<div class="lang" role="group" aria-label="${esc(t('site.lang_label'))} / ${esc(s.translators.get('ms')?.('site.lang_label') ?? '')}">${buttons}</div>`;
}
export function renderPage(spec, s) {
    const en = s.translators.get(s.languages[0]);
    const copies = s.languages.map((lang, i) => {
        const t = s.translators.get(lang);
        return `<div class="copy" lang="${esc(lang)}" data-lang="${esc(lang)}"${i === 0 ? '' : ' hidden'}>`
            + `<a class="skip" href="#main-${esc(lang)}">${esc(t('site.skip'))}</a>`
            + header(t, s, spec.id, lang)
            + `<main id="main-${esc(lang)}">${spec.body(t, lang)}</main>`
            + `<footer class="foot"><span>${esc(t('site.footer', { version: s.version }))}</span>`
            + `<a href="${esc(s.repoUrl)}">${esc(t('site.repo_link'))}</a></footer></div>`;
    }).join('\n');
    return `<!doctype html>
<html lang="${esc(s.languages[0])}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title(en))}</title>
<meta name="description" content="${esc(en('site.tagline'))}">
<link rel="preload" href="${s.root}assets/fonts/ibm-plex-sans-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${s.root}assets/site.css">
</head>
<body>
${langSwitch(s)}
${copies}
<script src="${s.root}assets/site.js" defer></script>
</body>
</html>
`;
}
/** A verdict stamp: the one strong colour on a page. */
export function stamp(t, verdict, size = 'small') {
    return `<span class="stamp stamp-${esc(verdict)} stamp-${size}">${esc(t(`verdict.${verdict}`))}</span>`;
}
export function code(text) {
    return `<pre class="cmd"><code>${esc(text)}</code></pre>`;
}

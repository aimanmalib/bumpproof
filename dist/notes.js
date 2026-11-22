import { versionOf } from "./bump.js";
/** Default fetcher: plain GET with a timeout; network errors become `undefined`. */
export function httpFetcher(timeoutMs) {
    return async (url) => {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
            return { status: res.status, text: await res.text() };
        }
        catch {
            return undefined;
        }
    };
}
/** `@scope/name` must keep the `@` and encode the slash for the registry. */
export function registryUrl(registry, pkg) {
    return `${registry.replace(/\/+$/, '')}/${pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)}`;
}
/** `owner/repo` from the many shapes of npm `repository` (string, object, git+ssh, shorthand). */
export function githubRepoOf(repository) {
    const raw = typeof repository === 'string' ? repository
        : repository && typeof repository === 'object' && typeof repository.url === 'string'
            ? repository.url : '';
    const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(raw);
    const m = short ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(raw);
    return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}
export function cmpVersion(a, b) {
    for (let i = 0; i < 3; i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return 0;
}
/** True when `v` is after `from` and not after `to` (from may be unknown: then only `<= to`). */
export function inRange(v, from, to) {
    const x = versionOf(v);
    const hi = versionOf(to);
    if (!x || !hi)
        return false;
    const lo = versionOf(from);
    return cmpVersion(x, hi) <= 0 && (!lo || cmpVersion(x, lo) > 0);
}
/** Monorepos tag releases as `pkg@1.2.3`; when any tag names the package, only those tags count. */
export function pickReleases(list, pkg, from, to) {
    const tagged = list.filter((r) => typeof r.tag_name === 'string' && !r.draft);
    const named = tagged.filter((r) => r.tag_name.startsWith(`${pkg}@`));
    const pool = named.length > 0 ? named : tagged;
    const versionPart = (tag) => (tag.startsWith(`${pkg}@`) ? tag.slice(pkg.length + 1) : tag.replace(/^[^\d]*/, ''));
    return pool
        .filter((r) => !r.prerelease && inRange(versionPart(r.tag_name), from, to))
        .sort((a, b) => cmpVersion(versionOf(versionPart(a.tag_name)), versionOf(versionPart(b.tag_name))));
}
/** The part of a CHANGELOG between the heading for `to` and the heading for `from`; falls back to the top. */
export function changelogSection(text, from, to) {
    const lines = text.split(/\r?\n/);
    const isHeading = (l) => /^(#{1,4}\s|\[?v?\d+\.\d+)/.test(l);
    const headingVersion = (l) => /v?(\d+\.\d+\.\d+)/.exec(l)?.[1];
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!isHeading(l))
            continue;
        const v = headingVersion(l);
        if (!v)
            continue;
        if (start < 0 && inRange(v, from, to))
            start = i;
        else if (start >= 0 && !inRange(v, from, to)) {
            end = i;
            break;
        }
    }
    return (start >= 0 ? lines.slice(start, end) : lines).join('\n').trim();
}
/** Crude text from an HTML page: drops scripts, styles and tags. Markdown passes through unchanged. */
export function textOf(body) {
    if (!/<html[\s>]|<body[\s>]/i.test(body))
        return body;
    return body
        .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim();
}
/** Cuts to `maxBytes` of UTF-8 without splitting a character. */
export function cutBytes(text, maxBytes) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes)
        return { text, truncated: false };
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80)
        end--;
    return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}
async function ghJson(d, path) {
    const r = await d.run(d.cfg.github.command, ['api', path], { timeoutMs: d.cfg.notes.timeout_ms });
    if (!r.ok)
        return undefined;
    try {
        return JSON.parse(r.stdout);
    }
    catch {
        return undefined;
    }
}
async function ghRaw(d, path) {
    const r = await d.run(d.cfg.github.command, ['api', '-H', 'Accept: application/vnd.github.raw', path], { timeoutMs: d.cfg.notes.timeout_ms });
    return r.ok && r.stdout.trim() !== '' ? r.stdout : undefined;
}
/** Collects notes for one bump. Never throws: a missing source is simply absent from `sources`. */
export async function fetchNotes(d, pkg, from, to) {
    const parts = [];
    const sources = [];
    let repo = null;
    const meta = await d.fetch(registryUrl(d.cfg.notes.registry, pkg));
    if (meta && meta.status === 200) {
        try {
            repo = githubRepoOf(JSON.parse(meta.text).repository);
        }
        catch { /* registry answered with something that is not JSON */ }
    }
    if (repo) {
        const list = await ghJson(d, `repos/${repo}/releases?per_page=${d.cfg.notes.max_releases}`);
        const picked = Array.isArray(list) ? pickReleases(list, pkg, from, to) : [];
        if (picked.length > 0) {
            sources.push({ kind: 'releases', url: `https://github.com/${repo}/releases` });
            for (const r of picked)
                parts.push(`## ${String(r.name || r.tag_name)}\n${typeof r.body === 'string' ? r.body.trim() : ''}`);
        }
        else {
            for (const file of d.cfg.notes.changelog_files) {
                const raw = await ghRaw(d, `repos/${repo}/contents/${file}`);
                if (!raw)
                    continue;
                sources.push({ kind: 'changelog', url: `https://github.com/${repo}/blob/HEAD/${file}` });
                parts.push(changelogSection(raw, from, to));
                break;
            }
        }
    }
    const guide = d.cfg.notes.guides[pkg];
    if (guide) {
        const g = await d.fetch(guide);
        if (g && g.status === 200) {
            sources.push({ kind: 'guide', url: guide });
            parts.push(`## Upgrade guide\n${textOf(g.text)}`);
        }
    }
    const cut = cutBytes(parts.join('\n\n'), d.cfg.notes.max_kb * 1024);
    return { pkg, from, to, repo, sources, text: cut.text, truncated: cut.truncated };
}
export const NOTES_TAG = 'untrusted_release_notes';
const TAG = NOTES_TAG;
/** Wraps notes in the data markers. A closing marker inside the notes is defused so it cannot end the block early. */
export function notesBlock(n) {
    const body = (n.text || '(no release notes found)').replace(new RegExp(`</?\\s*${TAG}`, 'gi'), (m) => m.replace('<', '&lt;'));
    const attr = (s) => (s ?? 'unknown').replace(/["<>]/g, '');
    const src = n.sources.map((s) => s.url).join(' ') || 'none';
    return `<${TAG} package="${attr(n.pkg)}" from="${attr(n.from)}" to="${attr(n.to)}" sources="${attr(src)}"${n.truncated ? ' truncated="true"' : ''}>\n${body}\n</${TAG}>`;
}

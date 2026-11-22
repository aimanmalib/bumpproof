// Kane CLI evidence packs (.evidence, a zip) and the publication scan.
// Raw packs are never published (PRD D14). We pull out what a report needs, strip who ran the test,
// cookies, auth headers and private Test Manager links, and refuse to publish text that still holds them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
export const REDACTED = '[redacted]';
export function readPack(bytes) {
    return new Map(Object.entries(unzipSync(bytes)));
}
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
export function domainAllowed(domain, allow) {
    const d = domain.toLowerCase();
    return allow.some((a) => d === a.toLowerCase() || d.endsWith('.' + a.toLowerCase()));
}
function isFileName(domain, rules) {
    const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
    return rules.email_ignore_tlds.includes(tld);
}
/** Applies `fn` to the text between occurrences of the public strings, leaving those strings as they are. */
export function outsidePublic(text, publics, fn) {
    const list = (publics ?? []).filter((p) => p.length > 0);
    if (list.length === 0)
        return fn(text);
    const re = new RegExp(list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
        out += fn(text.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
    }
    return out + fn(text.slice(last));
}
/** Replaces secrets given by value, private links and e-mail addresses outside the allowlist. */
export function scrubText(text, rules, secrets = []) {
    return outsidePublic(text, rules.public_strings, (part) => scrubPart(part, rules, secrets));
}
function scrubPart(text, rules, secrets) {
    let out = text;
    for (const s of secrets)
        if (s.length >= 3)
            out = out.split(s).join(REDACTED);
    for (const p of rules.private_url_patterns)
        out = out.replace(new RegExp(p, 'gi'), REDACTED);
    return out.replace(EMAIL, (m, domain) => domainAllowed(domain, rules.email_allowlist) || isFileName(domain, rules) ? m : REDACTED);
}
/** Deep copy without identity keys or sensitive headers; every string is scrubbed. */
export function sanitize(value, rules, secrets = []) {
    const strip = new Set(rules.strip_keys.map((k) => k.toLowerCase()));
    const walk = (v) => {
        if (typeof v === 'string')
            return scrubText(v, rules, secrets);
        if (Array.isArray(v)) {
            return v.filter((x) => !(isHeaderPair(x) && strip.has(String(x.name).toLowerCase()))).map(walk);
        }
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v))
                if (!strip.has(k.toLowerCase()))
                    out[k] = walk(x);
            return out;
        }
        return v;
    };
    return walk(value);
}
function isHeaderPair(x) {
    return typeof x === 'object' && x !== null && 'name' in x && 'value' in x;
}
/** JSON entries parsed, NDJSON entries parsed line by line; other entries skipped. */
export function jsonRecords(entries) {
    const out = [];
    for (const [path, bytes] of entries) {
        const ext = extname(path).toLowerCase();
        if (ext !== '.json' && ext !== '.ndjson')
            continue;
        const text = strFromU8(bytes);
        const parts = ext === '.json' ? [text] : text.split('\n').filter((l) => l.trim() !== '');
        for (const p of parts) {
            try {
                out.push({ path, record: JSON.parse(p) });
            }
            catch { /* not JSON: skip */ }
        }
    }
    return out;
}
/**
 * Walks every JSON record and collects console errors (objects with level error/severe and a message)
 * and failed requests (objects with a numeric status >= `minStatus` and a url). Output is sanitized.
 */
export function summarize(entries, rules, opts) {
    const consoleErrors = new Set();
    const network = new Set();
    const visit = (v) => {
        if (Array.isArray(v)) {
            v.forEach(visit);
            return;
        }
        if (!v || typeof v !== 'object')
            return;
        const o = v;
        const level = typeof o.level === 'string' ? o.level.toLowerCase() : typeof o.type === 'string' ? o.type.toLowerCase() : '';
        const msg = typeof o.text === 'string' ? o.text : typeof o.message === 'string' ? o.message : null;
        if ((level === 'error' || level === 'severe') && msg)
            consoleErrors.add(msg);
        if (typeof o.status === 'number' && o.status >= opts.min_status && typeof o.url === 'string') {
            const method = typeof o.method === 'string' ? o.method.toUpperCase() + ' ' : '';
            network.add(`${o.status} ${method}${stripQuery(o.url)}`);
        }
        Object.values(o).forEach(visit);
    };
    for (const { record } of jsonRecords(entries))
        visit(record);
    const secrets = opts.secrets ?? [];
    const images = [...entries.keys()].filter((p) => opts.image_exts.includes(extname(p).slice(1).toLowerCase())).sort();
    return {
        console_errors: [...consoleErrors].map((s) => scrubText(s, rules, secrets)),
        network_errors: [...network].map((s) => scrubText(s, rules, secrets)),
        screenshots: images,
    };
}
/** Query strings often carry tokens; the report only needs the path. */
export function stripQuery(url) {
    const i = url.search(/[?#]/);
    return i === -1 ? url : url.slice(0, i);
}
/** `match` never holds a secret value itself, only a masked hint, so the scan output is safe to print. */
export function scanText(file, text, rules, secrets) {
    const out = [];
    const strip = rules.strip_keys.map((k) => k.toLowerCase());
    text.split('\n').forEach((lineText, i) => {
        const line = i + 1;
        const parts = [];
        outsidePublic(lineText, rules.public_strings, (part) => { parts.push(part); return part; });
        for (const s of secrets)
            if (s.length >= 3 && parts.some((p) => p.includes(s)))
                out.push({ file, line, kind: 'secret', match: mask(s) });
        const starts = new Set(); // two patterns matching the same link count once
        for (const p of rules.private_url_patterns) {
            for (const m of lineText.matchAll(new RegExp(p, 'gi'))) {
                if (!starts.has(m.index))
                    out.push({ file, line, kind: 'private_url', match: mask(m[0]) });
                starts.add(m.index);
            }
        }
        for (const m of lineText.matchAll(EMAIL)) {
            if (!domainAllowed(m[1], rules.email_allowlist) && !isFileName(m[1], rules)) {
                out.push({ file, line, kind: 'email', match: mask(m[0]) });
            }
        }
        for (const m of lineText.matchAll(/"([\w-]+)"\s*:/g)) {
            if (strip.includes(m[1].toLowerCase()))
                out.push({ file, line, kind: 'key', match: m[1] });
        }
    });
    return out;
}
export function mask(s) {
    return s.length <= 4 ? '****' : `${s.slice(0, 2)}…(${s.length})`;
}
/** Scans every text file under `dirs` (missing dirs are skipped). Binary files are skipped by extension. */
export function scanTree(root, dirs, exts, rules, secrets) {
    const out = [];
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const n of names) {
            const p = join(dir, n);
            if (statSync(p).isDirectory())
                walk(p);
            else if (exts.includes(extname(n).slice(1).toLowerCase()))
                out.push(...scanText(p.slice(root.length + 1), readFileSync(p, 'utf8'), rules, secrets));
        }
    };
    for (const d of dirs)
        walk(join(root, d));
    return out;
}
/** Secrets the scan looks for by value: the Kane user name and any owner e-mail given in the environment. */
export function secretsFromEnv(env, names) {
    return names.flatMap((n) => (env[n] ?? '').split(',')).map((s) => s.trim()).filter((s) => s.length >= 3);
}

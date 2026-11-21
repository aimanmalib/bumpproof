// Kane CLI evidence packs (.evidence, a zip) and the publication scan.
// Raw packs are never published (PRD D14). We pull out what a report needs, strip who ran the test,
// cookies, auth headers and private Test Manager links, and refuse to publish text that still holds them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

export interface PublishRules {
  /** Object keys removed wherever they appear (compared lower-case). Also header names in `{name, value}` lists. */
  strip_keys: string[];
  /** E-mail domains that may appear in published text; subdomains count. */
  email_allowlist: string[];
  /** Matches whose "domain" ends in one of these are file names such as `logo@2x.png`, not e-mail. */
  email_ignore_tlds: string[];
  /** Regular expressions (case-insensitive) for private links; matches are replaced. */
  private_url_patterns: string[];
}

export const REDACTED = '[redacted]';

export function readPack(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(bytes)));
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

export function domainAllowed(domain: string, allow: string[]): boolean {
  const d = domain.toLowerCase();
  return allow.some((a) => d === a.toLowerCase() || d.endsWith('.' + a.toLowerCase()));
}

function isFileName(domain: string, rules: PublishRules): boolean {
  const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
  return rules.email_ignore_tlds.includes(tld);
}

/** Replaces secrets given by value, private links and e-mail addresses outside the allowlist. */
export function scrubText(text: string, rules: PublishRules, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join(REDACTED);
  for (const p of rules.private_url_patterns) out = out.replace(new RegExp(p, 'gi'), REDACTED);
  return out.replace(EMAIL, (m, domain: string) =>
    domainAllowed(domain, rules.email_allowlist) || isFileName(domain, rules) ? m : REDACTED);
}

/** Deep copy without identity keys or sensitive headers; every string is scrubbed. */
export function sanitize(value: unknown, rules: PublishRules, secrets: string[] = []): unknown {
  const strip = new Set(rules.strip_keys.map((k) => k.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v, rules, secrets);
    if (Array.isArray(v)) {
      return v.filter((x) => !(isHeaderPair(x) && strip.has(String(x.name).toLowerCase()))).map(walk);
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!strip.has(k.toLowerCase())) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

function isHeaderPair(x: unknown): x is { name: unknown; value: unknown } {
  return typeof x === 'object' && x !== null && 'name' in x && 'value' in x;
}

/** JSON entries parsed, NDJSON entries parsed line by line; other entries skipped. */
export function jsonRecords(entries: Map<string, Uint8Array>): { path: string; record: unknown }[] {
  const out: { path: string; record: unknown }[] = [];
  for (const [path, bytes] of entries) {
    const ext = extname(path).toLowerCase();
    if (ext !== '.json' && ext !== '.ndjson') continue;
    const text = strFromU8(bytes);
    const parts = ext === '.json' ? [text] : text.split('\n').filter((l) => l.trim() !== '');
    for (const p of parts) {
      try { out.push({ path, record: JSON.parse(p) as unknown }); } catch { /* not JSON: skip */ }
    }
  }
  return out;
}

export interface EvidenceSummary {
  console_errors: string[];
  network_errors: string[];
  screenshots: string[];
}

/**
 * Walks every JSON record and collects console errors (objects with level error/severe and a message)
 * and failed requests (objects with a numeric status >= `minStatus` and a url). Output is sanitized.
 */
export function summarize(entries: Map<string, Uint8Array>, rules: PublishRules, opts: {
  min_status: number; image_exts: string[]; secrets?: string[];
}): EvidenceSummary {
  const consoleErrors = new Set<string>();
  const network = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const level = typeof o.level === 'string' ? o.level.toLowerCase() : typeof o.type === 'string' ? o.type.toLowerCase() : '';
    const msg = typeof o.text === 'string' ? o.text : typeof o.message === 'string' ? o.message : null;
    if ((level === 'error' || level === 'severe') && msg) consoleErrors.add(msg);
    if (typeof o.status === 'number' && o.status >= opts.min_status && typeof o.url === 'string') {
      const method = typeof o.method === 'string' ? o.method.toUpperCase() + ' ' : '';
      network.add(`${o.status} ${method}${stripQuery(o.url)}`);
    }
    Object.values(o).forEach(visit);
  };
  for (const { record } of jsonRecords(entries)) visit(record);
  const secrets = opts.secrets ?? [];
  const images = [...entries.keys()].filter((p) => opts.image_exts.includes(extname(p).slice(1).toLowerCase())).sort();
  return {
    console_errors: [...consoleErrors].map((s) => scrubText(s, rules, secrets)),
    network_errors: [...network].map((s) => scrubText(s, rules, secrets)),
    screenshots: images,
  };
}

/** Query strings often carry tokens; the report only needs the path. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

// ---- Publication scan (must be clean before anything under docs/ is pushed) ----

export interface Finding { file: string; line: number; kind: 'secret' | 'email' | 'private_url' | 'key'; match: string }

/** `match` never holds a secret value itself, only a masked hint, so the scan output is safe to print. */
export function scanText(file: string, text: string, rules: PublishRules, secrets: string[]): Finding[] {
  const out: Finding[] = [];
  const strip = rules.strip_keys.map((k) => k.toLowerCase());
  text.split('\n').forEach((lineText, i) => {
    const line = i + 1;
    for (const s of secrets) if (s.length >= 3 && lineText.includes(s)) out.push({ file, line, kind: 'secret', match: mask(s) });
    const starts = new Set<number>(); // two patterns matching the same link count once
    for (const p of rules.private_url_patterns) {
      for (const m of lineText.matchAll(new RegExp(p, 'gi'))) {
        if (!starts.has(m.index)) out.push({ file, line, kind: 'private_url', match: mask(m[0]) });
        starts.add(m.index);
      }
    }
    for (const m of lineText.matchAll(EMAIL)) {
      if (!domainAllowed(m[1]!, rules.email_allowlist) && !isFileName(m[1]!, rules)) {
        out.push({ file, line, kind: 'email', match: mask(m[0]) });
      }
    }
    for (const m of lineText.matchAll(/"([\w-]+)"\s*:/g)) {
      if (strip.includes(m[1]!.toLowerCase())) out.push({ file, line, kind: 'key', match: m[1]! });
    }
  });
  return out;
}

export function mask(s: string): string {
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}…(${s.length})`;
}

/** Scans every text file under `dirs` (missing dirs are skipped). Binary files are skipped by extension. */
export function scanTree(root: string, dirs: string[], exts: string[], rules: PublishRules, secrets: string[]): Finding[] {
  const out: Finding[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.includes(extname(n).slice(1).toLowerCase())) out.push(...scanText(p.slice(root.length + 1), readFileSync(p, 'utf8'), rules, secrets));
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out;
}

/** Secrets the scan looks for by value: the Kane user name and any owner e-mail given in the environment. */
export function secretsFromEnv(env: NodeJS.ProcessEnv, names: string[]): string[] {
  return names.flatMap((n) => (env[n] ?? '').split(',')).map((s) => s.trim()).filter((s) => s.length >= 3);
}

// Fetches release notes for a bumped package so the fixer can read what changed.
// Order: npm metadata -> GitHub repository -> Releases between the two versions -> CHANGELOG file,
// plus an upgrade guide from config when one is listed. Everything fetched here is untrusted data:
// it is cut to `notes.max_kb` and wrapped in markers that the prompt calls data, not instructions.
import type { Config } from './config.ts';
import { versionOf } from './bump.ts';
import type { Runner } from './proc.ts';

export type Fetcher = (url: string) => Promise<{ status: number; text: string } | undefined>;

export interface NotesSource {
  kind: 'releases' | 'changelog' | 'guide';
  url: string;
}

export interface ReleaseNotes {
  pkg: string;
  from: string | null;
  to: string | null;
  repo: string | null;
  sources: NotesSource[];
  text: string;
  truncated: boolean;
}

export interface NotesDeps {
  cfg: Config;
  run: Runner;
  fetch: Fetcher;
}

/** Default fetcher: plain GET with a timeout; network errors become `undefined`. */
export function httpFetcher(timeoutMs: number): Fetcher {
  return async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      return { status: res.status, text: await res.text() };
    } catch {
      return undefined;
    }
  };
}

/** `@scope/name` must keep the `@` and encode the slash for the registry. */
export function registryUrl(registry: string, pkg: string): string {
  return `${registry.replace(/\/+$/, '')}/${pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)}`;
}

/** `owner/repo` from the many shapes of npm `repository` (string, object, git+ssh, shorthand). */
export function githubRepoOf(repository: unknown): string | null {
  const raw = typeof repository === 'string' ? repository
    : repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url: string }).url : '';
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(raw);
  const m = short ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(raw);
  return m ? `${m[1]}/${m[2]!.replace(/\.git$/, '')}` : null;
}

export function cmpVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** True when `v` is after `from` and not after `to` (from may be unknown: then only `<= to`). */
export function inRange(v: string, from: string | null, to: string | null): boolean {
  const x = versionOf(v);
  const hi = versionOf(to);
  if (!x || !hi) return false;
  const lo = versionOf(from);
  return cmpVersion(x, hi) <= 0 && (!lo || cmpVersion(x, lo) > 0);
}

interface Release { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; prerelease?: unknown; draft?: unknown }

/** Monorepos tag releases as `pkg@1.2.3`; when any tag names the package, only those tags count. */
export function pickReleases(list: Release[], pkg: string, from: string | null, to: string | null): Release[] {
  const tagged = list.filter((r) => typeof r.tag_name === 'string' && !r.draft);
  const named = tagged.filter((r) => (r.tag_name as string).startsWith(`${pkg}@`));
  const pool = named.length > 0 ? named : tagged;
  const versionPart = (tag: string) => (tag.startsWith(`${pkg}@`) ? tag.slice(pkg.length + 1) : tag.replace(/^[^\d]*/, ''));
  return pool
    .filter((r) => !r.prerelease && inRange(versionPart(r.tag_name as string), from, to))
    .sort((a, b) => cmpVersion(versionOf(versionPart(a.tag_name as string))!, versionOf(versionPart(b.tag_name as string))!));
}

/** The part of a CHANGELOG between the heading for `to` and the heading for `from`; falls back to the top. */
export function changelogSection(text: string, from: string | null, to: string | null): string {
  const lines = text.split(/\r?\n/);
  const isHeading = (l: string) => /^(#{1,4}\s|\[?v?\d+\.\d+)/.test(l);
  const headingVersion = (l: string) => /v?(\d+\.\d+\.\d+)/.exec(l)?.[1];
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!isHeading(l)) continue;
    const v = headingVersion(l);
    if (!v) continue;
    if (start < 0 && inRange(v, from, to)) start = i;
    else if (start >= 0 && !inRange(v, from, to)) {
      end = i;
      break;
    }
  }
  return (start >= 0 ? lines.slice(start, end) : lines).join('\n').trim();
}

/** Crude text from an HTML page: drops scripts, styles and tags. Markdown passes through unchanged. */
export function textOf(body: string): string {
  if (!/<html[\s>]|<body[\s>]/i.test(body)) return body;
  return body
    .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Cuts to `maxBytes` of UTF-8 without splitting a character. */
export function cutBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

async function ghJson(d: NotesDeps, path: string): Promise<unknown> {
  const r = await d.run(d.cfg.github.command, ['api', path], { timeoutMs: d.cfg.notes.timeout_ms });
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return undefined;
  }
}

async function ghRaw(d: NotesDeps, path: string): Promise<string | undefined> {
  const r = await d.run(d.cfg.github.command, ['api', '-H', 'Accept: application/vnd.github.raw', path], { timeoutMs: d.cfg.notes.timeout_ms });
  return r.ok && r.stdout.trim() !== '' ? r.stdout : undefined;
}

/** Collects notes for one bump. Never throws: a missing source is simply absent from `sources`. */
export async function fetchNotes(d: NotesDeps, pkg: string, from: string | null, to: string | null): Promise<ReleaseNotes> {
  const parts: string[] = [];
  const sources: NotesSource[] = [];
  let repo: string | null = null;
  const meta = await d.fetch(registryUrl(d.cfg.notes.registry, pkg));
  if (meta && meta.status === 200) {
    try {
      repo = githubRepoOf((JSON.parse(meta.text) as { repository?: unknown }).repository);
    } catch { /* registry answered with something that is not JSON */ }
  }
  if (repo) {
    const list = await ghJson(d, `repos/${repo}/releases?per_page=${d.cfg.notes.max_releases}`);
    const picked = Array.isArray(list) ? pickReleases(list as Release[], pkg, from, to) : [];
    if (picked.length > 0) {
      sources.push({ kind: 'releases', url: `https://github.com/${repo}/releases` });
      for (const r of picked) parts.push(`## ${String(r.name || r.tag_name)}\n${typeof r.body === 'string' ? r.body.trim() : ''}`);
    } else {
      for (const file of d.cfg.notes.changelog_files) {
        const raw = await ghRaw(d, `repos/${repo}/contents/${file}`);
        if (!raw) continue;
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

const TAG = 'untrusted_release_notes';

/** Wraps notes in the data markers. A closing marker inside the notes is defused so it cannot end the block early. */
export function notesBlock(n: ReleaseNotes): string {
  const body = (n.text || '(no release notes found)').replace(new RegExp(`</?\\s*${TAG}`, 'gi'), (m) => m.replace('<', '&lt;'));
  const attr = (s: string | null) => (s ?? 'unknown').replace(/["<>]/g, '');
  const src = n.sources.map((s) => s.url).join(' ') || 'none';
  return `<${TAG} package="${attr(n.pkg)}" from="${attr(n.from)}" to="${attr(n.to)}" sources="${attr(src)}"${n.truncated ? ' truncated="true"' : ''}>\n${body}\n</${TAG}>`;
}

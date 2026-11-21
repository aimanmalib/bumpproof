// Works out which packages a bump pull request changes.
// The package.json diff between base and head is the truth; the PR title is only a hint
// (it is used when the diff is empty, for example a lockfile-only bump of a transitive package).
import type { JsonObject } from './config.ts';

export type BumpType = 'major' | 'minor' | 'patch' | 'none' | 'downgrade' | 'added' | 'removed' | 'unknown';
export type TitleKind = 'single' | 'multi' | 'group' | 'lockfile' | 'unknown';

export interface Bump {
  name: string;
  from: string | null;
  to: string | null;
  type: BumpType;
  field?: string;
}

export interface TitleHint {
  bot: 'dependabot' | 'renovate' | null;
  kind: TitleKind;
  packages: { name: string; from: string | null; to: string | null }[];
  dir: string | null;
  group: string | null;
}

export interface BumpResult {
  source: 'diff' | 'title' | 'none';
  bumps: Bump[];
  hint: TitleHint;
  /** Packages the title names that the diff does not change (shown in the report; the diff still wins). */
  title_mismatch: string[];
}

/** Strips conventional-commit prefixes such as `chore(deps):`, `build(deps-dev):` or `chore(deps):(deps-dev):`. */
export function stripPrefix(title: string): string {
  let t = title.trim().replace(/^\[security\]\s*/i, '').replace(/^:[a-z_]+:\s*/i, '');
  for (;;) {
    const m = /^[\w-]*(?:\([^)]*\))?!?:\s*/.exec(t);
    if (!m || m[0].length === 0 || m[0].length === t.length) return t;
    t = t.slice(m[0].length);
  }
}

const vOf = (s: string | undefined): string | null => (s ? s.replace(/^v(?=\d)/, '') : null);

export function parseTitle(title: string): TitleHint {
  const t = stripPrefix(title).replace(/\s*\(#\d+\)\s*$/, '').replace(/\s*\[security\]\s*$/i, '').trim();
  const hint = (bot: TitleHint['bot'], kind: TitleKind, packages: TitleHint['packages'] = [],
    dir: string | null = null, group: string | null = null): TitleHint => ({ bot, kind, packages, dir, group });
  let m: RegExpExecArray | null;
  // Dependabot
  if ((m = /^bump (\S+) from (\S+) to (\S+)(?: in the (\S+) group)?(?: in (\/\S*))?$/i.exec(t))) {
    return hint('dependabot', 'single', [{ name: m[1]!, from: m[2]!, to: m[3]! }], m[5] ?? null, m[4] ?? null);
  }
  if ((m = /^bump the (\S+) group(?: across \d+ director(?:y|ies))?(?: in (\/\S*))? with \d+ updates?$/i.exec(t))) {
    return hint('dependabot', 'group', [], m[2] ?? null, m[1]!);
  }
  if ((m = /^bump (\S+) and (\S+)(?: in (\/\S*))?$/i.exec(t))) {
    return hint('dependabot', 'multi', [{ name: m[1]!, from: null, to: null }, { name: m[2]!, from: null, to: null }], m[3] ?? null);
  }
  // Renovate
  if (/^(?:update )?lock ?file maintenance$/i.test(t)) return hint('renovate', 'lockfile');
  if ((m = /^update (\S+) monorepo(?: to (\S+))?(?: \(major\))?$/i.exec(t))) {
    return hint('renovate', 'group', [], null, m[1]!);
  }
  if ((m = /^update all (?:non-major )?dependencies$/i.exec(t))) return hint('renovate', 'group', [], null, 'all');
  if ((m = /^update (?:dependency |image |chart )?(\S+) \((\S+) (?:➔|→|->) (\S+)\)$/i.exec(t))) {
    return hint('renovate', 'single', [{ name: m[1]!, from: vOf(m[2]), to: vOf(m[3]) }]);
  }
  if ((m = /^update dependency (\S+) to (\S+)(?: \(major\))?$/i.exec(t))) {
    return hint('renovate', 'single', [{ name: m[1]!, from: null, to: vOf(m[2]) }]);
  }
  if ((m = /^update (\S+) (?:action|docker tag|docker digest) to (\S+)$/i.exec(t))) {
    return hint('renovate', 'single', [{ name: m[1]!, from: null, to: vOf(m[2]) }]);
  }
  if ((m = /^update (\S+) to (v?\d\S*)$/i.exec(t))) {
    return hint('renovate', 'single', [{ name: m[1]!, from: null, to: vOf(m[2]) }]);
  }
  return hint(null, 'unknown');
}

/** First `x[.y[.z]]` in a version or range, as numbers; null for git URLs, tags such as `latest`, etc. */
export function versionOf(spec: string | null | undefined): [number, number, number] | null {
  const m = spec ? /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec) : null;
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Literal semver position that changed. A 0.x minor change is reported as `minor`, as the bots do. */
export function bumpType(from: string | null, to: string | null): BumpType {
  if (from === null && to !== null) return 'added';
  if (to === null && from !== null) return 'removed';
  const a = versionOf(from);
  const b = versionOf(to);
  if (!a || !b) return from === to ? 'none' : 'unknown';
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return (['major', 'minor', 'patch'] as const)[i]!;
    if (b[i]! < a[i]!) return 'downgrade';
  }
  return 'none';
}

function depsOf(pkg: JsonObject, field: string): Record<string, string> {
  const v = pkg[field];
  const out: Record<string, string> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out[k] = s;
  }
  return out;
}

/** Every dependency whose spec differs between the two package.json objects, in `fields` order then by name. */
export function diffPackageJson(base: JsonObject, head: JsonObject, fields: string[]): Bump[] {
  const out: Bump[] = [];
  for (const field of fields) {
    const a = depsOf(base, field);
    const b = depsOf(head, field);
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const from = a[name] ?? null;
      const to = b[name] ?? null;
      if (from !== to) out.push({ name, from, to, type: bumpType(from, to), field });
    }
  }
  return out;
}

export function identifyBumps(title: string, base: JsonObject | null, head: JsonObject | null, fields: string[]): BumpResult {
  const hint = parseTitle(title);
  const diff = base && head ? diffPackageJson(base, head, fields) : [];
  if (diff.length > 0) {
    const changed = new Set(diff.map((d) => d.name));
    return { source: 'diff', bumps: diff, hint, title_mismatch: hint.packages.map((p) => p.name).filter((n) => !changed.has(n)) };
  }
  const fromTitle = hint.packages.map((p) => ({ ...p, type: bumpType(p.from, p.to) }));
  return { source: fromTitle.length > 0 ? 'title' : 'none', bumps: fromTitle, hint, title_mismatch: [] };
}

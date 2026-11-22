// Census selection rules (PRD §5.9, D13). Pure functions over data already fetched from GitHub:
// no network here, so every rule has a unit test and the same input always gives the same verdict.
// Third-party package.json files and .env examples are only read as data; nothing from them is run.
import { bumpType, identifyBumps, type Bump } from './bump.ts';
import { isObject, type JsonObject } from './config.ts';

export interface CensusRules {
  licenses: string[];
  max_repo_mb: number;
  frameworks: Record<string, string>;
  lifecycle_scripts: string[];
  env_files: string[];
  env_key_pattern: string;
  require_lockfile: boolean;
  watchlist: string[];
}

/** A stable reason code plus a short detail (license id, script name, …). Codes have locale text. */
export interface Reason { code: string; detail?: string }

export interface RepoFacts { license: string | null; archived: boolean; size_kb: number }

export function repoReasons(r: RepoFacts, rules: CensusRules): Reason[] {
  const out: Reason[] = [];
  if (r.archived) out.push({ code: 'archived' });
  if (!r.license || !rules.licenses.includes(r.license)) out.push({ code: 'license', detail: r.license ?? 'none' });
  const mb = r.size_kb / 1024;
  if (mb >= rules.max_repo_mb) out.push({ code: 'too_big', detail: `${Math.round(mb)} MB` });
  return out;
}

const MANIFEST = /(?:^|\/)package\.json$/;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Folders whose package.json changed in the PR (falling back to folders whose lockfile changed), in file order.
 * `node_modules` paths are ignored.
 */
export function changedAppDirs(files: string[], lockfiles: string[]): string[] {
  const keep = files.filter((f) => !f.split('/').includes('node_modules'));
  const manifests = keep.filter((f) => MANIFEST.test(f)).map(dirOf);
  const locks = keep.filter((f) => lockfiles.includes(f.slice(f.lastIndexOf('/') + 1))).map(dirOf);
  return [...new Set(manifests.length > 0 ? manifests : locks)];
}

/** The title's "in /frontend" folder when the PR changed it, else the first changed folder. */
export function pickAppDir(dirs: string[], titleDir: string | null): string | null {
  const want = titleDir ? titleDir.replace(/^\/+|\/+$/g, '') : null;
  if (want !== null && dirs.includes(want)) return want;
  return dirs[0] ?? null;
}

export interface BumpFacts { source: 'diff' | 'title' | 'none'; watched: Bump[]; all: Bump[] }

export function watchedBumps(title: string, base: JsonObject | null, head: JsonObject | null, fields: string[],
  rules: CensusRules): BumpFacts {
  const r = identifyBumps(title, base, head, fields);
  // A lockfile-only update keeps package.json as it was, so the title is the source and often has no "from"
  // (Renovate: "update dependency x to v2"). The range declared at base is then the honest "from".
  const all = r.source !== 'title' || !base ? r.bumps : r.bumps.map((b) => {
    if (b.from !== null) return b;
    const field = fields.find((f) => typeof record(base, f)[b.name] === 'string');
    const from = field ? record(base, field)[b.name]! : null;
    return from === null ? b : { ...b, from, type: bumpType(from, b.to), field };
  });
  return { source: r.source, all, watched: all.filter((b) => rules.watchlist.includes(b.name)) };
}

function record(o: JsonObject, key: string): Record<string, string> {
  const v = o[key];
  const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out[k] = s;
  return out;
}

export interface ManifestFacts {
  framework: string | null;
  build: string | null;
  /** Name of the first serve script found, in `serveScripts` order. */
  serve: string | null;
  /** Install hooks seen in the app's or the repository root's package.json. */
  lifecycle: string[];
}

export function manifestFacts(pkg: JsonObject, root: JsonObject | null, buildScript: string, serveScripts: string[],
  rules: CensusRules, depFields: string[]): ManifestFacts {
  const scripts = record(pkg, 'scripts');
  const deps = new Set(depFields.flatMap((f) => Object.keys(record(pkg, f))));
  const framework = Object.entries(rules.frameworks).find(([dep]) => deps.has(dep))?.[1] ?? null;
  const hooks = new Set<string>();
  for (const p of root ? [pkg, root] : [pkg]) {
    const s = record(p, 'scripts');
    for (const h of rules.lifecycle_scripts) if (s[h] !== undefined) hooks.add(h);
  }
  return {
    framework,
    build: scripts[buildScript] !== undefined ? buildScript : null,
    serve: serveScripts.find((s) => scripts[s] !== undefined) ?? null,
    lifecycle: rules.lifecycle_scripts.filter((h) => hooks.has(h)),
  };
}

export function manifestReasons(m: ManifestFacts): Reason[] {
  const out: Reason[] = [];
  if (!m.framework) out.push({ code: 'framework' });
  if (!m.build) out.push({ code: 'no_build' });
  if (!m.serve) out.push({ code: 'no_serve' });
  for (const h of m.lifecycle) out.push({ code: 'lifecycle', detail: h });
  return out;
}

/** Keys in an env example that look like they need a real secret (`OPENAI_API_KEY=`, `DATABASE_URL=` …). */
export function secretKeys(envText: string, pattern: string): string[] {
  const re = new RegExp(`^\\s*(?:export\\s+)?([A-Za-z0-9_]*(?:${pattern})[A-Za-z0-9_]*)\\s*=`, 'i');
  const out: string[] = [];
  for (const line of envText.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Lockfile the sandbox can install from (`npm ci` etc. need one), from the app folder's file names. */
export function lockfileIn(names: string[], lockfiles: string[]): string | null {
  return lockfiles.find((l) => names.includes(l)) ?? null;
}

export type CiState = 'green' | 'red' | 'pending' | 'none';

const RED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Folds `gh pr view --json statusCheckRollup` (check runs and commit statuses) into one state. */
export function ciState(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    if (!isObject(c)) continue;
    const v = String(c.conclusion || c.state || '').toUpperCase();
    if (RED.has(v)) return 'red';
    if (!PASS.has(v)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

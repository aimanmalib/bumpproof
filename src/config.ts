// Loads config/defaults.json and deep-merges the project's .bumpproof/config.json over it.
// Code reads values from here; it does not hold them.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CensusConfig } from './census.ts';
import type { InitConfig } from './init.ts';

/** Package root: works from src/ (tests) and dist/ (installed), both one level down. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface Config {
  schema_version: number;
  enabled: boolean;
  lang: string;
  languages: string[];
  port: number;
  node: { min_major: number };
  sandbox: {
    image: string; work_dir: string; min_free_gb: number; disk_path: string;
    cpus: number; memory: string; pids_limit: number; label: string;
    user: string; container_prefix: string; setup_timeout_s: number; serve_timeout_s: number; port_wait_s: number; poll_ms: number;
    health_path: string; health_max_status: number; log_tail_lines: number; home: string;
    env: Record<string, string>; lockfiles: Record<string, string>; install: Record<string, string>;
    run_script: Record<string, string>; build_script: string;
    serve_presets: { dependency: string; command: string }[]; serve_scripts: string[];
  };
  /** Per-app overrides: subfolder inside the repository and explicit commands (empty = detect). */
  app: { dir: string; install: string; build: string; serve: string };
  kane: {
    command: string; chrome_path: string; chrome_dir: string; chrome_names: string[];
    journeys_dir: string; journey_suffix: string; timeout_s: number;
    credit_hard_stop: number; census_budget: number;
    testmd_args: string[]; ledger_path: string; bug_result_code: number;
  };
  bump: { dep_fields: string[] };
  compare: {
    console_errors_fail: boolean; network_errors_fail: boolean; network_min_status: number; inconclusive_retries: number;
  };
  evidence: { image_exts: string[] };
  fixer: {
    name: string; command: string; model: string; max_attempts: number; max_patch_lines: number;
    mode: 'host' | 'container'; timeout_s: number; args: string[]; explanation_file: string; patch_file: string; prompt_file: string;
    protected_paths: string[]; deny_patterns: string[]; snapshot_skip: string[]; build_log_lines: number;
    canary_path: string; container: { image: string; command: string[]; work_dir: string; env: string[] };
  };
  notes: {
    registry: string; max_kb: number; timeout_ms: number; max_releases: number;
    changelog_files: string[]; guides: Record<string, string>;
  };
  github: { command: string };
  /** `pr --comment/--push-fix` only on these repository URLs; the fix commit message (`{name} {from} {to} {run}`). */
  pr: { write_repos: string[]; fix_commit_message: string };
  census: CensusConfig;
  /** `bumpproof init`: journey templates and where to look for routes. */
  init: InitConfig;
  doctor: { timeout_ms: number };
  publish: {
    email_allowlist: string[]; strip_keys: string[]; email_ignore_tlds: string[]; private_url_patterns: string[];
    public_strings: string[];
    secret_env: string[]; scan_dirs: string[]; scan_exts: string[];
  };
  report: {
    out_dir: string; runs_dir: string; census_path: string; readme_path: string; repo_url: string; pages_url: string;
    install_command: string; replay_command: string; favicon: string; share_image: string; proof_links: { key: string; path: string }[];
  };
  /** `speed` = recorded seconds per real second (0 = no pauses). */
  replay: { speed: number; max_gap_ms: number };
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars from `over` replace `base`. */
export function deepMerge(base: JsonObject, over: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(b) && isObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

export function loadDefaults(root: string = ROOT): JsonObject {
  const d = readJson(join(root, 'config', 'defaults.json'));
  if (!isObject(d)) throw new Error('config/defaults.json must hold an object');
  return d;
}

/** Defaults, then `<projectDir>/.bumpproof/config.json` when present. */
export function loadConfig(projectDir: string = process.cwd(), root: string = ROOT): Config {
  let merged = loadDefaults(root);
  const local = join(projectDir, '.bumpproof', 'config.json');
  if (existsSync(local)) {
    const o = readJson(local);
    if (!isObject(o)) throw new Error(`${local} must hold an object`);
    merged = deepMerge(merged, o);
  }
  return merged as unknown as Config;
}

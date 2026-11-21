// Finds the Chrome binary Kane CLI should drive. Order: KANE_CLI_CHROME_PATH, config kane.chrome_path,
// a Chrome for Testing install under kane.chrome_dir, then the names Kane CLI itself looks for on PATH.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { expandHome, type Config } from './config.ts';

export interface ChromeFound {
  path: string;
  source: 'env' | 'config' | 'chrome_dir' | 'path';
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Depth-limited search for an executable named `chrome` (Chrome for Testing layout: <dir>/chrome/linux-<v>/chrome-linux64/chrome). */
export function findInDir(dir: string, maxDepth = 4): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort().reverse(); // newest version folder first
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === 'chrome' && isExecutable(p)) return p;
  }
  if (maxDepth <= 0) return undefined;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) {
        const hit = findInDir(p, maxDepth - 1);
        if (hit) return hit;
      }
    } catch {
      // unreadable entry: skip
    }
  }
  return undefined;
}

export function findOnPath(names: string[], pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = join(dir, n);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

export function resolveChrome(cfg: Config, env: NodeJS.ProcessEnv): ChromeFound | undefined {
  if (env.KANE_CLI_CHROME_PATH) return { path: env.KANE_CLI_CHROME_PATH, source: 'env' };
  if (cfg.kane.chrome_path) return { path: expandHome(cfg.kane.chrome_path), source: 'config' };
  if (cfg.kane.chrome_dir) {
    const hit = findInDir(expandHome(cfg.kane.chrome_dir));
    if (hit) return { path: hit, source: 'chrome_dir' };
  }
  const onPath = findOnPath(cfg.kane.chrome_names, env.PATH);
  return onPath ? { path: onPath, source: 'path' } : undefined;
}

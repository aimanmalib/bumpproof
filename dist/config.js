// Loads config/defaults.json and deep-merges the project's .bumpproof/config.json over it.
// Code reads values from here; it does not hold them.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Package root: works from src/ (tests) and dist/ (installed), both one level down. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Objects merge key by key; arrays and scalars from `over` replace `base`. */
export function deepMerge(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        const b = out[k];
        out[k] = isObject(b) && isObject(v) ? deepMerge(b, v) : v;
    }
    return out;
}
export function expandHome(p, home = homedir()) {
    if (p === '~')
        return home;
    return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}
export function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadDefaults(root = ROOT) {
    const d = readJson(join(root, 'config', 'defaults.json'));
    if (!isObject(d))
        throw new Error('config/defaults.json must hold an object');
    return d;
}
/** Defaults, then `<projectDir>/.bumpproof/config.json` when present. */
export function loadConfig(projectDir = process.cwd(), root = ROOT) {
    let merged = loadDefaults(root);
    const local = join(projectDir, '.bumpproof', 'config.json');
    if (existsSync(local)) {
        const o = readJson(local);
        if (!isObject(o))
            throw new Error(`${local} must hold an object`);
        merged = deepMerge(merged, o);
    }
    return merged;
}

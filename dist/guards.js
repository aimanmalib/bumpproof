// Patch guards: the fixer's work is judged by code, not by what the agent says it did.
// We snapshot the working copy before the agent runs, compare after, and reject a patch that
// edits tests or journeys, touches CI, changes the bumped versions, runs processes, or is too big.
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isObject } from "./config.js";
/** Reads every file under `root` except the skipped folder names. Paths use `/`. */
export function snapshotTree(root, skip) {
    const out = new Map();
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const full = join(dir, name);
            const rel = relative(root, full).split(sep).join('/');
            const st = lstatSync(full);
            if (st.isSymbolicLink())
                out.set(rel, { data: Buffer.alloc(0), link: readlinkSync(full) });
            else if (st.isDirectory()) {
                if (!skip.includes(name))
                    walk(full);
            }
            else if (st.isFile())
                out.set(rel, { data: readFileSync(full) });
        }
    };
    walk(root);
    return out;
}
export function isBinary(b) {
    return b.subarray(0, 8000).includes(0);
}
function lines(b) {
    const s = b.toString('utf8');
    if (s === '')
        return [];
    return s.replace(/\r?\n$/, '').split(/\r?\n/);
}
/** Lines only in `a` (removed) and only in `b` (added), from a longest-common-subsequence diff. */
export function lineDiff(a, b, maxCells = 4_000_000) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s])
        s++;
    let ea = a.length;
    let eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
        ea--;
        eb--;
    }
    const x = a.slice(s, ea);
    const y = b.slice(s, eb);
    if (x.length * y.length > maxCells)
        return { added: y, removed: x };
    const w = y.length + 1;
    const t = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
        for (let j = y.length - 1; j >= 0; j--)
            t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    const added = [];
    const removed = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
        if (x[i] === y[j]) {
            i++;
            j++;
        }
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1])
            removed.push(x[i++]);
        else
            added.push(y[j++]);
    }
    return { added: added.concat(y.slice(j)), removed: removed.concat(x.slice(i)) };
}
export function diffTrees(before, after) {
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const out = [];
    for (const path of paths) {
        const a = before.get(path);
        const b = after.get(path);
        if (a && b && a.link === b.link && a.data.equals(b.data))
            continue;
        const kind = !a ? 'added' : !b ? 'deleted' : 'modified';
        const symlink = Boolean(a?.link ?? b?.link);
        const binary = !symlink && ((a ? isBinary(a.data) : false) || (b ? isBinary(b.data) : false));
        const d = symlink || binary ? { added: [], removed: [] } : lineDiff(a ? lines(a.data) : [], b ? lines(b.data) : []);
        out.push({ path, kind, binary, symlink, ...d });
    }
    return out;
}
/** Glob with `**` (any depth, including none), `*` (within one segment) and `?`. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            re += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        }
        else if (c === '*')
            re += '[^/]*';
        else if (c === '?')
            re += '[^/]';
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}
export function matchesAny(path, globs) {
    return globs.some((g) => globToRegExp(g).test(path));
}
function parseJson(b) {
    if (!b)
        return null;
    try {
        const v = JSON.parse(b.toString('utf8'));
        return isObject(v) ? v : null;
    }
    catch {
        return null;
    }
}
/** package.json may only gain new dependencies. Everything else, bumped versions included, must stay as it was. */
export function packageJsonProblems(before, after, fields) {
    const a = parseJson(before);
    const b = parseJson(after);
    if (!a)
        return [];
    if (!b)
        return ['package.json is missing or is not a JSON object'];
    const problems = [];
    const stripped = { ...b };
    for (const f of fields) {
        const was = isObject(a[f]) ? a[f] : {};
        const now = isObject(b[f]) ? b[f] : {};
        for (const [name, spec] of Object.entries(was)) {
            if (!(name in now))
                problems.push(`${f}.${name} was removed`);
            else if (now[name] !== spec)
                problems.push(`${f}.${name} changed from ${String(spec)} to ${String(now[name])}`);
        }
        const kept = {};
        for (const name of Object.keys(now))
            if (name in was)
                kept[name] = now[name];
        if (f in a || Object.keys(kept).length > 0)
            stripped[f] = kept;
        else
            delete stripped[f];
    }
    if (problems.length === 0 && JSON.stringify(sortKeys(stripped)) !== JSON.stringify(sortKeys(a)))
        problems.push('fields other than new dependencies changed');
    return problems;
}
function sortKeys(v) {
    if (Array.isArray(v))
        return v.map(sortKeys);
    if (isObject(v))
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
}
/** Every rule from PRD §5.6. An empty list means the patch may be built and tested. */
export function checkGuards(before, after, changes, cfg) {
    const f = cfg.fixer;
    const out = [];
    const explain = f.explanation_file;
    const code = changes.filter((c) => c.path !== explain);
    const deny = f.deny_patterns.map((p) => new RegExp(p));
    let changed = 0;
    for (const c of code) {
        if (matchesAny(c.path, f.protected_paths))
            out.push({ rule: 'protected_path', path: c.path, detail: `${c.kind} a protected file` });
        if (c.symlink)
            out.push({ rule: 'symlink', path: c.path, detail: 'symbolic links may not be added or changed' });
        else if (c.binary)
            out.push({ rule: 'binary', path: c.path, detail: 'binary files may not be added or changed' });
        if (c.path === 'package.json' || c.path.endsWith('/package.json')) {
            for (const p of packageJsonProblems(before.get(c.path)?.data, after.get(c.path)?.data, cfg.bump.dep_fields))
                out.push({ rule: 'package_json', path: c.path, detail: p });
        }
        for (const line of c.added) {
            const hit = deny.find((r) => r.test(line));
            if (hit)
                out.push({ rule: 'denied_pattern', path: c.path, detail: `added line matches ${hit.source}` });
        }
        changed += c.added.length + c.removed.length;
    }
    if (changed > f.max_patch_lines)
        out.push({ rule: 'too_many_lines', detail: `${changed} changed lines, limit ${f.max_patch_lines}` });
    if (code.length === 0)
        out.push({ rule: 'no_change', detail: 'no application file changed' });
    const note = after.get(explain);
    if (!note || note.data.toString('utf8').trim() === '')
        out.push({ rule: 'no_explanation', path: explain, detail: `${explain} is missing or empty` });
    return out;
}
/** Puts the working copy back to `before` (used after a rejected or failed attempt). */
export function restoreTree(root, before, changes) {
    for (const c of changes) {
        const full = join(root, ...c.path.split('/'));
        rmSync(full, { force: true, recursive: true });
        const was = before.get(c.path);
        if (!was)
            continue;
        mkdirSync(dirname(full), { recursive: true });
        if (was.link)
            symlinkSync(was.link, full);
        else
            writeFileSync(full, was.data);
    }
}
/** A compact unified-style diff for reports: changed lines only, no context. */
export function renderPatch(changes) {
    const out = [];
    for (const c of changes) {
        out.push(`--- ${c.kind === 'added' ? '/dev/null' : `a/${c.path}`}`, `+++ ${c.kind === 'deleted' ? '/dev/null' : `b/${c.path}`}`);
        if (c.symlink || c.binary)
            out.push(`(${c.symlink ? 'symbolic link' : 'binary file'})`);
        for (const l of c.removed)
            out.push(`-${l}`);
        for (const l of c.added)
            out.push(`+${l}`);
    }
    return out.join('\n');
}

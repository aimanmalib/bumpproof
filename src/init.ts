// `bumpproof init`: writes .bumpproof/config.json and two or three draft journeys for an app (PRD §5.1).
// The commands come from the same detection the sandbox uses, so what init writes is what `check` would run.
// Journeys are drafts from templates in config/; the user reads and edits them before the first check.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { ROOT, type Config } from './config.ts';
import { GitError, cleanSubdir } from './git.ts';
import type { Translate } from './i18n.ts';
import { journeysDir } from './journeys.ts';
import { planApp } from './sandbox.ts';

export interface InitConfig {
  templates: { home: string; nav: string; page: string };
  source_dirs: string[];
  source_exts: string[];
  skip_dirs: string[];
  max_files: number;
  route_patterns: string[];
  file_route_dirs: string[];
  max_page_journeys: number;
}

export interface InitIo {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
}

const ROUTE_OK = /^\/[A-Za-z0-9/_-]*$/;

function normalRoute(r: string): string | undefined {
  const p = r.length > 1 ? r.replace(/\/+$/, '') : r;
  return ROUTE_OK.test(p) ? p : undefined;
}

/** Source files under the app's source folders, capped, skipping build output and dependencies. */
export function sourceFiles(appDir: string, ic: InitConfig): string[] {
  const exts = new Set(ic.source_exts.map((e) => `.${e}`));
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= ic.max_files) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!ic.skip_dirs.includes(e.name)) walk(p);
      } else if (e.isFile() && exts.has(extname(e.name))) out.push(p);
    }
  };
  for (const d of ic.source_dirs) walk(join(appDir, d));
  return out;
}

/** A route from a file-system router file (Next `app/**\/page.*`, `pages/**`), or undefined. */
export function fileRoute(rel: string, ic: InitConfig): string | undefined {
  const parts = rel.split(sep).join('/').split('/');
  const top = parts.shift();
  if (!top || !ic.file_route_dirs.includes(top) || parts.length === 0) return undefined;
  const file = parts.pop()!;
  const stem = file.slice(0, file.length - extname(file).length);
  const segs = parts.filter((s) => !/^\(.*\)$/.test(s));
  if (segs.some((s) => s.startsWith('[') || s.startsWith('_') || s === 'api')) return undefined;
  if (top === 'app') return stem === 'page' ? normalRoute(`/${segs.join('/')}`) : undefined;
  if (stem.startsWith('_') || stem.startsWith('[')) return undefined;
  return normalRoute(`/${[...segs, ...(stem === 'index' ? [] : [stem])].join('/')}`);
}

/** Routes the source mentions, most-mentioned first. Only plain paths: no parameters, no wildcards. */
export function findRoutes(appDir: string, ic: InitConfig): string[] {
  const counts = new Map<string, number>();
  const add = (r: string | undefined) => {
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  };
  const patterns = ic.route_patterns.map((p) => new RegExp(p, 'g'));
  for (const f of sourceFiles(appDir, ic)) {
    add(fileRoute(relative(appDir, f), ic));
    const text = readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) add(normalRoute(m[1] ?? ''));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r);
}

/** `/account/orders` → `account-orders`; never collides with the home and nav drafts. */
export function routeSlug(route: string): string {
  const s = route.replace(/^\/+/, '').replace(/[/_]+/g, '-').toLowerCase();
  return s === 'home' || s === 'nav' ? `page-${s}` : s;
}

export function fillTemplate(text: string, port: number, path: string): string {
  return text.replaceAll('{port}', String(port)).replaceAll('{path}', path);
}

/** The draft journeys init would write: file name → contents. */
export function draftJourneys(cfg: Config, routes: string[]): Map<string, string> {
  const ic = cfg.init;
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const suffix = cfg.kane.journey_suffix;
  const out = new Map<string, string>();
  out.set(`home${suffix}`, fillTemplate(read(ic.templates.home), cfg.port, '/'));
  out.set(`nav${suffix}`, fillTemplate(read(ic.templates.nav), cfg.port, '/'));
  const page = read(ic.templates.page);
  for (const r of routes.filter((x) => x !== '/').slice(0, ic.max_page_journeys)) {
    out.set(`${routeSlug(r)}${suffix}`, fillTemplate(page, cfg.port, r));
  }
  return out;
}

/** Returns the exit code: 0 written, 2 refused (nothing written). */
export function runInit(cfg: Config, t: Translate, opts: { dir?: string; force: boolean }, io: InitIo): number {
  let sub: string;
  try {
    sub = cleanSubdir(opts.dir ?? cfg.app.dir);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    io.err(t('init.bad_dir', { dir: opts.dir ?? '' }));
    return 2;
  }
  const appDir = resolve(io.cwd, sub);
  const shown = sub || '.';
  // `{port}` stays a placeholder in the serve command, so changing `port` later is enough.
  const plan = planApp(appDir, { ...cfg, port: '{port}' as unknown as number });
  if ('problem' in plan) {
    io.err(t('init.no_plan', { dir: shown, reason: t(`sandbox.plan_${plan.problem}`) }));
    return 2;
  }
  const cfgPath = join(io.cwd, '.bumpproof', 'config.json');
  const rel = (p: string) => relative(io.cwd, p) || '.';
  if (existsSync(cfgPath) && !opts.force) {
    io.err(t('init.config_exists', { path: rel(cfgPath) }));
    return 2;
  }
  io.out(t('init.found', { pm: plan.pm, dir: shown }));
  io.out(t('init.commands', { install: plan.install, build: plan.build || t('init.none'), serve: plan.serve, port: cfg.port }));
  const routes = findRoutes(appDir, cfg.init);
  io.out(routes.length > 0 ? t('init.routes', { list: routes.join(', ') }) : t('init.routes_none'));

  mkdirSync(join(io.cwd, '.bumpproof'), { recursive: true });
  const local = { schema_version: cfg.schema_version, port: cfg.port, app: { dir: sub, install: plan.install, build: plan.build, serve: plan.serve } };
  writeFileSync(cfgPath, `${JSON.stringify(local, null, 2)}\n`);
  io.out(t('init.wrote', { path: rel(cfgPath) }));

  const jdir = journeysDir(appDir, cfg);
  mkdirSync(jdir, { recursive: true });
  for (const [name, text] of draftJourneys(cfg, routes)) {
    const p = join(jdir, name);
    if (existsSync(p) && !opts.force) {
      io.out(t('init.kept', { path: rel(p) }));
      continue;
    }
    writeFileSync(p, text);
    io.out(t('init.wrote', { path: rel(p) }));
  }
  io.out(t('init.next'));
  return 0;
}

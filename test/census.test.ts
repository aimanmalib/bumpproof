import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, type Config } from '../src/config.ts';
import {
  changedAppDirs, ciState, lockfileIn, manifestFacts, manifestReasons, pickAppDir, repoReasons, secretKeys, watchedBumps,
} from '../src/census-rules.ts';
import { dedupe, findCandidates, hitsFrom, ownRepoOf, rollupNodes, searchQuery, writeCandidates, type Hit } from '../src/census.ts';
import type { ProcResult, Runner } from '../src/proc.ts';
import { makeTranslator } from '../src/i18n.ts';

const cfg: Config = loadConfig('/nonexistent');
const rules = cfg.census;
const fields = cfg.bump.dep_fields;

test('repo rules: archived, license outside the list, 50 MB or more', () => {
  assert.deepEqual(repoReasons({ license: 'MIT', archived: false, size_kb: 2048 }, rules), []);
  assert.deepEqual(repoReasons({ license: 'GPL-3.0', archived: true, size_kb: 60 * 1024 }, rules).map((r) => r.code),
    ['archived', 'license', 'too_big']);
  assert.deepEqual(repoReasons({ license: null, archived: false, size_kb: 1 }, rules), [{ code: 'license', detail: 'none' }]);
  assert.deepEqual(repoReasons({ license: 'NOASSERTION', archived: false, size_kb: 1 }, rules)[0]?.code, 'license');
});

test('app folder comes from changed package.json files, then lockfiles; node_modules ignored', () => {
  const locks = Object.keys(cfg.sandbox.lockfiles);
  assert.deepEqual(changedAppDirs(['package.json', 'package-lock.json'], locks), ['']);
  assert.deepEqual(changedAppDirs(['web/package-lock.json', 'README.md'], locks), ['web']);
  assert.deepEqual(changedAppDirs(['apps/site/package.json', 'node_modules/x/package.json', 'pnpm-lock.yaml'], locks), ['apps/site']);
  assert.deepEqual(changedAppDirs(['src/index.ts'], locks), []);
  assert.equal(pickAppDir(['a', 'frontend'], '/frontend'), 'frontend');
  assert.equal(pickAppDir(['a', 'frontend'], '/'), 'a');
  assert.equal(pickAppDir([''], '/'), '');
  assert.equal(pickAppDir([], null), null);
});

test('watched bumps come from the package.json diff; other packages are counted, not kept', () => {
  const base = { dependencies: { vite: '^5.4.0', lodash: '4.17.20' } };
  const head = { dependencies: { vite: '^6.0.0', lodash: '4.17.21' } };
  const r = watchedBumps('Bump vite from 5.4.0 to 6.0.0', base, head, fields, rules);
  assert.equal(r.source, 'diff');
  assert.deepEqual(r.watched.map((b) => [b.name, b.type]), [['vite', 'major']]);
  assert.equal(r.all.length, 2);
  // Title names a watched package but the diff changes something else: the diff wins.
  const miss = watchedBumps('Bump vite from 5.4.0 to 6.0.0', base, { dependencies: { vite: '^5.4.0', lodash: '4.17.21' } }, fields, rules);
  assert.deepEqual(miss.watched, []);
  // Lockfile-only Renovate update: package.json unchanged, the declared range is the "from".
  const same = { dependencies: { '@tanstack/react-query': '^5.90.0' } };
  const lock = watchedBumps('chore(deps): update dependency @tanstack/react-query to v5.107.1', same, same, fields, rules);
  assert.equal(lock.source, 'title');
  assert.deepEqual(lock.watched, [{ name: '@tanstack/react-query', from: '^5.90.0', to: '5.107.1', type: 'minor', field: 'dependencies' }]);
});

test('manifest rules: framework, build, serve, install hooks in the app or the root package.json', () => {
  const ok = { scripts: { build: 'vite build', preview: 'vite preview' }, devDependencies: { vite: '^6.0.0' } };
  const m = manifestFacts(ok, null, 'build', cfg.sandbox.serve_scripts, rules, fields);
  assert.deepEqual(m, { framework: 'vite', build: 'build', serve: 'preview', lifecycle: [] });
  assert.deepEqual(manifestReasons(m), []);
  const bad = manifestFacts({ scripts: { test: 'x', postinstall: 'node x' }, dependencies: { express: '4' } },
    { scripts: { prepare: 'husky' } }, 'build', cfg.sandbox.serve_scripts, rules, fields);
  assert.deepEqual(manifestReasons(bad).map((r) => r.detail ? `${r.code}:${r.detail}` : r.code),
    ['framework', 'no_build', 'no_serve', 'lifecycle:postinstall', 'lifecycle:prepare']);
  const next = manifestFacts({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }, null,
    'build', cfg.sandbox.serve_scripts, rules, fields);
  assert.equal(next.framework, 'next');
  assert.equal(next.serve, 'start');
});

test('env examples: keys that look like secrets are found, plain settings are not', () => {
  const text = ['# comment', 'VITE_PUBLIC_URL=http://x', 'export OPENAI_API_KEY=', 'DATABASE_URL="postgres://"', 'GITHUB_TOKEN=',
    'client_secret=abc', 'PORT=3000', ''].join('\n');
  assert.deepEqual(secretKeys(text, rules.env_key_pattern), ['OPENAI_API_KEY', 'DATABASE_URL', 'GITHUB_TOKEN', 'client_secret']);
  assert.deepEqual(secretKeys('PORT=1\nVITE_TITLE=x', rules.env_key_pattern), []);
});

test('lockfile and CI state', () => {
  const locks = Object.keys(cfg.sandbox.lockfiles);
  assert.equal(lockfileIn(['src', 'yarn.lock', 'package.json'], locks), 'yarn.lock');
  assert.equal(lockfileIn(['package.json', 'bun.lockb'], locks), null);
  assert.equal(ciState([]), 'none');
  assert.equal(ciState(null), 'none');
  assert.equal(ciState([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'green');
  assert.equal(ciState([{ conclusion: 'SUCCESS' }, { conclusion: '', status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(ciState([{ conclusion: '', status: 'IN_PROGRESS' }, { state: 'FAILURE' }]), 'red');
  assert.deepEqual(rollupNodes('{"data":{"repository":{"pullRequest":{"commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}}}}'), []);
});

test('search: query shape, hits parsed, newest first, one per repository, our own repository skipped', () => {
  assert.equal(searchQuery(rules, rules.bots[0]!, 'date-fns'),
    'is:pr is:open author:app/dependabot created:>=2026-10-22 "bump date-fns from" in:title');
  assert.equal(searchQuery(rules, rules.bots[1]!, 'zod'),
    'is:pr is:open author:app/renovate created:>=2026-10-22 "update dependency zod" in:title');
  const hits = hitsFrom({ items: [
    { repository_url: 'https://api.github.com/repos/a/one', number: 3, title: 't', html_url: 'u', created_at: '2026-11-01T00:00:00Z' },
    { repository_url: 'bad', number: 1 },
  ] }, 'dependabot');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.repo, 'a/one');
  const h = (repo: string, created: string, number = 1): Hit => ({ repo, number, title: '', url: '', created_at: created, bot: 'dependabot' });
  const out = dedupe([h('a/one', '2026-11-01'), h('b/two', '2026-11-05'), h('A/One', '2026-11-03', 9), h('aimanmalib/bumpproof', '2026-11-20')],
    ownRepoOf(cfg.report.repo_url));
  assert.deepEqual(out.map((x) => `${x.repo}#${x.number}`), ['b/two#1', 'A/One#9']);
});

/** Fake `gh api`: routes by the API path, answers 404 for anything not listed. */
function fakeGh(routes: Record<string, unknown>, calls: string[]): Runner {
  return async (_cmd, args): Promise<ProcResult> => {
    const path = args.find((a) => a.startsWith('repos/') || a === 'search/issues' || a === 'graphql') ?? '';
    const key = path === 'search/issues' ? `search ${args.find((a) => a.startsWith('q='))}` : path;
    calls.push(key);
    for (const [k, v] of Object.entries(routes)) {
      if (key.startsWith(k)) {
        if (v instanceof Error) return { ok: false, code: 1, stdout: '', stderr: v.message };
        return { ok: true, code: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' };
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  };
}

function smallCfg(over: Partial<Config['census']> = {}): Config {
  return { ...cfg, census: { ...cfg.census, watchlist: ['vite'], bots: [cfg.census.bots[0]!], search_gap_ms: 0, request_gap_ms: 0, ...over } };
}

const item = (repo: string, n: number, created: string) => ({
  repository_url: `https://api.github.com/repos/${repo}`, number: n, title: 'Bump vite from 5.4.0 to 6.0.0', html_url: `https://github.com/${repo}/pull/${n}`, created_at: created,
});
const pkg = (vite: string, extra: object = {}) => JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' }, devDependencies: { vite }, ...extra });

test('findCandidates lists every repository with its status and reasons, and keeps the eligible one', async () => {
  const calls: string[] = [];
  const routes: Record<string, unknown> = {
    'search q=': { total_count: 3, items: [item('ok/app', 5, '2026-11-10'), item('gpl/app', 2, '2026-11-09'), item('hook/app', 1, '2026-11-08')] },
    'repos/ok/app/pulls/5/files': [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
    'repos/ok/app/pulls/5': { state: 'open', base: { sha: 'b1' }, head: { sha: 'h1' } },
    'repos/ok/app/contents/package.json?ref=b1': pkg('^5.4.0'),
    'repos/ok/app/contents/package.json?ref=h1': pkg('^6.0.0'),
    'repos/ok/app/contents?ref=b1': [{ name: 'package.json' }, { name: 'package-lock.json' }, { name: '.env.example' }],
    'repos/ok/app/contents/.env.example?ref=b1': 'VITE_TITLE=shop\n',
    'repos/ok/app': { license: { spdx_id: 'MIT' }, archived: false, size: 900, stargazers_count: 12 },
    'repos/gpl/app': { license: { spdx_id: 'GPL-3.0' }, archived: false, size: 900 },
    'repos/hook/app/pulls/1/files': [{ filename: 'web/package.json' }],
    'repos/hook/app/pulls/1': { state: 'open', base: { sha: 'b2' }, head: { sha: 'h2' } },
    'repos/hook/app/contents/web/package.json?ref=b2': pkg('^5.4.0'),
    'repos/hook/app/contents/web/package.json?ref=h2': pkg('^6.0.0'),
    'repos/hook/app/contents/package.json?ref=b2': JSON.stringify({ scripts: { postinstall: 'node setup.js' } }),
    'repos/hook/app': { license: { spdx_id: 'MIT' }, archived: false, size: 900 },
    graphql: { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ conclusion: 'SUCCESS' }] } } } }] } } } } },
  };
  const file = await findCandidates({ cfg: smallCfg(), run: fakeGh(routes, calls), now: () => Date.parse('2026-11-22T00:00:00Z'), sleep: async () => {} });
  assert.deepEqual(file.counts, { found: 3, evaluated: 3, eligible: 1, excluded: 2, not_evaluated: 0 });
  const [ok, gpl, hook] = file.candidates;
  assert.equal(ok!.status, 'eligible');
  assert.equal(ok!.pr.ci, 'green');
  assert.equal(ok!.lockfile, 'package-lock.json');
  assert.deepEqual(ok!.watched!.map((b) => b.name), ['vite']);
  assert.deepEqual(gpl!.reasons, [{ code: 'license', detail: 'GPL-3.0' }]);
  assert.ok(!calls.includes('repos/gpl/app/pulls/2'), 'license stage stops before more calls');
  assert.equal(hook!.dir, 'web');
  assert.deepEqual(hook!.reasons, [{ code: 'lifecycle', detail: 'postinstall' }]);
  assert.equal(file.stopped, null);
  assert.equal(file.order, 'newest_pr_first');
  const t = makeTranslator('en');
  for (const c of file.candidates) for (const r of c.reasons) assert.doesNotMatch(t(`census.reason_${r.code}`), /census\.reason/);
});

test('needs-secrets and missing lockfile are reasons; over the cap is listed as not checked', async () => {
  const routes: Record<string, unknown> = {
    'search q=': { items: [item('env/app', 1, '2026-11-10'), item('late/app', 1, '2026-11-01')] },
    'repos/env/app/pulls/1/files': [{ filename: 'package.json' }],
    'repos/env/app/pulls/1': { state: 'open', base: { sha: 'b' }, head: { sha: 'h' } },
    'repos/env/app/contents/package.json?ref=b': pkg('^5.4.0'),
    'repos/env/app/contents/package.json?ref=h': pkg('^6.0.0'),
    'repos/env/app/contents?ref=b': [{ name: '.env.example' }],
    'repos/env/app/contents/.env.example?ref=b': 'STRIPE_SECRET_KEY=\n',
    'repos/env/app': { license: { spdx_id: 'Apache-2.0' }, archived: false, size: 10 },
  };
  const file = await findCandidates({ cfg: smallCfg({ max_evaluate: 1 }), run: fakeGh(routes, []), now: () => 0, sleep: async () => {} });
  assert.deepEqual(file.candidates[0]!.reasons.map((r) => r.code), ['no_lockfile', 'needs_secrets']);
  assert.equal(file.candidates.length, 1, 'repositories never reached are counted, not listed');
  assert.deepEqual(file.not_checked, { limit: 1 });
  assert.equal(file.counts.not_evaluated, 1);
  assert.doesNotMatch(JSON.stringify(file), /late\/app/);
});

test('a rate limit waits once and retries; a second one stops the search and is recorded', async () => {
  const waits: number[] = [];
  const limited = new Error('gh: API rate limit exceeded (HTTP 403)');
  const file = await findCandidates({ cfg: smallCfg({ watchlist: ['vite', 'zod'] }), run: fakeGh({ 'search q=': limited }, []),
    now: () => 0, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(file.stopped, 'rate_limit');
  assert.deepEqual(waits, [cfg.census.rate_limit_wait_s * 1000]);
  assert.equal(file.searches.length, 1);
  assert.equal(file.searches[0]!.status, 'rate_limited');
});

test('searches are paced by search_gap_ms and capped by max_searches', async () => {
  let clock = 0;
  const waits: number[] = [];
  const run = fakeGh({ 'search q=': { items: [] } }, []);
  const file = await findCandidates({ cfg: smallCfg({ watchlist: ['vite', 'zod', 'swr'], search_gap_ms: 5000, max_searches: 2 }), run,
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  assert.equal(file.searches.length, 2);
  assert.equal(file.stopped, 'max_searches');
  assert.deepEqual(waits, [5000]);
});

test('the time box stops evaluation and lists the rest as not checked', async () => {
  let clock = 0;
  const run: Runner = async (c, a, o) => {
    clock += 31 * 60_000; // every call takes 31 minutes on this clock
    return fakeGh({ 'search q=': { items: [item('a/x', 1, '2026-11-10'), item('b/y', 1, '2026-11-09')] } }, [])(c, a, o);
  };
  const file = await findCandidates({ cfg: smallCfg({ timebox_min: 45 }), run, now: () => clock, sleep: async () => {} });
  assert.equal(file.stopped, 'timebox');
  assert.deepEqual(file.not_checked, { timebox: 1 });
  assert.deepEqual(file.candidates.map((c) => c.repo), ['a/x']);
});

test('writeCandidates refuses to write when the publication scan finds an e-mail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-census-'));
  try {
    const path = join(dir, 'census', 'candidates.json');
    const file = { schema_version: 1, generated_at: '', rules: {}, order: 'newest_pr_first', stopped: null, searches: [],
      counts: { found: 0, evaluated: 0, eligible: 0, excluded: 0, not_evaluated: 0 }, not_checked: {}, candidates: [] };
    assert.deepEqual(writeCandidates(path, file, cfg, []), []);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema_version, 1);
    rmSync(path);
    const leaky = { ...file, order: 'someone@private.dev' };
    assert.equal(writeCandidates(path, leaky, cfg, [])[0]!.kind, 'email');
    assert.ok(!existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checking stops once target_eligible repositories pass; the rest are listed as enough', async () => {
  const one = (repo: string): Record<string, unknown> => ({
    [`repos/${repo}/pulls/1/files`]: [{ filename: 'package.json' }],
    [`repos/${repo}/pulls/1`]: { state: 'open', base: { sha: 'b' }, head: { sha: 'h' } },
    [`repos/${repo}/contents/package.json?ref=b`]: pkg('^5.4.0'),
    [`repos/${repo}/contents/package.json?ref=h`]: pkg('^6.0.0'),
    [`repos/${repo}/contents?ref=b`]: [{ name: 'package-lock.json' }],
    [`repos/${repo}`]: { license: { spdx_id: 'MIT' }, archived: false, size: 10 },
  });
  const routes = { 'search q=': { items: [item('a/one', 1, '2026-11-10'), item('b/two', 1, '2026-11-09')] }, ...one('a/one'), ...one('b/two') };
  const file = await findCandidates({ cfg: smallCfg({ target_eligible: 1 }), run: fakeGh(routes, []), now: () => 0, sleep: async () => {} });
  assert.deepEqual(file.candidates.map((c) => c.status), ['eligible']);
  assert.deepEqual(file.not_checked, { enough: 1 });
});

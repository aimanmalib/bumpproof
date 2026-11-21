import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpType, diffPackageJson, identifyBumps, parseTitle, stripPrefix, versionOf } from '../src/bump.ts';
import { loadDefaults } from '../src/config.ts';

const FIELDS = (loadDefaults().bump as { dep_fields: string[] }).dep_fields;

// Real titles from public Dependabot and Renovate pull requests (GitHub search, 21 Nov 2026), plus our own demo shop.
const TITLES: [string, Partial<ReturnType<typeof parseTitle>>][] = [
  ['Bump clsx from 1.2.1 to 2.1.1 in /examples/shop',
    { bot: 'dependabot', kind: 'single', dir: '/examples/shop', packages: [{ name: 'clsx', from: '1.2.1', to: '2.1.1' }] }],
  ['Bump @tanstack/react-query from 4.36.1 to 5.108.0 in /examples/shop',
    { bot: 'dependabot', kind: 'single', packages: [{ name: '@tanstack/react-query', from: '4.36.1', to: '5.108.0' }] }],
  ['Bump next from 12.0.8 to 15.5.29', { kind: 'single', dir: null, packages: [{ name: 'next', from: '12.0.8', to: '15.5.29' }] }],
  ['chore(deps): bump better-auth from 1.7.22 to 1.7.26', { kind: 'single', packages: [{ name: 'better-auth', from: '1.7.22', to: '1.7.26' }] }],
  ['build(deps-dev): bump eslint from 10.14.0 to 10.15.0 in /apps/cloudflare', { kind: 'single', dir: '/apps/cloudflare' }],
  ['chore(deps):(deps-dev): bump postcss from 8.5.32 to 8.5.33', { kind: 'single', packages: [{ name: 'postcss', from: '8.5.32', to: '8.5.33' }] }],
  ['Bump ws from 8.22.1 to 8.23.0 in the ws group', { kind: 'single', group: 'ws', packages: [{ name: 'ws', from: '8.22.1', to: '8.23.0' }] }],
  ['chore(deps): bump react-dom and @types/react-dom in /apps/app/client',
    { kind: 'multi', dir: '/apps/app/client', packages: [{ name: 'react-dom', from: null, to: null }, { name: '@types/react-dom', from: null, to: null }] }],
  ['Bump the minor-and-patch group across 1 directory with 13 updates', { bot: 'dependabot', kind: 'group', group: 'minor-and-patch', packages: [] }],
  ['Bump the npm group in /frontend with 7 updates', { kind: 'group', group: 'npm', dir: '/frontend' }],
  ['build(deps-dev): bump the dev-tools group across 1 directory with 7 updates', { kind: 'group', group: 'dev-tools' }],
  ['Update dependency @testing-library/jest-dom to v8',
    { bot: 'renovate', kind: 'single', packages: [{ name: '@testing-library/jest-dom', from: null, to: '8' }] }],
  ['chore(deps): update dependency wrangler to v4.166.0', { bot: 'renovate', packages: [{ name: 'wrangler', from: null, to: '4.166.0' }] }],
  ['fix(deps): update dependency regex to v2026.11.19', { bot: 'renovate', packages: [{ name: 'regex', from: null, to: '2026.11.19' }] }],
  ['chore(deps): update astro monorepo', { bot: 'renovate', kind: 'group', group: 'astro' }],
  ['Update image ghcr.io/shlinkio/shlink (5.1.8 ➔ 5.1.9)', { bot: 'renovate', packages: [{ name: 'ghcr.io/shlinkio/shlink', from: '5.1.8', to: '5.1.9' }] }],
  ['build(deps): lock file maintenance', { bot: 'renovate', kind: 'lockfile' }],
  ['Update pyyaml to 6.0.4', { bot: 'renovate', packages: [{ name: 'pyyaml', from: null, to: '6.0.4' }] }],
  ['chore: Configure Renovate', { bot: null, kind: 'unknown', packages: [] }],
];

test('parses at least ten real bot title shapes', () => {
  assert.ok(TITLES.length >= 10);
  for (const [title, want] of TITLES) {
    const got = parseTitle(title);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k as keyof typeof got], v, `${title} → ${k}`);
  }
});

test('stripPrefix removes stacked conventional-commit prefixes only', () => {
  assert.equal(stripPrefix('chore(deps):(deps-dev): bump a from 1 to 2'), 'bump a from 1 to 2');
  assert.equal(stripPrefix('[Security] Bump a from 1 to 2'), 'Bump a from 1 to 2');
  assert.equal(stripPrefix('Update image x (1 ➔ 2)'), 'Update image x (1 ➔ 2)');
});

test('bumpType reads the first version in a spec', () => {
  assert.deepEqual(versionOf('^7.18.6'), [7, 18, 6]);
  assert.deepEqual(versionOf('~8.2.0 || ~8.3.0'), [8, 2, 0]);
  assert.equal(versionOf('github:user/repo'), null);
  assert.equal(bumpType('6.30.1', '7.18.6'), 'major');
  assert.equal(bumpType('^4.36.1', '^4.37.0'), 'minor');
  assert.equal(bumpType('1.2.1', '1.2.2'), 'patch');
  assert.equal(bumpType('0.31.9', '0.32.0'), 'minor');
  assert.equal(bumpType('2.0.0', '1.9.9'), 'downgrade');
  assert.equal(bumpType('1.0.0', '1.0.0'), 'none');
  assert.equal(bumpType(null, '1.0.0'), 'added');
  assert.equal(bumpType('1.0.0', null), 'removed');
  assert.equal(bumpType('latest', 'next'), 'unknown');
});

test('package.json diff lists every changed dependency across fields', () => {
  const base = { dependencies: { a: '1.0.0', b: '2.0.0', gone: '1.0.0' }, devDependencies: { t: '5.0.0' } };
  const head = { dependencies: { a: '1.0.0', b: '3.0.0', fresh: '0.1.0' }, devDependencies: { t: '5.1.0' } };
  assert.deepEqual(diffPackageJson(base, head, FIELDS), [
    { name: 'b', from: '2.0.0', to: '3.0.0', type: 'major', field: 'dependencies' },
    { name: 'fresh', from: null, to: '0.1.0', type: 'added', field: 'dependencies' },
    { name: 'gone', from: '1.0.0', to: null, type: 'removed', field: 'dependencies' },
    { name: 't', from: '5.0.0', to: '5.1.0', type: 'minor', field: 'devDependencies' },
  ]);
});

test('the diff wins over the title, and a disagreement is kept for the report', () => {
  const r = identifyBumps('Bump clsx from 1.2.1 to 2.1.1 in /examples/shop',
    { dependencies: { clsx: '1.2.1', other: '1.0.0' } }, { dependencies: { clsx: '1.2.1', other: '2.0.0' } }, FIELDS);
  assert.equal(r.source, 'diff');
  assert.deepEqual(r.bumps.map((b) => b.name), ['other']);
  assert.deepEqual(r.title_mismatch, ['clsx']);
});

test('a lockfile-only bump falls back to the title hint', () => {
  const pkg = { dependencies: { express: '^4.21.0' } };
  const r = identifyBumps('Bump path-to-regexp from 0.1.10 to 0.1.12', pkg, pkg, FIELDS);
  assert.equal(r.source, 'title');
  assert.deepEqual(r.bumps, [{ name: 'path-to-regexp', from: '0.1.10', to: '0.1.12', type: 'patch' }]);
  assert.equal(identifyBumps('Bump the npm group with 3 updates', pkg, pkg, FIELDS).source, 'none');
});

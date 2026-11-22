import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { ROOT, loadConfig } from '../src/config.ts';
import {
  REDACTED, readPack, sanitize, scanText, scanTree, scrubText, secretsFromEnv, stripQuery, summarize, type PublishRules,
} from '../src/evidence.ts';

const cfg = loadConfig(tmpdir());
const RULES: PublishRules = cfg.publish;
const PUB = cfg.publish;
// Made-up identities for the mutants; real values are read from the environment in the last test.
const USER = 'kane-user-4471';
const OWNER = 'owner.person@mail-provider.test';

function pack(): Uint8Array {
  const summary = {
    status: 'failed', who: { username: USER, email: OWNER }, test_url: 'https://test-manager.lambdatest.com/projects/1/tests/2',
    notes: `ran by ${USER} <${OWNER}>`, contact: 'support@example.com',
  };
  const network = [
    { url: 'http://127.0.0.1:4173/api/orders?token=abc', method: 'get', status: 500,
      headers: [{ name: 'Cookie', value: 'sid=1' }, { name: 'Accept', value: '*/*' }] },
    { url: 'http://127.0.0.1:4173/', status: 200, headers: { authorization: 'Bearer x', 'set-cookie': 'a=b', accept: 'text/html' } },
  ];
  const consoleLog = [
    JSON.stringify({ level: 'error', text: `TypeError: data is undefined (user ${OWNER})` }),
    JSON.stringify({ level: 'info', text: 'ready' }),
  ].join('\n');
  return zipSync({
    'summary.json': strToU8(JSON.stringify(summary)),
    'steps/2/network.json': strToU8(JSON.stringify(network)),
    'steps/2/console.ndjson': strToU8(consoleLog),
    'steps/2/annotated.png': new Uint8Array([137, 80, 78, 71]),
    'steps/1/screen.png': new Uint8Array([137, 80, 78, 71]),
    'notes.txt': strToU8('not json'),
  });
}

test('sanitize drops identity keys, sensitive headers and private links, keeps the rest', () => {
  const entries = readPack(pack());
  const summary = JSON.parse(new TextDecoder().decode(entries.get('summary.json'))) as unknown;
  const clean = sanitize(summary, RULES, [USER]) as Record<string, unknown>;
  assert.equal('test_url' in clean, false);
  assert.deepEqual(clean.who, {});
  assert.equal(clean.notes, `ran by ${REDACTED} <${REDACTED}>`);
  assert.equal(clean.contact, 'support@example.com');
  const net = sanitize(JSON.parse(new TextDecoder().decode(entries.get('steps/2/network.json'))), RULES) as
    { headers: unknown }[];
  assert.deepEqual(net[0]!.headers, [{ name: 'Accept', value: '*/*' }]);
  assert.deepEqual(net[1]!.headers, { accept: 'text/html' });
  const text = JSON.stringify(sanitize(summary, RULES, [USER]));
  assert.deepEqual(scanText('x', text, RULES, [USER, OWNER]), []);
});

test('summarize finds console errors, failed requests without query strings, and screenshots', () => {
  const s = summarize(readPack(pack()), RULES, { min_status: cfg.compare.network_min_status, image_exts: cfg.evidence.image_exts });
  assert.deepEqual(s.console_errors, [`TypeError: data is undefined (user ${REDACTED})`]);
  assert.deepEqual(s.network_errors, ['500 GET http://127.0.0.1:4173/api/orders']);
  assert.deepEqual(s.screenshots, ['steps/1/screen.png', 'steps/2/annotated.png']);
  assert.equal(stripQuery('/a#b'), '/a');
});

test('scrubText keeps allowlisted e-mail, subdomains and file names such as logo@2x.png', () => {
  const t = 'a@example.com b@users.noreply.github.com logo@2x.png c@evil.test';
  assert.equal(scrubText(t, RULES), `a@example.com b@users.noreply.github.com logo@2x.png ${REDACTED}`);
});

test('publication scan is red on each mutant: account user name, owner e-mail, other e-mail, private link, identity key', () => {
  const secrets = [USER, OWNER];
  const kinds = (text: string) => scanText('docs/x.html', text, RULES, secrets).map((f) => f.kind).sort();
  assert.deepEqual(kinds('<p>clean page, mail support@example.com</p>'), []);
  assert.deepEqual(kinds(`<p>run by ${USER}</p>`), ['secret']);
  assert.deepEqual(kinds(`<p>${OWNER}</p>`), ['email', 'secret']);
  assert.deepEqual(kinds('<p>someone@another.test</p>'), ['email']);
  assert.deepEqual(kinds('<a href="https://test-manager.lambdatest.com/t/9">run</a>'), ['private_url']);
  assert.deepEqual(kinds('{"test_url": "x"}'), ['key']);
  const f = scanText('f', `id ${USER}`, RULES, secrets)[0]!;
  assert.equal(f.match.includes(USER), false, 'findings must not print the secret');
});

test('a secret inside a public string (the repository URL) is not a finding; elsewhere it still is', () => {
  const rules: PublishRules = { ...RULES, public_strings: ['github.com/ownerx/tool'] };
  assert.deepEqual(scanText('a.html', 'Code: https://github.com/ownerx/tool', rules, ['ownerx']), []);
  const hits = scanText('a.html', 'https://github.com/ownerx/tool, run by ownerx', rules, ['ownerx']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'secret');
  assert.equal(scanText('a.html', 'https://github.com/ownerx/other', rules, ['ownerx']).length, 1, 'only the exact string is public');
  assert.equal(scrubText('github.com/ownerx/tool by ownerx', rules, ['ownerx']), 'github.com/ownerx/tool by [redacted]');
  assert.equal(scrubText('a.b (ownerx)', { ...rules, public_strings: ['a.b'] }, ['ownerx']), 'a.b ([redacted])', 'regex characters are literal');
});

test('secretsFromEnv reads the configured variables and splits lists', () => {
  const env = { KANE_USERNAME: 'abc123', BUMPPROOF_PRIVATE_EMAILS: 'a@b.test, c@d.test', OTHER: 'zzz' };
  assert.deepEqual(secretsFromEnv(env, PUB.secret_env), ['abc123', 'a@b.test', 'c@d.test']);
});

// The gate: everything that would be published must be clean. KANE_USERNAME and BUMPPROOF_PRIVATE_EMAILS are
// read from the environment of whoever runs the tests (the owner's machine has them; CI checks e-mail and links).
test('publication scan: docs/ and census/ hold no identities, private links or stray e-mail', () => {
  const findings = scanTree(ROOT.replace(/\/$/, ''), PUB.scan_dirs, PUB.scan_exts, RULES, secretsFromEnv(process.env, PUB.secret_env),
    cfg.evidence.image_exts);
  assert.deepEqual(findings, []);
});

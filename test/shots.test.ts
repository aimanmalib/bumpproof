import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, zlibSync } from 'fflate';
import { writeRunJson } from '../src/check-cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { scanText, scanTree } from '../src/evidence.ts';
import { makeTranslator } from '../src/i18n.ts';
import { renderComment } from '../src/report/markdown.ts';
import { readRun, type RunReport } from '../src/report/run.ts';
import {
  collectShots, failedStepId, imageText, packSteps, publishable, stepShot, stripJpegMetadata, type Pack,
} from '../src/shots.ts';

const cfg = loadConfig(tmpdir());
const RULES = cfg.publish;
const EXTS = cfg.evidence.image_exts;
const FIXTURE = join(ROOT, 'test', 'fixtures', 'synthetic-run');
const OWNER = 'owner.person@mail-provider.test';

function seg(marker: number, payload: Uint8Array): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
const SCAN = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x10, 0x20, 0x30, 0xff, 0xd9];
/** A JPEG header (JFIF + colour profile) followed by scan bytes; `extra` segments go before the scan. */
function jpeg(...extra: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...seg(0xe0, strToU8('JFIF\0\x01\x01')), ...seg(0xe2, strToU8('ICC_PROFILE\0\x01\x01sRGB')),
    ...extra.flat(), ...seg(0xdb, new Uint8Array([0, 1, 2, 3])), ...SCAN]);
}
const exif = (text: string): number[] => seg(0xe1, strToU8(`Exif\0\0Artist ${text}`));

function pngChunk(type: string, data: Uint8Array): number[] {
  const len = data.length;
  return [len >>> 24, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...strToU8(type), ...data, 0, 0, 0, 0];
}
const png = (...chunks: number[][]): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', new Uint8Array(13)), ...chunks.flat(), ...pngChunk('IEND', new Uint8Array())]);

const step = (status: string): Uint8Array => strToU8(JSON.stringify({ kind: 'assert', status, summary: 'assert: x' }));
/** An evidence pack with three steps; `failAt` marks one failed. An earlier healing attempt sits one folder deeper. */
function pack(failAt: string | null, shot = jpeg()): Pack {
  const m: Pack = new Map();
  for (const [ord, id] of [[1, '0-1'], [2, '0-2'], [10, '1-1']] as const) {
    const dir = `tests/account-1a2b3c4d/steps/${ord}-${id}/`;
    m.set(`${dir}step.json`, step(id === failAt ? 'failed' : 'passed'));
    m.set(`${dir}screenshot.jpg`, shot);
  }
  m.set('tests/account-1a2b3c4d/1/steps/2-0-2/step.json', step('failed'));
  return m;
}

test('steps of the final attempt only, in order; the failed step id', () => {
  assert.deepEqual(packSteps(pack(null)).map((s) => s.id), ['0-1', '0-2', '1-1']);
  assert.equal(failedStepId(pack('1-1')), '1-1');
  assert.equal(failedStepId(pack(null)), null, 'the failure inside the healing attempt does not count');
  assert.equal(stepShot(pack(null), '0-2', EXTS)?.ext, 'jpg');
  assert.equal(stepShot(pack(null), '9-9', EXTS), null);
});

test('EXIF and comments are dropped from a JPEG; the colour profile and the scan bytes stay', () => {
  const dirty = jpeg(exif(OWNER), seg(0xfe, strToU8(`by ${OWNER}`)), seg(0xed, strToU8('Photoshop 3.0 caption')));
  assert.match(imageText(dirty), /owner\.person@mail-provider\.test/);
  const clean = stripJpegMetadata(dirty);
  assert.equal(imageText(clean), '');
  assert.deepEqual([...clean.subarray(clean.length - SCAN.length)], SCAN);
  assert.ok(Buffer.from(clean).includes('ICC_PROFILE'));
  assert.deepEqual(clean, jpeg(), 'the result equals the same JPEG built without metadata');
  assert.deepEqual(publishable(dirty), clean);
  assert.throws(() => stripJpegMetadata(strToU8('not an image')));
});

test('PNG text chunks are read, compressed ones too', () => {
  const z = new Uint8Array([...strToU8('Author\0\0'), ...zlibSync(strToU8(`made by ${OWNER}`))]);
  assert.match(imageText(png(pngChunk('tEXt', strToU8(`Author\0${OWNER}`)))), /mail-provider/);
  assert.match(imageText(png(pngChunk('zTXt', z))), /mail-provider/);
  assert.equal(imageText(png()), '');
});

test('publication scan: an image with an e-mail in its metadata is a finding; the same image stripped is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'bumpproof-shots-'));
  try {
    mkdirSync(join(root, 'docs', 'runs', 'r', 'shots'), { recursive: true });
    const file = join(root, 'docs', 'runs', 'r', 'shots', 'account-head.jpg');
    writeFileSync(file, jpeg(exif(OWNER)));
    const red = scanTree(root, ['docs'], ['json'], RULES, [], EXTS);
    assert.deepEqual(red.map((f) => [f.file, f.kind]), [['docs/runs/r/shots/account-head.jpg', 'email']]);
    assert.deepEqual(scanTree(root, ['docs'], ['json'], RULES, [], []), [], 'without image extensions the image is not read');
    writeFileSync(file, publishable(readFileSync(file)));
    assert.deepEqual(scanTree(root, ['docs'], ['json'], RULES, [], EXTS), []);
    writeFileSync(join(root, 'docs', 'runs', 'r', 'shots', 'kane-user-4471.png'), png());
    assert.deepEqual(scanTree(root, ['docs'], ['json'], RULES, ['kane-user-4471'], EXTS).map((f) => f.kind), ['secret'],
      'a secret in the file name is found too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function report(): RunReport {
  const r = readRun(FIXTURE);
  r.shots = [];
  return r;
}

test('collectShots: the failed head step, then the same step on the base and after the fix', () => {
  const r = report();
  const failed = r.journeys.filter((j) => j.head?.status === 'failed').map((j) => j.name);
  assert.ok(failed.includes('account'));
  const packs = new Map<string, Pack>([['account:head', pack('1-1', jpeg(exif(OWNER)))], ['account:base', pack(null)], ['account:after_fix', pack(null)]]);
  const out = collectShots(r, (name, side) => packs.get(`${name}:${side}`) ?? null, EXTS);
  assert.deepEqual(out.shots, [
    { journey: 'account', side: 'base', file: 'shots/account-base.jpg' },
    { journey: 'account', side: 'head', file: 'shots/account-head.jpg' },
    { journey: 'account', side: 'after_fix', file: 'shots/account-after_fix.jpg' },
  ]);
  assert.ok(out.files.every((f) => imageText(f.bytes) === ''), 'metadata is dropped before publishing');
  assert.deepEqual(collectShots(r, () => null, EXTS).shots, [], 'no packs, no shots');
  const noFail = new Map([['account:head', pack(null)]]);
  assert.deepEqual(collectShots(r, (n, s) => noFail.get(`${n}:${s}`) ?? null, EXTS).shots, [], 'no failed step, no shots');
});

test('writeRunJson writes the shots and refuses an image that still carries an e-mail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumpproof-shots-out-'));
  try {
    const r = report();
    r.shots = [{ journey: 'account', side: 'head', file: 'shots/account-head.jpg' }];
    const bad = writeRunJson(join(dir, 'a'), r, cfg, {}, '', [{ file: 'shots/account-head.jpg', bytes: jpeg(exif(OWNER)) }]);
    assert.equal(bad.length, 1);
    assert.match(bad[0]!, /^shots\/account-head\.jpg: email/);
    assert.deepEqual(writeRunJson(join(dir, 'b'), r, cfg, {}, '', [{ file: 'shots/account-head.jpg', bytes: jpeg() }]), []);
    assert.deepEqual(readFileSync(join(dir, 'b', 'shots', 'account-head.jpg')), Buffer.from(jpeg()));
    assert.match(scanText('x', imageText(jpeg(exif(OWNER))), RULES, []).map((f) => f.kind).join(), /email/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the PR comment shows the screenshots from the run page, in both languages', () => {
  const r = report();
  r.shots = [{ journey: 'account', side: 'base', file: 'shots/account-base.jpg' }, { journey: 'account', side: 'head', file: 'shots/account-head.jpg' }];
  const md = renderComment(r, makeTranslator('en'), { version: '1', runUrl: 'https://example.com/runs/x/', bugCode: 740 });
  assert.match(md, /\| Base branch \| Pull request \|/);
  assert.match(md, /!\[account · Pull request\]\(https:\/\/example\.com\/runs\/x\/shots\/account-head\.jpg\)/);
  assert.match(renderComment(r, makeTranslator('ms'), { version: '1', runUrl: 'https://example.com/runs/x/', bugCode: 740 }), /Tangkapan skrin Kane CLI/);
  assert.doesNotMatch(renderComment(r, makeTranslator('en'), { version: '1', runUrl: null, bugCode: 740 }), /!\[/, 'no run page, no images');
});

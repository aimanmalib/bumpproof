import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT, loadDefaults, readJson, isObject } from '../src/config.ts';
import { flatten, interpolate, loadLocale, makeTranslator, pickLang } from '../src/i18n.ts';

test('every configured language has the same keys as English, none empty', () => {
  const langs = loadDefaults().languages as string[];
  const en = loadLocale('en');
  for (const lang of langs) {
    const other = loadLocale(lang);
    assert.deepEqual([...other.keys()].sort(), [...en.keys()].sort(), `locales/${lang}.json keys differ from en`);
    for (const [k, v] of other) assert.ok(v.trim() !== '', `${lang}:${k} is empty`);
  }
});

test('placeholders in each translation match English', () => {
  const en = loadLocale('en');
  const ms = loadLocale('ms');
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [k, v] of en) assert.deepEqual(vars(ms.get(k) ?? ''), vars(v), `placeholder mismatch in ${k}`);
});

test('interpolate fills known names and leaves unknown ones visible', () => {
  assert.equal(interpolate('{a} of {b}', { a: 1, b: 'x' }), '1 of x');
  assert.equal(interpolate('{a} {missing}', { a: 2 }), '2 {missing}');
});

test('translator falls back to the key when it does not exist', () => {
  const t = makeTranslator('ms');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.notEqual(t('doctor.title'), makeTranslator('en')('doctor.title'));
});

test('language order: flag, then BUMPPROOF_LANG, then config', () => {
  assert.equal(pickLang('MS', { BUMPPROOF_LANG: 'en' }, 'en'), 'ms');
  assert.equal(pickLang(undefined, { BUMPPROOF_LANG: 'ms' }, 'en'), 'ms');
  assert.equal(pickLang(undefined, {}, 'en'), 'en');
});

test('flatten turns nested objects into dotted keys', () => {
  const d = readJson(`${ROOT}/locales/en.json`);
  assert.ok(isObject(d));
  assert.ok(flatten(d).has('cli.usage'));
});

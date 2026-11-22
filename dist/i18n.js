// All user-facing text comes from locales/<lang>.json. English is the default.
import { join } from 'node:path';
import { ROOT, isObject, readJson } from "./config.js";
export function flatten(obj, prefix = '') {
    const out = new Map();
    for (const [k, v] of Object.entries(obj)) {
        if (isObject(v))
            for (const [kk, vv] of flatten(v, `${prefix}${k}.`))
                out.set(kk, vv);
        else
            out.set(prefix + k, String(v));
    }
    return out;
}
export function loadLocale(lang, root = ROOT) {
    const data = readJson(join(root, 'locales', `${lang}.json`));
    if (!isObject(data))
        throw new Error(`locales/${lang}.json must hold an object`);
    return flatten(data);
}
export function interpolate(text, vars = {}) {
    return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
/** Missing keys fall back to English, then to the key itself, so a gap is visible, not fatal. */
export function makeTranslator(lang, root = ROOT) {
    const primary = loadLocale(lang, root);
    const fallback = lang === 'en' ? primary : loadLocale('en', root);
    return (key, vars) => interpolate(primary.get(key) ?? fallback.get(key) ?? key, vars);
}
/** Order: --lang flag, BUMPPROOF_LANG, config.lang. */
export function pickLang(flag, env, configLang) {
    return (flag || env.BUMPPROOF_LANG || configLang || 'en').toLowerCase();
}

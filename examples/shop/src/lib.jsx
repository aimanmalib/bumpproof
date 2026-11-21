import { useQuery } from '@tanstack/react-query';
import format from 'date-fns/format';
import parseISO from 'date-fns/parseISO';
import strings from './strings.json';

// Text lives in strings.json; {name} placeholders are filled from vars.
export function t(key, vars = {}) {
  const text = strings[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

async function loadJson(name) {
  const res = await fetch(`/data/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

// Shop data is static JSON served from public/data, loaded through React Query.
export function useData(name) {
  return useQuery({ queryKey: ['data', name], queryFn: () => loadJson(name), staleTime: Infinity });
}

export function money(amount, shop) {
  return new Intl.NumberFormat(shop.locale, { style: 'currency', currency: shop.currency }).format(amount);
}

export function day(value, shop) {
  const date = typeof value === 'string' ? parseISO(value) : value;
  return format(date, shop.dateFormat);
}

export function Loading() {
  return <p className="note" role="status">{t('loading')}</p>;
}

export function LoadError() {
  return <p className="note note-error" role="alert">{t('error')}</p>;
}

export function NotFound() {
  return <p className="note">{t('notFound')}</p>;
}

// Returns a placeholder while any query is loading or failed, otherwise null.
export function gate(...queries) {
  if (queries.some((q) => q.status === 'loading')) return <Loading />;
  if (queries.some((q) => q.status === 'error')) return <LoadError />;
  return null;
}

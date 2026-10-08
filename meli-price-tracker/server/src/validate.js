export const BUCKET_MS = 6 * 3600 * 1000;
export const MAX_BATCH = 50;

const ITEM_RE = /^ML[A-Z][0-9]{6,13}$/;
const CLIENT_RE = /^[0-9a-f-]{32,40}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const isClientId = (v) => typeof v === 'string' && CLIENT_RE.test(v);
export const isItemId = (v) => typeof v === 'string' && ITEM_RE.test(v);

// Devuelve la observación normalizada o null si es inválida.
export function parseObservation(o) {
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.id === 'string' ? o.id.toUpperCase() : '';
  const price = Number(o.price);
  const currency = typeof o.currency === 'string' ? o.currency.toUpperCase() : '';
  if (!ITEM_RE.test(id) || !CURRENCY_RE.test(currency)) return null;
  if (!Number.isFinite(price) || price <= 0 || price >= 1e10) return null;
  return { id, price: Math.round(price * 100) / 100, currency };
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

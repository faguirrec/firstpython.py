import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { self: null, URL };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../lib/extract.js', import.meta.url), 'utf8'), ctx);
const X = ctx.MeliExtract;
const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');

test('parseAmount: separadores de miles y decimales de distintos países', () => {
  const cases = { '54.999': 54999, '1.234.567': 1234567, '1,299': 1299, '1.299,50': 1299.5, '1,299.50': 1299.5, '999': 999, '12,5': 12.5, 'x': null, '': null };
  for (const [t, v] of Object.entries(cases)) assert.equal(X.parseAmount(t), v, t);
});

test('parseHtml: precio, moneda y precio "antes" del bloque principal', () => {
  const i = X.parseHtml(fx('con-descuento.html'));
  assert.equal(i.price, 1100000);
  assert.equal(i.currency, 'ARS');
  assert.equal(i.list, 1999999); // el primero (bloque de precio), no el del carrusel
});

test('parseHtml: sin precio tachado no inventa uno', () => {
  const i = X.parseHtml(fx('sin-descuento.html'));
  assert.equal(i.price, 15990.5);
  assert.equal(i.list, undefined);
});

test('itemIdFromUrl y currencyForUrl', () => {
  assert.equal(X.itemIdFromUrl('https://articulo.mercadolibre.com.ar/MLA-123456789-x-_JM'), 'MLA123456789');
  assert.equal(X.currencyForUrl('https://articulo.mercadolibre.com.mx/MLM-1-x'), 'MXN');
});

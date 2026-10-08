import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 1);
const ctx = { self: null };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../lib/shared.js', import.meta.url), 'utf8'), ctx);
const S = ctx.MeliShared;
const item = (pts, extra = {}) => ({ currency: 'ARS', history: pts.map(([d, p]) => [NOW - d * DAY, p]), ...extra });

test('sliceHistory: arrastra el precio vigente al borde izquierdo del rango', () => {
  const h = item([[100, 50], [40, 80], [5, 60]]).history;
  const s = S.sliceHistory(h, 30, NOW);
  assert.deepEqual(s.map((p) => p[1]), [80, 60]); // a 30 días atrás el precio vigente era 80
  assert.equal(s[0][0], NOW - 30 * DAY);
  assert.equal(S.sliceHistory(h, 0, NOW).length, 3);
  assert.deepEqual(S.sliceHistory(h, 3, NOW).map((p) => p[1]), [60]); // ningún punto adentro: solo el vigente
});

test('windowStats: solo ventanas que el historial cubre, mínimo con precio arrastrado', () => {
  const h = item([[100, 50], [60, 100], [5, 90]]).history;
  const w = S.windowStats(h, NOW);
  assert.deepEqual(Array.from(w, (x) => x.days), [30, 90]); // 95 días de datos: no alcanza 6 meses
  assert.equal(w.find((x) => x.days === 90).min, 50);  // hace 90 días el precio vigente seguía siendo 50
  assert.equal(w.find((x) => x.days === 30).min, 90);
  assert.equal(S.windowStats(item([[2, 10], [1, 11]]).history, NOW).length, 0);
});

test('verdict: mínimo de ventana vs mínimo histórico', () => {
  // mínimo histórico 50 (hace 120 días); hace 100 días subió a 100; hoy 90 -> mínimo de 90 días pero no el histórico
  const v = S.verdict(item([[120, 50], [100, 100], [60, 95], [0, 90]]), NOW);
  assert.match(v.text, /Mínimo de 90 días/);
  assert.match(S.verdict(item([[100, 100], [50, 90], [0, 60]]), NOW).text, /Mínimo histórico/);
  assert.match(S.verdict(item([[1, 10], [0, 10]]), NOW).text, /Juntando/);
  assert.match(S.verdict(item([[10, 100], [5, 100], [0, 70]], { target: 80 }), NOW).text, /objetivo/);
  assert.match(S.verdict(item([[100, 50], [60, 80], [0, 100]]), NOW).text, /máximo/);
});

test('csv: cabecera, BOM y una fila por punto', () => {
  const c = S.csv(item([[2, 10], [1, 12]]));
  const lines = c.replace('﻿', '').trim().split('\n');
  assert.equal(c[0], '﻿');
  assert.equal(lines[0], 'fecha,precio,moneda');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT.*Z,10,ARS$/);
});

test('statsHtml y alertsHtml escapan y reflejan el estado', () => {
  const it = item([[100, 50], [60, 100], [0, 90]], { target: 70, alertPct: 5, alertAtMin: true });
  const html = S.alertsHtml(it);
  assert.match(html, /value="5" selected/);
  assert.match(html, /data-f="atmin" checked/);
  assert.match(html, /value="70"/);
  assert.match(S.statsHtml(S.stats(it, NOW), 'ARS'), /Mín 90 días/);
});

test('merge: no duplica puntos locales dentro de la misma ventana de 6 h', () => {
  const m = S.merge([[1000, 5], [10 * 3600 * 1000, 7]], [[2000, 5]]);
  assert.deepEqual(m.map((p) => p[1]), [5, 7]);
});

// --- Detección de descuentos inflados ---------------------------------------
const disc = (histPts, list, extra = {}) => {
  const it = { currency: 'ARS', list: list == null ? null : { price: list, at: NOW }, ...extra };
  return S.discountCheck(it, item(histPts).history, NOW);
};
// precio estable en 1200 durante 60 días y hoy 1100
const STABLE = [[60, 1200], [30, 1200], [10, 1200], [0, 1100]];

test('discountCheck: sin precio tachado, sin descuento declarado o tachado viejo -> null', () => {
  assert.equal(disc(STABLE, null), null);
  assert.equal(disc(STABLE, 1100), null);
  assert.equal(disc(STABLE, 1120), null); // <3 %
  const stale = { currency: 'ARS', list: { price: 2000, at: NOW - 4 * DAY } };
  assert.equal(S.discountCheck(stale, item(STABLE).history, NOW), null);
});

test('discountCheck: pocos días de historial -> sin verificar', () => {
  const d = disc([[5, 1200], [0, 1100]], 2000);
  assert.equal(d.status, 'unknown');
  assert.match(d.text, /5 de 14 días/);
});

test('discountCheck: el "antes" nunca existió -> inflado', () => {
  const d = disc(STABLE, 2000); // dice 45 % OFF, pero siempre costó ~1200
  assert.equal(d.status, 'fake');
  assert.equal(d.cls, 'bad');
  assert.match(d.title, /inflado/);
  assert.ok(d.realDrop < 0.1);
});

test('discountCheck: el "antes" existió y la baja es real -> descuento real', () => {
  // 60 días a 2000 y hoy 1100
  const d = disc([[60, 2000], [20, 2000], [0, 1100]], 2000);
  assert.equal(d.status, 'ok');
  assert.equal(d.cls, 'good');
  assert.ok(d.realDrop > 0.3);
});

test('discountCheck: el "antes" se vio solo brevemente -> menos de lo que dice', () => {
  // casi todo el tiempo 1200, con un pico de 2000 de 1 día hace 40 días; hoy 1100 y la tienda dice "antes 2000"
  const d = disc([[60, 1200], [41, 1200], [40, 2000], [39, 1200], [0, 1100]], 2000);
  assert.equal(d.status, 'partial');
  assert.equal(d.cls, 'warn');
});

test('discountHtml escapa y sellerLine arma la línea', () => {
  assert.equal(S.discountHtml(null), '');
  assert.match(S.discountHtml({ cls: 'bad', title: '<x>', text: 'a&b' }), /&lt;x&gt;.*a&amp;b/);
  assert.equal(S.sellerLine({ name: 'TECNO', lider: 'MercadoLíder Gold', official: false }), 'Vendido por TECNO · MercadoLíder Gold');
  assert.equal(S.sellerLine(null), '');
});

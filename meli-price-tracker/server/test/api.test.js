import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const H6 = 6 * 3600 * 1000;
const cid = (n) => String(n).padStart(8, '0') + '-aaaa-4bbb-8ccc-dddddddddddd';

async function setup(opts = {}) {
  let t = Date.UTC(2026, 0, 1);
  const db = openDb(':memory:');
  const app = createApp(db, { salt: 'test', now: () => t, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (client, items) => fetch(base + '/v1/observations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, items }) });
  const history = async (id) => (await fetch(`${base}/v1/items/${id}/history`)).json();
  return { db, base, post, history, advance: (ms) => (t += ms), close: () => server.close() };
}
const obs = (price, id = 'MLA111222333') => ({ id, price, currency: 'ARS' });

test('guarda observaciones y devuelve la mediana por ventana', async () => {
  const s = await setup();
  for (const [n, p] of [[1, 1000], [2, 1000], [3, 99999]]) { // 3 reporta un valor absurdo: la mediana lo ignora
    const r = await s.post(cid(n), [obs(p)]);
    assert.equal(r.status, 200);
  }
  const h = await s.history('MLA111222333');
  assert.equal(h.currency, 'ARS');
  assert.equal(h.contributors, 3);
  assert.equal(h.points.length, 1);
  assert.equal(h.points[0][1], 1000);
  assert.equal(h.points[0][2], 3);
  s.close();
});

test('un cliente cuenta una vez por ventana de 6 h y vuelve a contar en la siguiente', async () => {
  const s = await setup();
  assert.deepEqual(await (await s.post(cid(1), [obs(100)])).json(), { accepted: 1, rejected: 0, duplicates: 0 });
  assert.equal((await (await s.post(cid(1), [obs(100)])).json()).duplicates, 1);
  s.advance(H6);
  assert.equal((await (await s.post(cid(1), [obs(90)])).json()).accepted, 1);
  const h = await s.history('MLA111222333');
  assert.deepEqual(h.points.map((p) => p[1]), [100, 90]);
  s.close();
});

test('rechaza entradas inválidas', async () => {
  const s = await setup();
  assert.equal((await s.post('nope', [obs(1)])).status, 400);
  assert.equal((await s.post(cid(1), [])).status, 400);
  assert.equal((await s.post(cid(1), Array(51).fill(obs(1)))).status, 400);
  const r = await (await s.post(cid(1), [obs(-5), obs(0), { id: 'XX1', price: 5, currency: 'ARS' }, obs(5, 'MLA999999999'), { id: 'MLA123456', price: 5, currency: 'pesos' }])).json();
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 4);
  assert.equal((await fetch(s.base + '/v1/items/hola/history')).status, 400);
  s.close();
});

test('descarta precios atípicos cuando hay suficientes aportantes', async () => {
  const s = await setup();
  for (const n of [1, 2, 3]) await s.post(cid(n), [obs(1000)]);
  const r = await (await s.post(cid(4), [obs(1000000)])).json();
  assert.equal(r.rejected, 1);
  assert.equal((await (await s.post(cid(5), [obs(800)])).json()).accepted, 1);
  s.close();
});

test('el servidor ignora la hora que mande el cliente', async () => {
  const s = await setup();
  await fetch(s.base + '/v1/observations', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: cid(1), items: [{ ...obs(100), ts: 1 }] }) });
  const h = await s.history('MLA111222333');
  assert.equal(h.points[0][0], Date.UTC(2026, 0, 1));
  s.close();
});

test('limita por cliente y por IP', async () => {
  const s = await setup({ ipLimit: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await s.post(cid(1), [obs(100 + i, 'MLA10000000' + i)])).status, 200);
  assert.equal((await s.post(cid(1), [obs(1)])).status, 429);
  s.close();
});

test('solo se guarda el hash del cliente, nunca el código crudo', async () => {
  const s = await setup();
  await s.post(cid(1), [obs(100)]);
  const rows = s.db.prepare('SELECT client FROM observations').all();
  assert.equal(rows.length, 1);
  assert.ok(rows.every((c) => c.client.length === 64 && !c.client.includes('-')));
  s.close();
});

test('JSON roto -> 400, ruta desconocida -> 404', async () => {
  const s = await setup();
  const r = await fetch(s.base + '/v1/observations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await fetch(s.base + '/x')).status, 404);
  s.close();
});

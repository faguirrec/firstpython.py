import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DAY = 86400000;
function load() {
  const notes = [];
  const noop = { addListener() {} };
  const sandbox = {
    console, setTimeout, Date, AbortSignal, crypto, fetch: async () => { throw new Error('sin red'); },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      alarms: { get() {}, create() {}, onAlarm: noop },
      runtime: { onMessage: noop, onInstalled: noop, onStartup: noop, getURL: (p) => p },
      notifications: { create: (id, o) => notes.push(o), onClicked: noop },
      tabs: { create() {} }
    }
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), sandbox));
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), sandbox);
  return { sb: sandbox, notes };
}
const mk = (pts, extra = {}) => ({
  id: 'MLA1', title: 'Cosa', currency: 'ARS', tracked: true,
  history: pts.map(([d, p]) => [Date.now() - d * DAY, p]), ...extra
});

test('por defecto avisa bajas de 1% o más en productos seguidos', () => {
  const { sb, notes } = load();
  const it = mk([[3, 1000]]);
  sb.record(it, 900);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Bajó 10%/);
});

test('el umbral de % se respeta y 0 desactiva el aviso por %', () => {
  const { sb, notes } = load();
  sb.record(mk([[3, 1000]], { alertPct: 10 }), 950);   // 5% < 10%
  sb.record(mk([[3, 1000]], { alertPct: 0 }), 500);    // off
  assert.equal(notes.length, 0);
  sb.record(mk([[3, 1000]], { alertPct: 10 }), 880);   // 12%
  assert.equal(notes.length, 1);
});

test('aviso de mínimo de 90 días: necesita historial suficiente y que el precio sea ≤ al mínimo previo', () => {
  const { sb, notes } = load();
  const base = [[40, 120], [20, 110], [3, 100]];
  sb.record(mk(base, { alertAtMin: true, alertPct: 0 }), 95); // nuevo mínimo
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Mínimo de 90 días/);
  sb.record(mk([[40, 90], [20, 110], [3, 100]], { alertAtMin: true, alertPct: 0 }), 95); // hubo 90 antes: 95 no es mínimo
  assert.equal(notes.length, 1);
  sb.record(mk([[2, 120], [1, 110]], { alertAtMin: true, alertPct: 0 }), 100); // solo 1 día de datos: no opina
  assert.equal(notes.length, 1);
});

test('el precio objetivo tiene prioridad y los no seguidos nunca avisan', () => {
  const { sb, notes } = load();
  sb.record(mk([[3, 1000]], { target: 950, alertAtMin: true }), 900);
  assert.match(notes[0].title, /objetivo/);
  sb.record(mk([[3, 1000]], { tracked: false }), 100);
  assert.equal(notes.length, 1);
});

test('subir de precio nunca avisa', () => {
  const { sb, notes } = load();
  sb.record(mk([[3, 1000]]), 1500);
  assert.equal(notes.length, 0);
});

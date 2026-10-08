importScripts('lib/extract.js');
const X = self.MeliExtract;

const ALARM = 'mpt-check';
const CHECK_MINUTES = 60;
const MIN_GAP_MS = 6 * 3600 * 1000; // si el precio no cambia, guardamos un punto cada 6 h

// Todas las escrituras pasan por una cola para evitar pisarse entre sí.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const getItems = async () => (await chrome.storage.local.get('items')).items || {};
const setItems = (items) => chrome.storage.local.set({ items });

function fmt(price, cur) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(price); }
  catch (e) { return String(price); }
}

async function record(item, price) {
  const last = item.history[item.history.length - 1];
  const now = Date.now();
  if (last && last[1] === price && now - last[0] < MIN_GAP_MS) return false;
  item.history.push([now, price]);
  if (item.history.length > 2000) item.history.splice(0, item.history.length - 2000);
  if (last && price < last[1]) {
    const drop = Math.round((1 - price / last[1]) * 100);
    const hitTarget = item.target && price <= item.target;
    if (drop >= 1 || hitTarget) {
      chrome.notifications.create('mpt-' + item.id + '-' + now, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: hitTarget ? '🎯 Llegó a tu precio objetivo' : `📉 Bajó ${drop}%`,
        message: `${item.title}\n${fmt(last[1], item.currency)} → ${fmt(price, item.currency)}`,
        contextMessage: 'Click para abrir el producto'
      });
    }
  }
  item.lastCheck = now;
  return true;
}

async function checkAll() {
  const items = await getItems();
  for (const item of Object.values(items)) {
    try {
      const res = await fetch(item.url, { credentials: 'omit', headers: { 'Accept-Language': 'es' } });
      if (!res.ok) { item.lastError = 'HTTP ' + res.status; continue; }
      const info = X.parseHtml(await res.text());
      if (!info) { item.lastError = 'No se pudo leer el precio'; continue; }
      delete item.lastError;
      await serial(async () => {
        const fresh = await getItems();
        if (!fresh[item.id]) return;
        await record(fresh[item.id], info.price);
        fresh[item.id].lastCheck = Date.now();
        await setItems(fresh);
      });
    } catch (e) {
      item.lastError = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 1500)); // no bombardear a ML
  }
}

const handlers = {
  async isTracked({ id }) { return { tracked: !!(await getItems())[id] }; },
  track: ({ item }) => serial(async () => {
    const items = await getItems();
    items[item.id] = {
      id: item.id, url: item.url, title: item.title || item.id, image: item.image,
      currency: item.currency || 'ARS', target: null, addedAt: Date.now(),
      history: [[Date.now(), item.price]]
    };
    await setItems(items);
    return { ok: true };
  }),
  untrack: ({ id }) => serial(async () => {
    const items = await getItems(); delete items[id]; await setItems(items); return { ok: true };
  }),
  setTarget: ({ id, target }) => serial(async () => {
    const items = await getItems();
    if (items[id]) { items[id].target = target > 0 ? target : null; await setItems(items); }
    return { ok: true };
  }),
  observe: ({ id, price }) => serial(async () => {
    const items = await getItems();
    if (items[id]) { await record(items[id], price); await setItems(items); }
    return { ok: true };
  }),
  async checkNow() { await checkAll(); return { ok: true }; }
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve(h(msg)).then(reply, (e) => reply({ error: String(e) }));
  return true;
});

chrome.notifications.onClicked.addListener(async (nid) => {
  const m = /^mpt-(.+)-\d+$/.exec(nid);
  const item = m && (await getItems())[m[1]];
  if (item) chrome.tabs.create({ url: item.url });
});

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: CHECK_MINUTES, delayInMinutes: 1 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) checkAll(); });

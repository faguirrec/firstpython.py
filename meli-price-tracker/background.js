importScripts('lib/extract.js');
const X = self.MeliExtract;

const ALARM = 'mpt-check';
const CHECK_MINUTES = 60;
const MIN_GAP_MS = 6 * 3600 * 1000; // si el precio no cambia, guardamos un punto cada 6 h
const MAX_HISTORY = 1000;           // puntos por producto
const MAX_SEEN = 1500;              // productos "solo vistos" (no seguidos) que conservamos

// Todas las escrituras pasan por una cola para evitar pisarse entre sí.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const getItems = async () => (await chrome.storage.local.get('items')).items || {};
const setItems = (items) => chrome.storage.local.set({ items });
const tracked = (it) => it.tracked !== false; // ítems de la fase 1 no tienen el campo

function fmt(price, cur) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(price); }
  catch (e) { return String(price); }
}

// Agrega un punto al historial (si corresponde) y avisa si el producto está seguido y bajó.
function record(item, price) {
  const last = item.history[item.history.length - 1];
  const now = Date.now();
  if (last && last[1] === price && now - last[0] < MIN_GAP_MS) return;
  item.history.push([now, price]);
  if (item.history.length > MAX_HISTORY) item.history.splice(0, item.history.length - MAX_HISTORY);
  if (!tracked(item) || !last || price >= last[1]) return;
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

// Mantiene acotado el almacenamiento: descarta los vistos (no seguidos) menos recientes.
function evict(items) {
  const seen = Object.values(items).filter((it) => !tracked(it));
  if (seen.length <= MAX_SEEN) return;
  seen.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  for (const it of seen.slice(0, seen.length - MAX_SEEN)) delete items[it.id];
}

async function checkAll() {
  const ids = Object.values(await getItems()).filter(tracked).map((it) => it.id);
  for (const id of ids) {
    const item = (await getItems())[id];
    if (!item) continue;
    let info = null, error = null;
    try {
      const res = await fetch(item.url, { credentials: 'omit', headers: { 'Accept-Language': 'es' } });
      if (!res.ok) error = 'HTTP ' + res.status;
      else { info = X.parseHtml(await res.text()); if (!info) error = 'No se pudo leer el precio'; }
    } catch (e) { error = String(e.message || e); }
    await serial(async () => {
      const items = await getItems();
      const cur = items[id];
      if (!cur || !tracked(cur)) return;
      cur.lastCheck = Date.now();
      if (info) { delete cur.lastError; record(cur, info.price); } else cur.lastError = error;
      await setItems(items);
    });
    await new Promise((r) => setTimeout(r, 1500)); // no bombardear a ML
  }
}

const handlers = {
  // Cada visita a una página de producto crea o actualiza el registro y suma un punto de precio.
  visit: ({ item }) => serial(async () => {
    const items = await getItems();
    const now = Date.now();
    let it = items[item.id];
    if (!it) {
      it = items[item.id] = {
        id: item.id, tracked: false, target: null, addedAt: now, history: []
      };
    }
    it.url = item.url;
    it.title = item.title || it.title || item.id;
    it.image = item.image || it.image;
    it.currency = item.currency || it.currency || 'ARS';
    it.lastSeen = now;
    record(it, item.price);
    evict(items);
    await setItems(items);
    return { item: items[item.id] || null };
  }),
  track: ({ id }) => serial(async () => {
    const items = await getItems();
    if (!items[id]) return { item: null };
    items[id].tracked = true;
    items[id].addedAt = Date.now();
    await setItems(items);
    return { item: items[id] };
  }),
  untrack: ({ id }) => serial(async () => {
    const items = await getItems();
    if (!items[id]) return { item: null };
    items[id].tracked = false; // conserva el historial
    items[id].target = null;
    delete items[id].lastError;
    await setItems(items);
    return { item: items[id] };
  }),
  remove: ({ id }) => serial(async () => {
    const items = await getItems(); delete items[id]; await setItems(items); return { ok: true };
  }),
  setTarget: ({ id, target }) => serial(async () => {
    const items = await getItems();
    if (items[id]) { items[id].target = target > 0 ? target : null; await setItems(items); }
    return { item: items[id] || null };
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

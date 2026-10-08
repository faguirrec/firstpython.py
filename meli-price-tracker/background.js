importScripts('lib/config.js', 'lib/extract.js', 'lib/shared.js');
const X = self.MeliExtract;
const S = self.MeliShared;

const ALARM = 'mpt-check';
const FLUSH_ALARM = 'mpt-flush';
const SERVER = self.MPT_CONFIG.SERVER_URL;
const MAX_OUTBOX = 500;
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

// --- Base comunitaria -------------------------------------------------------
// Un solo interruptor: usar la base comunitaria implica también aportar a ella.
// Solo se envía { id de producto, precio, moneda } + un código anónimo al azar.
let newClientId; // misma UUID para llamadas concurrentes antes de que se guarde la primera vez
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const st = settings || {};
  if (!st.clientId) { st.clientId = newClientId || (newClientId = crypto.randomUUID()); }
  if (st.community === undefined) st.community = true;
  if (!settings || settings.clientId !== st.clientId || settings.community !== st.community) await chrome.storage.local.set({ settings: st });
  return st;
}

async function enqueue(obs) {
  if (!(await getSettings()).community) return;
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  const q = outbox.filter((o) => o.id !== obs.id);
  q.push(obs);
  await chrome.storage.local.set({ outbox: q.slice(-MAX_OUTBOX) });
  chrome.alarms.get(FLUSH_ALARM, (a) => { if (!a) chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 0.5 }); });
}

async function flushOutbox() {
  const st = await getSettings();
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  if (!outbox.length) return;
  if (!st.community) { await chrome.storage.local.set({ outbox: [] }); return; }
  for (let i = 0; i < outbox.length; i += 50) {
    const batch = outbox.slice(i, i + 50);
    try {
      const res = await fetch(SERVER + '/v1/observations', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: st.clientId, items: batch })
      });
      // 4xx (salvo 429) = el servidor no los va a aceptar nunca: se descartan. 5xx/red/429 = reintentar luego.
      if (!res.ok && (res.status >= 500 || res.status === 429)) throw new Error('HTTP ' + res.status);
    } catch (e) {
      await chrome.storage.local.set({ outbox: outbox.slice(i) });
      chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 5 });
      return;
    }
  }
  await chrome.storage.local.set({ outbox: [] });
}

const remoteCache = new Map(); // id -> { at, promise }
function remoteHistory(id) {
  const hit = remoteCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.promise;
  const promise = (async () => {
    if (!(await getSettings()).community) return null;
    try {
      const res = await fetch(`${SERVER}/v1/items/${id}/history`, { credentials: 'omit', signal: AbortSignal.timeout(6000) });
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  })();
  remoteCache.set(id, { at: Date.now(), promise });
  promise.then((r) => { if (!r) remoteCache.delete(id); }); // no cachear fallos
  return promise;
}

// Encola el precio para la base comunitaria salvo que ya lo mandamos hace poco.
async function share(it, price) {
  if (it.sent && it.sent[1] === price && Date.now() - it.sent[0] < MIN_GAP_MS) return;
  it.sent = [Date.now(), price];
  await enqueue({ id: it.id, price, currency: it.currency });
}

function fmt(price, cur) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(price); }
  catch (e) { return String(price); }
}

// Agrega un punto al historial (si corresponde) y avisa si el producto está seguido y se cumple alguna alerta.
function record(item, price) {
  const last = item.history[item.history.length - 1];
  const now = Date.now();
  if (last && last[1] === price && now - last[0] < MIN_GAP_MS) return;
  const before = item.history.slice(); // historial previo, para evaluar "mínimo de 90 días" sin contar este punto
  item.history.push([now, price]);
  if (item.history.length > MAX_HISTORY) item.history.splice(0, item.history.length - MAX_HISTORY);
  if (!tracked(item) || !last || price >= last[1]) return;
  const alert = checkAlerts(item, before, price, last[1]);
  if (!alert) return;
  chrome.notifications.create('mpt-' + item.id + '-' + now, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: alert.title,
    message: `${item.title}\n${fmt(last[1], item.currency)} → ${fmt(price, item.currency)}`,
    contextMessage: 'Click para abrir el producto'
  });
}

// Devuelve { title } si la baja de `prev` a `price` cumple alguna alerta del producto; si no, null.
// Prioridad: precio objetivo > mínimo de 90 días > % de baja.
function checkAlerts(item, before, price, prev) {
  if (item.target && price <= item.target) return { title: '🎯 Llegó a tu precio objetivo' };
  if (item.alertAtMin && before.length >= 3) {
    const span = (before[before.length - 1][0] - before[0][0]) / 86400000;
    const min = Math.min(...S.sliceHistory(before, 90).map((p) => p[1]));
    if (span >= 7 && price <= min) return { title: '🏷️ Mínimo de 90 días' };
  }
  const pct = item.alertPct == null ? 1 : item.alertPct; // 0 = no avisar por % de baja
  const drop = (1 - price / prev) * 100;
  if (pct > 0 && drop >= pct) return { title: `📉 Bajó ${Math.round(drop)}%` };
  return null;
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
      if (info) { delete cur.lastError; record(cur, info.price); await share(cur, info.price); } else cur.lastError = error;
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
    it.currency = item.currency || it.currency || X.currencyForUrl(item.url) || 'ARS';
    it.lastSeen = now;
    record(it, item.price);
    await share(it, item.price);
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
  // Alertas de un producto seguido: precio objetivo, % mínimo de baja (0 = off) y aviso de mínimo de 90 días.
  setAlerts: ({ id, target, pct, atMin }) => serial(async () => {
    const items = await getItems();
    const it = items[id];
    if (it) {
      it.target = target > 0 ? target : null;
      it.alertPct = [0, 1, 5, 10, 20].includes(pct) ? pct : 1;
      it.alertAtMin = !!atMin;
      await setItems(items);
    }
    return { item: it || null };
  }),
  async checkNow() { await checkAll(); return { ok: true }; },
  async remoteHistory({ id }) { return { data: await remoteHistory(id) }; },
  async getSettings() { const { clientId, ...pub } = await getSettings(); return pub; },
  setSettings: ({ community }) => serial(async () => {
    const st = await getSettings();
    st.community = !!community;
    await chrome.storage.local.set({ settings: st });
    if (!st.community) { await chrome.storage.local.set({ outbox: [] }); remoteCache.clear(); }
    return { ok: true };
  })
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
chrome.runtime.onInstalled.addListener((d) => {
  ensureAlarm();
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) { checkAll(); flushOutbox(); }
  else if (a.name === FLUSH_ALARM) flushOutbox();
});

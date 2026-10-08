const S = self.MeliShared;
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const $ = (s) => document.querySelector(s);
let tab = 'tracked';
const style = document.createElement('style');
style.textContent = S.CHART_CSS;
document.head.appendChild(style);

async function render() {
  const all = Object.values((await chrome.storage.local.get('items')).items || {});
  const tracked = all.filter(S.isTracked).sort((a, b) => b.addedAt - a.addedAt);
  const seen = all.filter((it) => !S.isTracked(it)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  $('#n-tracked').textContent = tracked.length ? `(${tracked.length})` : '';
  $('#n-seen').textContent = seen.length ? `(${seen.length})` : '';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  const items = tab === 'tracked' ? tracked : seen;
  $('#empty').hidden = items.length > 0;
  $('#empty').innerHTML = tab === 'tracked'
    ? 'Todavía no seguís ningún producto.<br>Abrí uno en MercadoLibre y tocá <b>“Seguir y avisarme”</b>.'
    : 'Acá aparecen los productos que visitás en MercadoLibre.<br>Se registran solos para armar su historial.';

  $('#list').innerHTML = items.map((it) => {
    const when = tab === 'tracked'
      ? `Última revisión: ${it.lastCheck ? new Date(it.lastCheck).toLocaleString() : '—'}`
      : `Visto por última vez: ${it.lastSeen ? new Date(it.lastSeen).toLocaleDateString() : '—'}`;
    return `<div class="card" data-id="${S.esc(it.id)}">
      <div class="top">
        ${it.image ? `<img src="${S.esc(it.image)}" alt="">` : ''}
        <div><a href="${S.esc(it.url)}" target="_blank" rel="noopener">${S.esc(it.title)}</a>
        <div class="price"></div></div>
      </div>
      <div class="discbox"></div>
      <div class="chartbox"></div>
      <div class="statsbox"></div>
      <div class="stats"><span>${S.esc(when)}</span><span class="count"></span></div>
      ${it.lastError ? `<div class="err">⚠ ${S.esc(it.lastError)}</div>` : ''}
      ${tab === 'tracked' ? S.alertsHtml(it) : ''}
      <div class="actions">
        ${tab === 'tracked'
          ? `<button class="csv">⬇ CSV</button><button class="del">Dejar de seguir</button>`
          : `<button class="follow">🔔 Seguir</button><button class="csv">⬇ CSV</button><button class="rm del-seen">Borrar</button>`}
      </div>
    </div>`;
  }).join('');
  views.clear();
  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((card) => fill(card, items.find((x) => x.id === card.dataset.id), null));
  // Historial comunitario: se pide aparte y completa cada tarjeta cuando llega (el popup ya se ve con lo local).
  const gen = ++renderGen;
  cards.slice(0, 30).forEach(async (card) => {
    const it = items.find((x) => x.id === card.dataset.id);
    const r = await send({ type: 'remoteHistory', id: it.id });
    if (gen === renderGen && card.isConnected && r && r.data && r.data.points && r.data.points.length) fill(card, it, r.data);
  });
}

// Pinta precio, veredicto, gráfico y estadísticas de una tarjeta con el historial local (+ comunitario si lo hay).
const views = new Map();
let renderGen = 0;
function fill(card, it, remote) {
  const view = remote ? { ...it, history: S.merge(it.history, remote.points) } : it;
  views.set(it.id, view);
  const s = S.stats(view), v = S.verdict(view);
  card.querySelector('.price').innerHTML = `${S.esc(S.money(s.cur, it.currency))}<span class="badge ${v.cls}">${S.esc(v.text)}</span>`;
  card.querySelector('.statsbox').innerHTML = S.statsHtml(s, it.currency);
  card.querySelector('.discbox').innerHTML = S.discountHtml(S.discountCheck(it, view.history));
  card.querySelector('.count').textContent = remote ? `${s.n} registros · ${remote.contributors} usuarios` : `${s.n} registros`;
  S.mountChart(card.querySelector('.chartbox'), view.history, it.currency);
}

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  const c = e.target.classList;
  if (!card) return;
  const id = card.dataset.id;
  if (c.contains('del')) await send({ type: 'untrack', id });
  else if (c.contains('follow')) await send({ type: 'track', id });
  else if (c.contains('del-seen')) await send({ type: 'remove', id });
  else if (e.target.dataset.a === 'alerts') await send({ type: 'setAlerts', id, ...S.readAlerts(card) });
  else if (c.contains('csv')) {
    const it = ((await chrome.storage.local.get('items')).items || {})[id];
    if (it) S.download(`precio-${id}.csv`, S.csv(it, views.get(id) && views.get(id).history));
    return;
  }
  else return;
  render();
});

document.querySelector('nav').addEventListener('click', (e) => {
  if (e.target.dataset.tab) { tab = e.target.dataset.tab; render(); }
});

$('#refresh').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = '…';
  await send({ type: 'checkNow' });
  e.target.disabled = false; e.target.textContent = '↻';
  render();
});

render();

// --- Base comunitaria ---
const box = $('#community'), msg = $('#foot-msg');
send({ type: 'getSettings' }).then((st) => { if (st) box.checked = st.community; });
box.addEventListener('change', () => send({ type: 'setSettings', community: box.checked }).then(() => {
  msg.textContent = box.checked ? 'Base comunitaria activada.' : 'Base comunitaria desactivada.';
}));

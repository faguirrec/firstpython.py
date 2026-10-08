const S = self.MeliShared;
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const $ = (s) => document.querySelector(s);
let tab = 'tracked';

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
    const s = S.stats(it), v = S.verdict(it);
    const when = tab === 'tracked'
      ? `Última revisión: ${it.lastCheck ? new Date(it.lastCheck).toLocaleString() : '—'}`
      : `Visto por última vez: ${it.lastSeen ? new Date(it.lastSeen).toLocaleDateString() : '—'}`;
    return `<div class="card" data-id="${S.esc(it.id)}">
      <div class="top">
        ${it.image ? `<img src="${S.esc(it.image)}" alt="">` : ''}
        <div><a href="${S.esc(it.url)}" target="_blank" rel="noopener">${S.esc(it.title)}</a>
        <div class="price">${S.esc(S.money(s.cur, it.currency))}<span class="badge ${v.cls}">${S.esc(v.text)}</span></div></div>
      </div>
      ${S.chart(it)}
      <div class="stats"><span>Mín ${S.esc(S.money(s.min, it.currency))}</span><span>Prom ${S.esc(S.money(s.avg, it.currency))}</span><span>Máx ${S.esc(S.money(s.max, it.currency))}</span></div>
      <div class="stats"><span>${S.esc(when)}</span><span>${s.n} registros</span></div>
      ${it.lastError ? `<div class="err">⚠ ${S.esc(it.lastError)}</div>` : ''}
      <div class="actions">
        ${tab === 'tracked'
          ? `<input type="number" min="0" placeholder="Precio objetivo" value="${it.target || ''}"><button class="set">Guardar</button><button class="del">Dejar de seguir</button>`
          : `<button class="follow">🔔 Seguir</button><button class="rm del-seen">Borrar</button>`}
      </div>
    </div>`;
  }).join('');
}

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  const c = e.target.classList;
  if (!card) return;
  const id = card.dataset.id;
  if (c.contains('del')) await send({ type: 'untrack', id });
  else if (c.contains('follow')) await send({ type: 'track', id });
  else if (c.contains('del-seen')) await send({ type: 'remove', id });
  else if (c.contains('set')) await send({ type: 'setTarget', id, target: Number(card.querySelector('input').value) });
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

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const $ = (s) => document.querySelector(s);

const money = (v, cur) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(v); }
  catch (e) { return String(v); }
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Veredicto simple comparando el precio actual contra su propio historial.
function verdict(item) {
  const prices = item.history.map((h) => h[1]);
  const cur = prices[prices.length - 1];
  const min = Math.min(...prices), max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (item.target && cur <= item.target) return { cls: 'good', text: '🎯 En tu objetivo' };
  const days = (item.history[prices.length - 1][0] - item.history[0][0]) / 86400000;
  if (prices.length < 3 || days < 3) return { cls: 'neutral', text: 'Juntando datos…' };
  if (cur <= min * 1.01) return { cls: 'good', text: '✅ Mínimo histórico' };
  if (cur <= avg * 0.95) return { cls: 'good', text: '👍 Buen momento' };
  if (cur >= max * 0.99 && max > min) return { cls: 'bad', text: '⛔ Esperá, está en el máximo' };
  if (cur > avg * 1.05) return { cls: 'warn', text: '⏳ Sobre el promedio' };
  return { cls: 'neutral', text: 'Precio normal' };
}

function chart(history) {
  const W = 360, H = 70, P = 4;
  const pts = history.map((h) => [h[0], h[1]]);
  // Escalón: el precio se mantiene hasta el siguiente cambio; extendemos hasta "ahora".
  pts.push([Date.now(), pts[pts.length - 1][1]]);
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const ps = pts.map((p) => p[1]);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const x = (t) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v) => hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  let d = '';
  pts.forEach((p, i) => {
    if (i === 0) d += `M${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
    else d += `H${x(p[0]).toFixed(1)}V${y(p[1]).toFixed(1)}`;
  });
  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historial de precio">
    <path d="${d}" fill="none" stroke="#3483fa" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.5" fill="#3483fa"/></svg>`;
}

async function render() {
  const items = Object.values((await chrome.storage.local.get('items')).items || {})
    .sort((a, b) => b.addedAt - a.addedAt);
  $('#empty').hidden = items.length > 0;
  $('#list').innerHTML = items.map((it) => {
    const prices = it.history.map((h) => h[1]);
    const cur = prices[prices.length - 1], min = Math.min(...prices), max = Math.max(...prices);
    const v = verdict(it);
    const checked = it.lastCheck ? new Date(it.lastCheck).toLocaleString() : '—';
    return `<div class="card" data-id="${esc(it.id)}">
      <div class="top">
        ${it.image ? `<img src="${esc(it.image)}" alt="">` : ''}
        <div><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <div class="price">${money(cur, it.currency)}<span class="badge ${v.cls}">${v.text}</span></div></div>
      </div>
      ${chart(it.history)}
      <div class="stats"><span>Mín ${money(min, it.currency)}</span><span>Máx ${money(max, it.currency)}</span><span>${prices.length} registros</span></div>
      <div class="stats"><span>Última revisión: ${esc(checked)}</span></div>
      ${it.lastError ? `<div class="err">⚠ ${esc(it.lastError)}</div>` : ''}
      <div class="actions">
        <input type="number" min="0" placeholder="Precio objetivo" value="${it.target || ''}">
        <button class="set">Guardar</button>
        <button class="del">Dejar de seguir</button>
      </div>
    </div>`;
  }).join('');
}

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains('del')) { await send({ type: 'untrack', id }); render(); }
  if (e.target.classList.contains('set')) {
    await send({ type: 'setTarget', id, target: Number(card.querySelector('input').value) });
    render();
  }
});

$('#refresh').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = '…';
  await send({ type: 'checkNow' });
  e.target.disabled = false; e.target.textContent = '↻';
  render();
});

render();

// Utilidades compartidas entre el popup, el panel de la página y el service worker
// (formato, estadísticas, veredicto, gráfico interactivo, CSV).
(function (root) {
  const DAY = 86400000;
  const WINDOWS = [{ days: 30, label: '30 días' }, { days: 90, label: '90 días' }, { days: 180, label: '6 meses' }];
  const RANGES = [{ id: 7, label: '7d' }, { id: 30, label: '30d' }, { id: 90, label: '90d' }, { id: 365, label: '1a' }, { id: 0, label: 'Todo' }];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function money(v, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(v); }
    catch (e) { return String(v); }
  }

  const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const longDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
  const isTracked = (item) => item.tracked !== false; // los ítems de la fase 1 no tenían el campo

  // Puntos dentro de los últimos `days` días. Si el precio venía de antes, se arrastra al borde izquierdo
  // para que el rango arranque con el precio vigente en ese momento. days = 0 -> todo el historial.
  function sliceHistory(history, days, now) {
    if (!days) return history.map((p) => [p[0], p[1]]);
    now = Math.max(now || Date.now(), history[history.length - 1][0]);
    const cut = now - days * DAY;
    const out = history.filter((p) => p[0] >= cut).map((p) => [p[0], p[1]]);
    let before = null;
    for (const p of history) if (p[0] < cut) before = p;
    if (before) out.unshift([cut, before[1]]);
    return out.length ? out : [[cut, history[history.length - 1][1]]];
  }

  // Mínimo de las ventanas de 30 d / 90 d / 6 m, solo de las que el historial realmente cubre.
  function windowStats(history, now) {
    const span = (history[history.length - 1][0] - history[0][0]) / DAY;
    return WINDOWS.filter((w) => span >= w.days * 0.9).map((w) => {
      const pts = sliceHistory(history, w.days, now);
      return { days: w.days, label: w.label, min: Math.min(...pts.map((p) => p[1])) };
    });
  }

  function stats(item, now) {
    const h = item.history;
    const prices = h.map((p) => p[1]);
    const cur = prices[prices.length - 1];
    const min = Math.min(...prices), max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      cur, min, max, avg, n: prices.length,
      minAt: h[prices.indexOf(min)][0], maxAt: h[prices.lastIndexOf(max)][0],
      days: (h[h.length - 1][0] - h[0][0]) / DAY, firstAt: h[0][0], first: prices[0],
      windows: windowStats(h, now)
    };
  }

  // Veredicto comparando el precio actual contra su propio historial.
  function verdict(item, now) {
    const s = stats(item, now);
    if (item.target && s.cur <= item.target) return { cls: 'good', text: '🎯 En tu objetivo' };
    if (s.n < 3 || s.days < 3) return { cls: 'neutral', text: 'Juntando datos…' };
    if (s.cur <= s.min * 1.01) return { cls: 'good', text: '✅ Mínimo histórico' };
    const w = [...s.windows].reverse().find((x) => s.cur <= x.min * 1.01); // la ventana más larga en la que es mínimo
    if (w) return { cls: 'good', text: `✅ Mínimo de ${w.label}` };
    if (s.cur <= s.avg * 0.95) return { cls: 'good', text: '👍 Buen momento' };
    if (s.cur >= s.max * 0.99 && s.max > s.min) return { cls: 'bad', text: '⛔ Esperá, está en el máximo' };
    if (s.cur > s.avg * 1.05) return { cls: 'warn', text: '⏳ Sobre el promedio' };
    return { cls: 'neutral', text: 'Precio normal' };
  }

  // --- Gráfico interactivo ----------------------------------------------------
  const W = 360, H = 104, PX = 6, PT = 14, PB = 14;

  function model(history, days, now) {
    const pts = sliceHistory(history, days, now);
    const end = Math.max(now || Date.now(), pts[pts.length - 1][0]);
    const all = pts.concat([[end, pts[pts.length - 1][1]]]); // el último precio se extiende hasta "ahora"
    const ps = all.map((p) => p[1]);
    const t0 = all[0][0], t1 = end, lo = Math.min(...ps), hi = Math.max(...ps);
    const x = (t) => (t1 === t0 ? W - PX : PX + ((t - t0) / (t1 - t0)) * (W - 2 * PX));
    const y = (v) => (hi === lo ? H / 2 : H - PB - ((v - lo) / (hi - lo)) * (H - PT - PB));
    const valueAt = (t) => { let v = all[0][1]; for (const p of all) { if (p[0] <= t) v = p[1]; else break; } return v; };
    return { all, t0, t1, lo, hi, x, y, valueAt };
  }

  function chartSvg(m, cur) {
    const f = (n) => n.toFixed(1);
    let d = `M${f(m.x(m.all[0][0]))},${f(m.y(m.all[0][1]))}`;
    for (let i = 1; i < m.all.length; i++) d += `H${f(m.x(m.all[i][0]))}V${f(m.y(m.all[i][1]))}`;
    const area = `${d}V${H - PB}H${f(m.x(m.t0))}Z`;
    const last = m.all[m.all.length - 1];
    const labels = m.hi === m.lo ? '' :
      `<text x="${PX}" y="10" class="lbl">${esc(money(m.hi, cur))}</text><text x="${PX}" y="${H - 3}" class="lbl">${esc(money(m.lo, cur))}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Historial de precio">
      <path d="${area}" fill="#3483fa" opacity=".12"/>
      <path d="${d}" fill="none" stroke="#3483fa" stroke-width="2" stroke-linejoin="round"/>
      ${labels}
      <line class="hv" x1="0" x2="0" y1="${PT - 4}" y2="${H - PB}" stroke="#888" stroke-dasharray="3 3" visibility="hidden"/>
      <circle class="hd" r="4" fill="#3483fa" stroke="#fff" stroke-width="1.5" visibility="hidden"/>
      <circle class="ld" cx="${f(m.x(last[0]))}" cy="${f(m.y(last[1]))}" r="3.5" fill="#3483fa"/></svg>`;
  }

  const CHART_CSS = `
  .rng { display: flex; gap: 4px; margin: 8px 0 2px; }
  .rng button { border: 0; background: var(--chip, #eee); color: inherit; border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer; }
  .rng button.on { background: #3483fa; color: #fff; }
  .cwrap { position: relative; }
  .cwrap svg { width: 100%; height: auto; display: block; cursor: crosshair; }
  .cwrap .lbl { font-size: 9px; fill: #888; font-family: system-ui, sans-serif; }
  .tip { position: absolute; top: -4px; transform: translateX(-50%); pointer-events: none; background: #222; color: #fff;
         font-size: 11px; padding: 3px 7px; border-radius: 6px; white-space: nowrap; display: none; z-index: 1; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin: 10px 0 6px; }
  .grid div { background: var(--cell, #f5f5f7); border-radius: 8px; padding: 6px 8px; }
  .grid small { display: block; color: var(--muted, #777); font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
  .grid b { font-size: 13px; }
  .delta { font-size: 12px; margin: 4px 0; color: var(--muted, #777); }
  .alerts { margin-top: 10px; border-top: 1px solid var(--line, #ccc); padding-top: 8px; display: grid; gap: 6px; }
  .alerts label { display: flex; gap: 6px; align-items: center; font-size: 12px; flex-wrap: wrap; }
  .alerts select, .alerts input[type=number] { padding: 4px 6px; border: 1px solid var(--line, #ccc); border-radius: 6px; font-size: 12px; background: transparent; color: inherit; }
  .alerts input[type=number] { width: 110px; }`;

  let lastRange = 0; // el rango elegido se recuerda mientras el panel/popup siga abierto

  // Dibuja selector de rango + gráfico dentro de `el` y conecta hover/click. Puede llamarse varias veces.
  function mountChart(el, history, cur) {
    let range = lastRange;
    let m;
    el.innerHTML = `<div class="rng">${RANGES.map((r) => `<button type="button" data-r="${r.id}">${r.label}</button>`).join('')}</div>
      <div class="cwrap"><div class="tip"></div></div>`;
    const wrap = el.querySelector('.cwrap'), tip = el.querySelector('.tip');

    function render() {
      m = model(history, range);
      const old = wrap.querySelector('svg'); if (old) old.remove();
      wrap.insertAdjacentHTML('afterbegin', chartSvg(m, cur));
      el.querySelectorAll('.rng button').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === range));
      tip.style.display = 'none';
    }
    el.querySelector('.rng').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]');
      if (!b) return;
      range = lastRange = Number(b.dataset.r);
      render();
    });
    wrap.addEventListener('mousemove', (e) => {
      const svg = wrap.querySelector('svg'); if (!svg || !m) return;
      const rect = svg.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const vx = Math.min(W - PX, Math.max(PX, fx * W));
      const t = m.t0 + ((vx - PX) / (W - 2 * PX)) * (m.t1 - m.t0);
      const v = m.valueAt(t);
      const line = svg.querySelector('.hv'), dot = svg.querySelector('.hd');
      line.setAttribute('x1', vx); line.setAttribute('x2', vx); line.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', vx); dot.setAttribute('cy', m.y(v)); dot.setAttribute('visibility', 'visible');
      tip.textContent = `${longDate(t)} · ${money(v, cur)}`;
      tip.style.display = 'block';
      tip.style.left = Math.min(82, Math.max(18, (vx / W) * 100)) + '%';
    });
    wrap.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      wrap.querySelectorAll('.hv,.hd').forEach((n) => n.setAttribute('visibility', 'hidden'));
    });
    render();
  }

  // --- Estadísticas y alertas (HTML común al panel y al popup) ---------------
  function statsHtml(s, cur) {
    const cell = (label, v, extra) => `<div><small>${esc(label)}</small><b>${esc(money(v, cur))}</b>${extra ? ` <small style="display:inline;text-transform:none">${esc(extra)}</small>` : ''}</div>`;
    const cells = [cell('Actual', s.cur), cell('Promedio', s.avg)]
      .concat(s.windows.map((w) => cell('Mín ' + w.label, w.min)))
      .concat([cell('Mín histórico', s.min, shortDate(s.minAt)), cell('Máx histórico', s.max, shortDate(s.maxAt))]);
    const parts = [];
    if (s.max > s.cur) parts.push(`${Math.round((s.cur / s.max - 1) * 100)}% vs máximo`);
    if (s.cur > s.min) parts.push(`+${Math.round((s.cur / s.min - 1) * 100)}% sobre el mínimo`);
    return `<div class="grid">${cells.join('')}</div>${parts.length ? `<div class="delta">${esc(parts.join(' · '))}</div>` : ''}`;
  }

  const PCTS = [[1, 'Cualquier baja (≥1%)'], [5, 'Bajas de 5% o más'], [10, 'Bajas de 10% o más'], [20, 'Bajas de 20% o más'], [0, 'No avisar por % de baja']];
  function alertsHtml(it) {
    const pct = it.alertPct == null ? 1 : it.alertPct;
    return `<div class="alerts">
      <label>Avisar: <select data-f="pct">${PCTS.map(([v, l]) => `<option value="${v}"${v === pct ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><input type="checkbox" data-f="atmin"${it.alertAtMin ? ' checked' : ''}> Si llega al mínimo de 90 días</label>
      <label>Precio objetivo: <input type="number" min="0" data-f="target" placeholder="—" value="${it.target || ''}"></label>
      <div><button type="button" class="btn sm" data-a="alerts">Guardar alertas</button></div>
    </div>`;
  }
  const readAlerts = (el) => ({
    pct: Number(el.querySelector('[data-f=pct]').value),
    atMin: el.querySelector('[data-f=atmin]').checked,
    target: Number(el.querySelector('[data-f=target]').value)
  });

  // --- CSV ------------------------------------------------------------------
  function csv(item, history) {
    const rows = (history || item.history).map((p) => `${new Date(p[0]).toISOString()},${p[1]},${item.currency || ''}`);
    return '﻿' + ['fecha,precio,moneda'].concat(rows).join('\n') + '\n'; // BOM: Excel respeta UTF-8
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Une el historial comunitario con el local: los puntos locales solo se agregan
  // si no hay ya un punto de la comunidad dentro de la misma ventana de 6 h.
  function merge(local, remote) {
    const GAP = 6 * 3600 * 1000;
    const out = remote.map((p) => [p[0], p[1]]);
    for (const l of local) if (!remote.some((r) => Math.abs(r[0] - l[0]) < GAP)) out.push([l[0], l[1]]);
    return out.sort((a, b) => a[0] - b[0]);
  }

  root.MeliShared = {
    esc, money, shortDate, longDate, isTracked, sliceHistory, windowStats, stats, verdict, merge,
    CHART_CSS, mountChart, statsHtml, alertsHtml, readAlerts, csv, download
  };
})(typeof self !== 'undefined' ? self : this);

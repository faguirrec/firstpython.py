// Utilidades compartidas entre el popup y el panel de la página (formato, estadísticas, veredicto, gráfico).
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function money(v, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(v); }
    catch (e) { return String(v); }
  }

  const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const isTracked = (item) => item.tracked !== false; // los ítems de la fase 1 no tenían el campo

  function stats(item) {
    const h = item.history;
    const prices = h.map((p) => p[1]);
    const cur = prices[prices.length - 1];
    const min = Math.min(...prices), max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const minAt = h[prices.indexOf(min)][0];
    const days = (h[h.length - 1][0] - h[0][0]) / 86400000;
    return { cur, min, max, avg, minAt, n: prices.length, days, firstAt: h[0][0], first: prices[0] };
  }

  // Veredicto simple comparando el precio actual contra su propio historial.
  function verdict(item) {
    const s = stats(item);
    if (item.target && s.cur <= item.target) return { cls: 'good', text: '🎯 En tu objetivo' };
    if (s.n < 3 || s.days < 3) return { cls: 'neutral', text: 'Juntando datos…' };
    if (s.cur <= s.min * 1.01) return { cls: 'good', text: '✅ Mínimo histórico' };
    if (s.cur <= s.avg * 0.95) return { cls: 'good', text: '👍 Buen momento' };
    if (s.cur >= s.max * 0.99 && s.max > s.min) return { cls: 'bad', text: '⛔ Esperá, está en el máximo' };
    if (s.cur > s.avg * 1.05) return { cls: 'warn', text: '⏳ Sobre el promedio' };
    return { cls: 'neutral', text: 'Precio normal' };
  }

  // Gráfico en escalón: el precio se mantiene hasta el siguiente cambio y se extiende hasta "ahora".
  function chart(item) {
    const W = 360, H = 90, P = 6;
    const pts = item.history.map((h) => [h[0], h[1]]);
    pts.push([Math.max(Date.now(), pts[pts.length - 1][0]), pts[pts.length - 1][1]]);
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const ps = pts.map((p) => p[1]);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    const x = (t) => (t1 === t0 ? W - P : P + ((t - t0) / (t1 - t0)) * (W - 2 * P)).toFixed(1);
    const y = (v) => (hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1);
    let d = `M${x(pts[0][0])},${y(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `H${x(pts[i][0])}V${y(pts[i][1])}`;
    const area = `${d}V${H - P}H${x(t0)}Z`;
    const last = pts[pts.length - 1];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historial de precio">
      <path d="${area}" fill="#3483fa" opacity=".12"/>
      <path d="${d}" fill="none" stroke="#3483fa" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${x(last[0])}" cy="${y(last[1])}" r="3.5" fill="#3483fa"/></svg>`;
  }

  // Une el historial comunitario con el local: los puntos locales solo se agregan
  // si no hay ya un punto de la comunidad dentro de la misma ventana de 6 h.
  function merge(local, remote) {
    const GAP = 6 * 3600 * 1000;
    const out = remote.map((p) => [p[0], p[1]]);
    for (const l of local) if (!remote.some((r) => Math.abs(r[0] - l[0]) < GAP)) out.push([l[0], l[1]]);
    return out.sort((a, b) => a[0] - b[0]);
  }

  root.MeliShared = { esc, money, shortDate, isTracked, stats, verdict, chart, merge };
})(typeof self !== 'undefined' ? self : this);

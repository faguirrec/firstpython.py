// Panel de historial de precio en cada página de producto (Shadow DOM para aislarlo de los estilos de MercadoLibre).
(function () {
  const X = self.MeliExtract, S = self.MeliShared;
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)));

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  .wrap { --chip: #eee; --line: #ccc; --cell: #f5f5f7; --muted: #777; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; color: #222; font-size: 13px; line-height: 1.4; }
  .pill { display: flex; align-items: center; gap: 8px; border: 0; cursor: pointer; padding: 11px 16px; border-radius: 999px;
          background: #ffe600; color: #2d3277; font-weight: 700; font-size: 14px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .pill:hover { filter: brightness(.96); }
  .panel { width: 360px; max-width: calc(100vw - 32px); background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.3); overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: center; background: #ffe600; color: #2d3277; padding: 9px 14px; font-weight: 700; }
  .head button { border: 0; background: none; font-size: 16px; cursor: pointer; color: inherit; }
  .body { padding: 12px 14px 14px; }
  .price { font-size: 22px; font-weight: 700; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; margin-left: 6px; vertical-align: middle; }
  .good { background: #00a650; } .bad { background: #e63946; } .warn { background: #c77d00; } .neutral { background: #777; }
  .note { color: #777; font-size: 12px; margin: 6px 0; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .row input { width: 120px; padding: 5px 7px; border: 1px solid #ccc; border-radius: 6px; }
  .btn { border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-weight: 600; background: #3483fa; color: #fff; }
  .btn.on { background: #e8f0fe; color: #1a56c4; }
  .btn.sm { padding: 6px 9px; font-weight: 500; }
  ${S.CHART_CSS}
  @media (prefers-color-scheme: dark) {
    .wrap { --chip: #33333a; --line: #444; --cell: #2b2b32; --muted: #9a9aa3; }
    .panel { background: #1f1f24; color: #eee; } .row input { background: #2b2b32; color: #eee; border-color: #444; }
    .note { color: #9a9aa3; } .btn.on { background: #26324d; color: #9cc0ff; }
  }`;

  let host, shadow, open = false, current = null, currentId = null, remote = null, lastView = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'mpt-host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.addEventListener('click', onClick);
    document.documentElement.appendChild(host);
  }
  function removeHost() { if (host) host.remove(); host = shadow = null; current = null; }

  function draw() {
    const it = current;
    if (!it) return removeHost();
    ensureHost();
    // Para mostrar usamos el historial comunitario + el local; lo guardado en el navegador no se toca.
    const view = remote && remote.points.length ? { ...it, history: S.merge(it.history, remote.points) } : it;
    const v = S.verdict(view), s = S.stats(view), cur = it.currency;
    const disc = S.discountCheck(it, view.history);
    let inner;
    if (!open) {
      inner = `<button class="pill" data-a="open" title="Ver historial de precio">${disc && disc.status === 'fake' ? '⚠️ Descuento inflado' : '📉 ' + S.esc(v.text)}</button>`;
    } else {
      const who = remote && remote.contributors > 0 ? `Comunidad: ${remote.contributors} ${remote.contributors === 1 ? 'usuario' : 'usuarios'} · ` : '';
      const note = (s.n < 3 || s.days < 3)
        ? `Empezamos a registrar este producto el ${S.shortDate(s.firstAt)}. Volvé a visitarlo en los próximos días para ver cómo evoluciona.`
        : `${who}${s.n} registros en ${Math.max(1, Math.round(s.days))} días`;
      const isT = S.isTracked(it);
      inner = `<div class="panel">
        <div class="head"><span>📉 Historial de precio</span><button data-a="close" aria-label="Cerrar">✕</button></div>
        <div class="body">
          <div class="price">${S.esc(S.money(s.cur, cur))}<span class="badge ${v.cls}">${S.esc(v.text)}</span></div>
          ${it.seller ? `<div class="seller">${S.esc(S.sellerLine(it.seller))}</div>` : ''}
          ${S.discountHtml(disc)}
          <div class="chartbox"></div>
          ${S.statsHtml(s, cur)}
          <div class="note">${S.esc(note)}</div>
          <div class="row">
            <button class="btn ${isT ? 'on' : ''}" data-a="toggle">${isT ? '✓ Siguiendo (alertas activas)' : '🔔 Seguir y avisarme'}</button>
            <button class="btn sm on" data-a="csv" title="Descargar el historial en CSV">⬇ CSV</button>
          </div>
          ${isT ? S.alertsHtml(it) : ''}
        </div>
      </div>`;
    }
    shadow.innerHTML = `<style>${CSS}</style><div class="wrap">${inner}</div>`;
    const cb = shadow.querySelector('.chartbox');
    if (cb) S.mountChart(cb, view.history, cur);
    lastView = view;
  }

  async function onClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a || !current) return;
    const act = a.dataset.a;
    if (act === 'open' || act === 'close') { open = act === 'open'; try { chrome.storage.local.set({ panelOpen: open }); } catch (_) {} return draw(); }
    let res;
    if (act === 'toggle') res = await send({ type: S.isTracked(current) ? 'untrack' : 'track', id: current.id });
    if (act === 'alerts') res = await send({ type: 'setAlerts', id: current.id, ...S.readAlerts(shadow) });
    if (act === 'csv') return S.download(`precio-${current.id}.csv`, S.csv(current, lastView ? lastView.history : null));
    if (res && res.item) { current = res.item; draw(); }
  }

  async function run() {
    const id = X.itemIdFromUrl(location.href);
    currentId = id;
    if (!id) return removeHost();
    const info = X.parseDocument(document);
    if (!info) return removeHost();
    const res = await send({ type: 'visit', item: { id, url: X.canonicalUrl(location.href), ...info } }); // incluye info.list y info.seller
    if (id !== currentId || !res || !res.item) return; // navegó mientras esperábamos
    current = res.item;
    remote = null;
    draw();
    // Historial de la comunidad: llega después y redibuja si el panel sigue en este producto.
    const r = await send({ type: 'remoteHistory', id });
    if (id === currentId && r && r.data && r.data.points && r.data.points.length) { remote = r.data; draw(); }
  }

  try { chrome.storage.local.get('panelOpen', (r) => { open = !!(r && r.panelOpen); run(); }); } catch (_) { run(); }

  // MercadoLibre es en parte SPA: re-evaluamos si cambia la URL.
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(run, 1200); } }, 1000);
})();

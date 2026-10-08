// Panel de historial de precio en cada página de producto (Shadow DOM para aislarlo de los estilos de MercadoLibre).
(function () {
  const X = self.MeliExtract, S = self.MeliShared;
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)));

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; color: #222; font-size: 13px; line-height: 1.4; }
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
  svg.chart { width: 100%; height: auto; display: block; margin: 8px 0 2px; }
  .axis { display: flex; justify-content: space-between; color: #777; font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 10px 0; }
  .grid div { background: #f5f5f7; border-radius: 8px; padding: 6px 8px; }
  .grid small { display: block; color: #777; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
  .grid b { font-size: 13px; }
  .note { color: #777; font-size: 12px; margin: 6px 0; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .row input { width: 120px; padding: 5px 7px; border: 1px solid #ccc; border-radius: 6px; }
  .btn { border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-weight: 600; background: #3483fa; color: #fff; }
  .btn.on { background: #e8f0fe; color: #1a56c4; }
  .btn.sm { padding: 6px 9px; font-weight: 500; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #1f1f24; color: #eee; } .grid div { background: #2b2b32; } .row input { background: #2b2b32; color: #eee; border-color: #444; }
    .axis, .note, .grid small { color: #9a9aa3; } .btn.on { background: #26324d; color: #9cc0ff; }
  }`;

  let host, shadow, open = false, current = null, currentId = null;

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
    const v = S.verdict(it), s = S.stats(it), cur = it.currency;
    let inner;
    if (!open) {
      inner = `<button class="pill" data-a="open" title="Ver historial de precio">📉 ${S.esc(v.text)}</button>`;
    } else {
      const vsAvg = s.n >= 2 ? Math.round((s.cur / s.avg - 1) * 100) : null;
      const note = (s.n < 3 || s.days < 3)
        ? `Empezamos a registrar este producto el ${S.shortDate(s.firstAt)}. Volvé a visitarlo en los próximos días para ver cómo evoluciona.`
        : `${s.n} registros en ${Math.max(1, Math.round(s.days))} días` + (vsAvg === null ? '' : ` · ${vsAvg > 0 ? '+' : ''}${vsAvg}% vs promedio`);
      const isT = S.isTracked(it);
      inner = `<div class="panel">
        <div class="head"><span>📉 Historial de precio</span><button data-a="close" aria-label="Cerrar">✕</button></div>
        <div class="body">
          <div class="price">${S.esc(S.money(s.cur, cur))}<span class="badge ${v.cls}">${S.esc(v.text)}</span></div>
          ${S.chart(it)}
          <div class="axis"><span>${S.esc(S.shortDate(s.firstAt))}</span><span>hoy</span></div>
          <div class="grid">
            <div><small>Mínimo</small><b>${S.esc(S.money(s.min, cur))}</b></div>
            <div><small>Promedio</small><b>${S.esc(S.money(s.avg, cur))}</b></div>
            <div><small>Máximo</small><b>${S.esc(S.money(s.max, cur))}</b></div>
          </div>
          <div class="note">${S.esc(note)}</div>
          <div class="row">
            <button class="btn ${isT ? 'on' : ''}" data-a="toggle">${isT ? '✓ Siguiendo (alertas activas)' : '🔔 Seguir y avisarme'}</button>
          </div>
          ${isT ? `<div class="row"><input type="number" min="0" placeholder="Precio objetivo" value="${it.target || ''}"><button class="btn sm" data-a="target">Guardar</button></div>` : ''}
        </div>
      </div>`;
    }
    shadow.innerHTML = `<style>${CSS}</style><div class="wrap">${inner}</div>`;
  }

  async function onClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a || !current) return;
    const act = a.dataset.a;
    if (act === 'open' || act === 'close') { open = act === 'open'; try { chrome.storage.local.set({ panelOpen: open }); } catch (_) {} return draw(); }
    let res;
    if (act === 'toggle') res = await send({ type: S.isTracked(current) ? 'untrack' : 'track', id: current.id });
    if (act === 'target') res = await send({ type: 'setTarget', id: current.id, target: Number(shadow.querySelector('input').value) });
    if (res && res.item) { current = res.item; draw(); }
  }

  async function run() {
    const id = X.itemIdFromUrl(location.href);
    currentId = id;
    if (!id) return removeHost();
    const info = X.parseDocument(document);
    if (!info) return removeHost();
    const res = await send({ type: 'visit', item: { id, url: X.canonicalUrl(location.href), ...info } });
    if (id !== currentId || !res || !res.item) return; // navegó mientras esperábamos
    current = res.item;
    draw();
  }

  try { chrome.storage.local.get('panelOpen', (r) => { open = !!(r && r.panelOpen); run(); }); } catch (_) { run(); }

  // MercadoLibre es en parte SPA: re-evaluamos si cambia la URL.
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(run, 1200); } }, 1000);
})();

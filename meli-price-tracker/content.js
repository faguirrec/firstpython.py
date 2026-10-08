// Inyecta un botón flotante "Seguir precio" en páginas de producto.
(function () {
  const X = self.MeliExtract;
  const id = X.itemIdFromUrl(location.href);
  if (!id) return;

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  let btn;

  function fmt(price, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(price); }
    catch (e) { return String(price); }
  }

  async function render() {
    const info = X.parseDocument(document);
    if (!info) return;
    const { tracked } = (await send({ type: 'isTracked', id })) || {};
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'mpt-btn';
      document.body.appendChild(btn);
    }
    btn.className = tracked ? 'mpt-on' : '';
    btn.textContent = tracked ? '✓ Siguiendo precio' : '📉 Seguir precio (' + fmt(info.price, info.currency) + ')';
    btn.onclick = async () => {
      if (tracked) await send({ type: 'untrack', id });
      else await send({ type: 'track', item: { id, url: X.canonicalUrl(location.href), ...info } });
      render();
    };
    // Si ya lo seguimos, aprovechamos la visita para registrar el precio actual.
    if (tracked) send({ type: 'observe', id, price: info.price });
  }

  render();
  // MercadoLibre es en parte SPA: reintentamos si cambia la URL.
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(render, 1200); } }, 1000);
})();

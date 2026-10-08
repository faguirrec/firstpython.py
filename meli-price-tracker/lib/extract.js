// Extracción de datos de producto desde el DOM (content script) o desde HTML crudo (service worker).
// Se apoya en JSON-LD / meta tags, que son más estables que las clases CSS de MercadoLibre.
(function (root) {
  const ID_RE = /\b(ML[A-Z])-?(\d{6,})\b/i;

  function itemIdFromUrl(url) {
    const m = ID_RE.exec(url);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }

  function canonicalUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return url;
    }
  }

  function num(v) {
    if (v == null) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function fromJsonLd(blocks) {
    for (const raw of blocks) {
      let data;
      try { data = JSON.parse(raw); } catch (e) { continue; }
      const list = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of list) {
        if (!node || !/Product/i.test(String(node['@type']))) continue;
        let offer = node.offers;
        if (Array.isArray(offer)) offer = offer[0];
        if (!offer) continue;
        const price = num(offer.price ?? offer.lowPrice);
        if (price == null) continue;
        const img = Array.isArray(node.image) ? node.image[0] : node.image;
        return { title: node.name, price, currency: offer.priceCurrency, image: img };
      }
    }
    return null;
  }

  // "54.999" (AR/CL/CO/UY/BR) o "54,999" (MX/PE) -> 54999. Un único separador seguido de exactamente
  // 3 dígitos es de miles; en cualquier otro caso es decimal. Con ambos, el último es el decimal.
  function parseAmount(text) {
    const t = String(text || '').replace(/[^\d.,]/g, '');
    if (!t) return null;
    const dot = t.lastIndexOf('.'), com = t.lastIndexOf(',');
    let norm;
    if (dot >= 0 && com >= 0) {
      const dec = Math.max(dot, com);
      norm = t.slice(0, dec).replace(/[.,]/g, '') + '.' + t.slice(dec + 1);
    } else if (dot >= 0 || com >= 0) {
      const sep = dot >= 0 ? '.' : ',';
      const parts = t.split(sep);
      norm = parts.length > 2 || (parts.length === 2 && parts[1].length === 3) ? parts.join('') : parts[0] + '.' + parts[1];
    } else norm = t;
    return num(norm);
  }

  // Precio tachado ("antes") de la publicación. MercadoLibre lo marca con la clase `andes-money-amount--previous`
  // y un aria-label "Antes: N pesos". Se busca dentro del bloque de precio principal para no tomar el de los
  // productos relacionados.
  function listFromDoc(doc) {
    const scope = doc.querySelector('.ui-pdp-price, .ui-pdp-container__row--price') || doc;
    const el = scope.querySelector('.andes-money-amount--previous, [aria-label^="Antes"]');
    if (!el) return null;
    const fr = el.querySelector('.andes-money-amount__fraction');
    if (fr) {
      let v = parseAmount(fr.textContent);
      const c = el.querySelector('.andes-money-amount__cents');
      if (v != null && c && /^\d{1,2}$/.test(c.textContent.trim())) v += Number(c.textContent.trim()) / 100;
      return v;
    }
    return parseAmount(el.getAttribute('aria-label') || el.textContent);
  }

  function listFromHtml(html) {
    const tag = /<[^>]*andes-money-amount--previous[^>]*>/i.exec(html);
    if (!tag) return null;
    const aria = /aria-label=["']([^"']*)["']/i.exec(tag[0]);
    if (aria && parseAmount(aria[1])) return parseAmount(aria[1]);
    const fr = /andes-money-amount__fraction[^>]*>([\d.,]+)</i.exec(html.slice(tag.index, tag.index + 600));
    return fr ? parseAmount(fr[1]) : null;
  }

  // Vendedor, a partir del texto "Vendido por ...". Mejor esfuerzo: si la página cambia, devuelve null y el panel lo omite.
  function sellerFromDoc(doc) {
    const walker = doc.createTreeWalker(doc.body || doc, 4 /* NodeFilter.SHOW_TEXT */);
    let n;
    while ((n = walker.nextNode())) {
      if (!/Vendido por/i.test(n.nodeValue)) continue;
      const own = n.nodeValue.replace(/^[\s\S]*?Vendido por/i, '').trim();
      const holder = n.parentElement;
      const link = holder && (holder.querySelector('a, [class*="seller"] span') || (holder.nextElementSibling));
      const name = (own || (link && link.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!name) continue;
      let box = holder; // contenedor del bloque del vendedor: buscamos la reputación en su texto
      for (let i = 0; i < 3 && box && box.parentElement; i++) box = box.parentElement;
      const txt = (box && box.textContent) || '';
      const lider = /MercadoL[ií]der(?:\s+(Platinum|Gold|Silver))?/i.exec(txt);
      return { name, lider: lider ? lider[0].replace(/\s+/g, ' ') : null, official: /Tienda oficial/i.test(txt) };
    }
    return null;
  }

  // Parser sobre HTML crudo (service worker: no hay DOMParser).
  function parseHtml(html) {
    const blocks = [];
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) blocks.push(m[1]);
    let info = fromJsonLd(blocks);
    if (!info) {
      const price = /<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.,]+)["']/i.exec(html);
      const cur = /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([A-Z]{3})["']/i.exec(html);
      const title = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
      const image = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html);
      if (price && num(price[1])) {
        info = { title: title && title[1], price: num(price[1]), currency: cur && cur[1], image: image && image[1] };
      }
    }
    if (info) { const l = listFromHtml(html); if (l) info.list = l; } // solo si se encontró: el HTML crudo puede no traer el bloque
    return info;
  }

  // Parser sobre el DOM de la página abierta.
  function parseDocument(doc) {
    const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
    let info = fromJsonLd(blocks);
    if (!info) {
      const p = doc.querySelector('meta[itemprop="price"]');
      if (p && num(p.content)) {
        info = {
          title: (doc.querySelector('meta[property="og:title"]') || {}).content || doc.title,
          price: num(p.content),
          currency: (doc.querySelector('meta[itemprop="priceCurrency"]') || {}).content,
          image: (doc.querySelector('meta[property="og:image"]') || {}).content
        };
      }
    }
    if (info) { info.list = listFromDoc(doc); info.seller = sellerFromDoc(doc); }
    return info;
  }

  const CURRENCY_BY_TLD = { ar: 'ARS', mx: 'MXN', cl: 'CLP', co: 'COP', uy: 'UYU', pe: 'PEN', ve: 'VES', ec: 'USD', br: 'BRL' };
  function currencyForUrl(url) {
    try { return CURRENCY_BY_TLD[new URL(url).hostname.split('.').pop()] || null; } catch (e) { return null; }
  }

  root.MeliExtract = { itemIdFromUrl, canonicalUrl, currencyForUrl, parseAmount, parseHtml, parseDocument };
})(typeof self !== 'undefined' ? self : this);

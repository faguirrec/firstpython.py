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
    return info;
  }

  const CURRENCY_BY_TLD = { ar: 'ARS', mx: 'MXN', cl: 'CLP', co: 'COP', uy: 'UYU', pe: 'PEN', ve: 'VES', ec: 'USD', br: 'BRL' };
  function currencyForUrl(url) {
    try { return CURRENCY_BY_TLD[new URL(url).hostname.split('.').pop()] || null; } catch (e) { return null; }
  }

  root.MeliExtract = { itemIdFromUrl, canonicalUrl, currencyForUrl, parseHtml, parseDocument };
})(typeof self !== 'undefined' ? self : this);

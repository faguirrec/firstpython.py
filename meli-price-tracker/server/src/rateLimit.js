// Límite simple por clave (ventana fija en memoria). Alcanza para una sola instancia.
export function rateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  let sweepAt = 0;
  return (req, res, next) => {
    const t = now();
    if (t > sweepAt) { // limpieza periódica para no crecer sin límite
      for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      sweepAt = t + windowMs;
    }
    const key = req.ip || 'unknown';
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}

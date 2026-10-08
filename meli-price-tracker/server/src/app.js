import express from 'express';
import { createHash } from 'node:crypto';
import { BUCKET_MS, MAX_BATCH, isClientId, isItemId, median, parseObservation } from './validate.js';
import { rateLimiter } from './rateLimit.js';

const DAY_MS = 86400000;
const CLIENT_DAILY_CAP = 2000;  // observaciones por cliente cada 24 h
const OUTLIER_MIN_CLIENTS = 3;  // con al menos esta cantidad de aportantes recientes se descartan precios absurdos
const OUTLIER_RATIO = 5;        // fuera de [mediana/5, mediana*5]

export function createApp(db, { salt, now = () => Date.now(), ipLimit = 240 } = {}) {
  if (!salt) throw new Error('salt requerido');
  const hashClient = (id) => createHash('sha256').update(salt + ':' + id.toLowerCase()).digest('hex');

  const insert = db.prepare(`INSERT OR IGNORE INTO observations (item_id, client, bucket, price, currency, ts) VALUES (?, ?, ?, ?, ?, ?)`);
  const recentForItem = db.prepare(`SELECT price, client FROM observations WHERE item_id = ? AND ts >= ?`);
  const clientCount = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE client = ? AND ts >= ?`);
  const historyRows = db.prepare(`SELECT bucket, price, currency, client, ts FROM observations WHERE item_id = ? AND bucket >= ? ORDER BY bucket, ts`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimiter({ windowMs: 60000, max: ipLimit, now }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // POST /v1/observations  { client, items: [{ id, price, currency }] }
  // El servidor pone la hora: el cliente no puede falsear cuándo se vio un precio.
  app.post('/v1/observations', (req, res) => {
    const { client, items } = req.body || {};
    if (!isClientId(client) || !Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const t = now();
    const ch = hashClient(client);
    const budget = CLIENT_DAILY_CAP - clientCount.get(ch, t - DAY_MS).n;
    if (budget <= 0) return res.status(429).json({ error: 'client_cap' });

    let accepted = 0, rejected = 0, duplicates = 0;
    const run = db.transaction(() => {
      for (const raw of items) {
        const o = parseObservation(raw);
        if (!o || accepted >= budget) { rejected++; continue; }
        const rows = recentForItem.all(o.id, t - 7 * DAY_MS);
        if (new Set(rows.map((r) => r.client)).size >= OUTLIER_MIN_CLIENTS) {
          const m = median(rows.map((r) => r.price));
          if (o.price > m * OUTLIER_RATIO || o.price < m / OUTLIER_RATIO) { rejected++; continue; }
        }
        // changes === 0: este cliente ya aportó este producto en esta ventana de 6 h (no es un error)
        const r = insert.run(o.id, ch, Math.floor(t / BUCKET_MS), o.price, o.currency, t);
        if (r.changes) accepted++; else duplicates++;
      }
    });
    run();
    res.json({ accepted, rejected, duplicates });
  });

  // GET /v1/items/:id/history?days=365 -> puntos [ts, precio, aportantes] (mediana por ventana de 6 h)
  app.get('/v1/items/:id/history', (req, res) => {
    const id = String(req.params.id).toUpperCase();
    if (!isItemId(id)) return res.status(400).json({ error: 'bad_item' });
    const days = Math.min(730, Math.max(1, parseInt(req.query.days, 10) || 365));
    const rows = historyRows.all(id, Math.floor((now() - days * DAY_MS) / BUCKET_MS));

    // Moneda mayoritaria: ignoramos aportes en otra moneda del mismo id.
    const cc = new Map();
    for (const r of rows) cc.set(r.currency, (cc.get(r.currency) || 0) + 1);
    const currency = [...cc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const buckets = new Map();
    for (const r of rows) {
      if (r.currency !== currency) continue;
      if (!buckets.has(r.bucket)) buckets.set(r.bucket, []);
      buckets.get(r.bucket).push(r);
    }
    const points = [...buckets.values()].map((list) => [
      Math.min(...list.map((r) => r.ts)),
      median(list.map((r) => r.price)),
      new Set(list.map((r) => r.client)).size
    ]);
    const contributors = new Set(rows.map((r) => r.client)).size;
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ id, currency, contributors, points });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'bad_request' });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

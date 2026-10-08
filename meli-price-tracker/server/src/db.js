import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Una observación por (producto, cliente, ventana de 6 h): evita inflar el historial
  // y limita cuánto puede pesar un solo cliente en la mediana de cada ventana.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      item_id  TEXT    NOT NULL,
      client   TEXT    NOT NULL,   -- sha256(clientId + salt); nunca el id crudo
      bucket   INTEGER NOT NULL,   -- floor(ts / 6h)
      price    REAL    NOT NULL,
      currency TEXT    NOT NULL,
      ts       INTEGER NOT NULL,
      PRIMARY KEY (item_id, client, bucket)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS obs_item_bucket ON observations (item_id, bucket);
    CREATE INDEX IF NOT EXISTS obs_client_ts   ON observations (client, ts);
  `);
  return db;
}

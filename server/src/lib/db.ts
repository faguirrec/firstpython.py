import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data/hogar.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS households (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'CLP',
  -- Etiqueta de la cuenta bancaria "oficial" del hogar (de donde salen los gastos comunes).
  official_account TEXT NOT NULL DEFAULT 'Cuenta del hogar',
  -- Porcentaje extra sobre el gasto estimado que se aporta como fondo de reserva.
  contingency_pct REAL NOT NULL DEFAULT 10,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un hogar acepta exactamente 2 miembros (persona 1 y persona 2).
CREATE TABLE IF NOT EXISTS household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by      TEXT REFERENCES users(id),
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sueldo líquido declarado por persona y por mes (YYYY-MM).
CREATE TABLE IF NOT EXISTS incomes (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  amount       REAL NOT NULL,
  note         TEXT,
  UNIQUE (household_id, user_id, month)
);

CREATE TABLE IF NOT EXISTS categories (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'necesidad',
  color        TEXT NOT NULL DEFAULT '#6b7280',
  archived     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (household_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  occurred_on   TEXT NOT NULL,                -- YYYY-MM-DD
  amount        REAL NOT NULL,                -- siempre positivo
  type          TEXT NOT NULL,                -- gasto | aporte | ingreso_extra
  scope         TEXT NOT NULL DEFAULT 'comun',-- comun | personal
  funded_by     TEXT NOT NULL DEFAULT 'oficial', -- 'oficial' o el user_id que pagó de su bolsillo
  user_id       TEXT REFERENCES users(id),    -- autor / dueño del aporte o gasto personal
  category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
  merchant      TEXT,
  description   TEXT,
  account_label TEXT,
  installments  INTEGER,
  source        TEXT NOT NULL DEFAULT 'manual', -- manual | gmail
  source_msg_id TEXT,
  raw_snippet   TEXT,
  reviewed      INTEGER NOT NULL DEFAULT 1,   -- 0 = importado, pendiente de revisar
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, source_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_household_date ON transactions (household_id, occurred_on);

-- Reglas de parseo de correos bancarios.
CREATE TABLE IF NOT EXISTS email_rules (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  gmail_query   TEXT NOT NULL,
  amount_regex  TEXT NOT NULL,
  merchant_regex TEXT,
  date_regex    TEXT,
  account_regex TEXT,
  card_filter   TEXT,          -- si se define, sólo importa si el correo menciona estos dígitos
  type          TEXT NOT NULL DEFAULT 'gasto',
  scope         TEXT NOT NULL DEFAULT 'comun',
  account_label TEXT,
  priority      INTEGER NOT NULL DEFAULT 100
);

-- Reglas de categorización automática por comercio.
CREATE TABLE IF NOT EXISTS category_rules (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  pattern      TEXT NOT NULL,
  category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority     INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS gmail_accounts (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  last_sync_at  TEXT,
  UNIQUE (household_id, email)
);

-- Cierre de mes: deja congelado quién le debía a quién.
CREATE TABLE IF NOT EXISTS settlements (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  snapshot     TEXT NOT NULL,
  settled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, month)
);
`);

/**
 * Migraciones incrementales.
 *
 * La app ya está en uso, así que las columnas nuevas se agregan sobre la base
 * existente en vez de recrear tablas: nadie pierde sus movimientos al actualizar.
 */
function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('households', 'contingency_pct', 'REAL NOT NULL DEFAULT 10');
addColumn('invites', 'revoked', 'INTEGER NOT NULL DEFAULT 0');

export function uid(): string {
  return crypto.randomUUID();
}

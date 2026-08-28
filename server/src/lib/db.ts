import Database from 'better-sqlite3';
import { BANK_TEMPLATES, DEFAULT_CATEGORIES } from '../services/bankTemplates.js';
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
  -- Envío automático del resumen del mes cerrado a los dos integrantes.
  send_monthly_report INTEGER NOT NULL DEFAULT 1,
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
  emoji        TEXT NOT NULL DEFAULT '📦',
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

-- Cuentas leídas por IMAP con una contraseña de aplicación. Van aparte de
-- gmail_accounts porque no comparten nada: aquélla guarda un token de OAuth que
-- caduca, ésta una credencial permanente que se guarda cifrada.
CREATE TABLE IF NOT EXISTS imap_accounts (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  -- Cifrada con AES-256-GCM (ver lib/cripto.ts). Nunca en claro.
  secreto       TEXT NOT NULL,
  host          TEXT NOT NULL DEFAULT 'imap.gmail.com',
  port          INTEGER NOT NULL DEFAULT 993,
  carpeta       TEXT NOT NULL DEFAULT 'INBOX',
  last_sync_at  TEXT,
  UNIQUE (household_id, email)
);

-- Presupuesto por categoría. month NULL = presupuesto base, vale todos los meses;
-- una fila con mes concreto lo reemplaza sólo para ese mes.
CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month        TEXT,
  amount       REAL NOT NULL
);

-- Los índices únicos de presupuestos se crean más abajo, junto a la migración
-- que les agregó el dueño: definirlos acá también significaría crearlos en cada
-- arranque para borrarlos dos líneas después.

-- Metas de ahorro. Se financian desde el fondo de reserva por orden de prioridad.
CREATE TABLE IF NOT EXISTS savings_goals (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target_amount REAL NOT NULL,
  target_date  TEXT,
  priority     INTEGER NOT NULL DEFAULT 100,
  achieved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Registro de correos enviados. Es lo que evita mandar dos veces el mismo
-- reporte cuando la tarea se dispara desde varios lados.
CREATE TABLE IF NOT EXISTS email_log (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  reference    TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_unico
  ON email_log (household_id, kind, reference, recipient);

-- Saldos que un mes le pasa al siguiente.
--
-- Cuando un mes cierra desbalanceado, la deuda entre las dos personas puede
-- resolverse con una transferencia —lo de siempre— o arrastrarse al mes que
-- viene. Esto último no es un gasto ni un aporte: es un ajuste entre ellos, así
-- que vive aparte de la tabla de movimientos, donde contaminaría los totales
-- del hogar.
--
-- El monto va firmado: negativo es "viene debiendo". La suma de los arrastres
-- de un mismo mes es siempre cero, porque lo que uno debe el otro lo tiene a
-- favor.
CREATE TABLE IF NOT EXISTS carryovers (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- El mes que se cerró y de donde viene el saldo.
  from_period  TEXT NOT NULL,
  -- El mes que lo recibe. Normalmente el siguiente.
  to_period    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Cerrar dos veces el mismo mes no puede duplicar el arrastre.
  UNIQUE (household_id, from_period, user_id)
);

CREATE INDEX IF NOT EXISTS idx_arrastre_destino ON carryovers (household_id, to_period);

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

/*
 * Cuánto de lo que sobra al cerrar el mes se queda el hogar para ahorrar.
 *
 * Es un porcentaje del gasto mensual, no del excedente: así el ahorro es una
 * cifra estable —"guardamos $140.000 al mes"— y no una que sube y baja con lo
 * que haya sobrado. Lo que pase de ese tope vuelve como crédito a quien lo puso.
 */
addColumn('households', 'savings_pct', 'REAL NOT NULL DEFAULT 10');

/*
 * Ajuste del saldo de la cuenta.
 *
 * La app calcula lo que debería haber en el banco sumando aportes y restando
 * gastos, y parte de cero el día que el hogar empieza a usarla. Si la cuenta ya
 * tenía plata antes —lo normal—, el número queda corrido por esa cantidad para
 * siempre, sin forma de arreglarlo.
 *
 * Acá vive lo que había al empezar, y también cualquier diferencia que al
 * cuadrar contra la cartola decidan no perseguir. No es un aporte de nadie: es
 * plata del hogar que existía antes del reparto, así que no toca la liquidación
 * ni le cuenta a ninguno de los dos.
 */
addColumn('households', 'balance_adjustment', 'REAL NOT NULL DEFAULT 0');
addColumn('households', 'balance_adjusted_at', 'TEXT');
addColumn('invites', 'revoked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('households', 'send_monthly_report', 'INTEGER NOT NULL DEFAULT 1');
addColumn('categories', 'emoji', "TEXT NOT NULL DEFAULT '📦'");
// A quién pertenece lo que importe esta regla. Importa sobre todo para los
// aportes: la liquidación suma lo que puso cada persona por su user_id, así que
// un aporte sin dueño no le cuenta a nadie y el saldo del mes queda mal.
addColumn('email_rules', 'user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
// Condición extra de texto: la regla sólo se aplica si el correo contiene todos
// estos textos. Sirve para separar dos correos del mismo banco con el mismo
// formato —por ejemplo, quién hizo la transferencia o a qué cuenta llegó.
addColumn('email_rules', 'must_contain', 'TEXT');
// Y su opuesto. Hace falta porque hay correos que se reconocen por lo que *no*
// dicen: un banco avisa la misma transferencia dos veces —como enviada y como
// recibida—, y la única forma de no contarla dos veces es descartar una de las
// dos por la cuenta de destino.
addColumn('email_rules', 'must_not_contain', 'TEXT');

/*
 * De dónde sacar el mes al que cuenta lo que importa la regla.
 *
 * Una transferencia lleva un comentario que el que la hace escribe a mano —"Mensualidad
 * septiembre"—, y ese comentario dice a qué mes pertenece la plata mucho mejor
 * que la fecha en que se apretó el botón: el sueldo del 25 de agosto paga el
 * septiembre. Si la regla no lo define, el mes sigue saliendo de la fecha.
 */
addColumn('email_rules', 'period_regex', 'TEXT');

/*
 * De qué plantilla salió la regla.
 *
 * Las plantillas son una copia, no un vínculo: al crear el hogar se copian a
 * esta tabla y ahí quedan congeladas. Cuando un banco cambia el formato de sus
 * avisos y la plantilla se corrige en el código, los hogares que ya existían
 * siguen con la copia vieja y no hay forma de enterarse: la regla simplemente
 * deja de calzar, sin error. Guardar de dónde vino permite ofrecer traer los
 * cambios.
 */
addColumn('email_rules', 'template_key', 'TEXT');

/*
 * Relleno para los hogares que ya existían, por el nombre de la plantilla.
 *
 * El nombre es lo único que las ata, y alcanza: son distintivos ("Banco de
 * Chile — transferencia recibida (aporte)") y nadie los escribe a mano por
 * casualidad. Si alguien renombró su regla, se queda sin el vínculo y no pasa
 * nada más: sigue funcionando como está.
 */
{
  const porNombre = db.prepare(
    'UPDATE email_rules SET template_key = ? WHERE template_key IS NULL AND name = ?',
  );
  for (const t of BANK_TEMPLATES) porNombre.run(t.key, t.name);
}

/*
 * A qué mes cuenta un movimiento, que no siempre es el de su fecha.
 *
 * Los sueldos no llegan el mismo día ni a fin de mes exacto, así que la cuenta
 * de septiembre se paga a menudo el 28 de agosto. Amarrar el mes a la fecha
 * obligaba a falsear la fecha para que el gasto cayera donde corresponde —y con
 * los correos del banco ni siquiera eso era posible, porque la fecha la pone el
 * banco—.
 *
 * `occurred_on` sigue siendo cuándo ocurrió de verdad, para poder cuadrar con
 * la cartola. `period` es a qué mes se imputa.
 */
addColumn('transactions', 'period', 'TEXT');
db.prepare("UPDATE transactions SET period = substr(occurred_on, 1, 7) WHERE period IS NULL").run();

/*
 * Red de protección: SQLite no admite un DEFAULT calculado en ALTER TABLE, y
 * una inserción que olvide el período dejaría una fila que ninguna consulta por
 * mes encuentra —invisible en la app pero presente en la base—. El disparador
 * la completa con el mes de la fecha, que es el valor correcto por defecto.
 */
db.exec(`
  CREATE TRIGGER IF NOT EXISTS transactions_period_por_defecto
  AFTER INSERT ON transactions WHEN NEW.period IS NULL
  BEGIN
    UPDATE transactions SET period = substr(NEW.occurred_on, 1, 7) WHERE id = NEW.id;
  END;
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_tx_periodo ON transactions (household_id, period)');

/*
 * Gasto estimado del mes, el que sirve para calcular cuánto transferir a
 * principio de mes.
 *
 * Se guarda y se arrastra igual que el sueldo: escribirlo una vez y que el mes
 * siguiente lo asuma, en vez de recalcularlo cada vez que se abre la pantalla.
 * Una fila por mes en que se cambió; los meses sin fila heredan el último.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS expense_targets (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    month        TEXT NOT NULL,
    amount       REAL NOT NULL,
    PRIMARY KEY (household_id, month)
  );
`);

/*
 * Gastos fijos: lo que se repite todos los meses.
 *
 * Son una **expectativa**, no un movimiento. La app nunca inventa un gasto que
 * quizá no ocurrió: cruza lo declarado con los movimientos reales del mes y con
 * eso puede decir qué falta por pagar. Si los creara sola, además chocarían con
 * los que entran por correo y todo quedaría duplicado.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS fixed_expenses (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    -- NULL cuando el monto cambia mes a mes (la luz, el agua). En ese caso se
    -- estima con el promedio de lo que se pagó antes.
    amount       REAL,
    category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
    -- Día aproximado de vencimiento, para ordenar y para avisar a tiempo.
    due_day      INTEGER,
    -- Texto que debe aparecer en el comercio o la glosa para dar por pagado un
    -- movimiento. Sin esto basta con que caiga en la misma categoría.
    match_text   TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Presupuestos y metas dejan de ser sólo del hogar: sin dueño son del hogar,
// con dueño son de esa persona. Así la misma pantalla sirve para las dos cosas.
addColumn('budgets', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
addColumn('savings_goals', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');

/*
 * Los índices únicos de presupuestos tienen que incluir al dueño, y no basta
 * con agregar la columna: en SQLite dos NULL se consideran distintos, así que
 * un índice sobre user_id dejaría entrar varios presupuestos del hogar para la
 * misma categoría. Con COALESCE el hogar queda representado por una cadena
 * vacía, que sí compara igual.
 */
db.exec(`
  DROP INDEX IF EXISTS idx_budget_base;
  DROP INDEX IF EXISTS idx_budget_month;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_base_duenio
    ON budgets (household_id, COALESCE(user_id, ''), category_id) WHERE month IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_month_duenio
    ON budgets (household_id, COALESCE(user_id, ''), category_id, month) WHERE month IS NOT NULL;
`);

/**
 * Los hogares creados antes de que existieran los emoji quedan con el genérico.
 * Se les asigna el que corresponde por nombre, para que no haya que editarlos a
 * mano uno por uno.
 */
function asignarEmojiPorNombre(): void {
  const pendientes = db
    .prepare("SELECT COUNT(*) AS n FROM categories WHERE emoji = '📦'")
    .get() as { n: number };
  if (pendientes.n === 0) return;

  const actualizar = db.prepare("UPDATE categories SET emoji = ? WHERE name = ? AND emoji = '📦'");
  for (const categoria of DEFAULT_CATEGORIES) {
    if (categoria.emoji !== '📦') actualizar.run(categoria.emoji, categoria.name);
  }
}
asignarEmojiPorNombre();

export function uid(): string {
  return crypto.randomUUID();
}

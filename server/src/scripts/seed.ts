/**
 * Crea un hogar de ejemplo con dos personas, sueldos distintos y tres meses de
 * gastos, para poder ver la app funcionando sin conectar Gmail.
 *
 *   npm run seed          (dentro de server/)
 *
 * Usuarios: ana@ejemplo.cl / bruno@ejemplo.cl — contraseña: hogar1234
 */
import bcrypt from 'bcryptjs';
import { db, uid } from '../lib/db.js';
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_RULES, BANK_TEMPLATES } from '../services/bankTemplates.js';
import { computeSettlement } from '../services/split.js';

const PASSWORD = bcrypt.hashSync('hogar1234', 10);

function user(email: string, name: string): string {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uid();
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(id, email, PASSWORD, name);
  return id;
}

function monthsBack(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const ana = user('ana@ejemplo.cl', 'Ana');
const bruno = user('bruno@ejemplo.cl', 'Bruno');

const existingHousehold = db
  .prepare('SELECT household_id AS id FROM household_members WHERE user_id = ?')
  .get(ana) as { id: string } | undefined;

if (existingHousehold) {
  console.log('El hogar de ejemplo ya existe. Borra server/data/hogar.db si quieres regenerarlo.');
  process.exit(0);
}

const householdId = uid();
db.prepare('INSERT INTO households (id, name, currency, official_account) VALUES (?, ?, ?, ?)').run(
  householdId, 'Casa Ana y Bruno', 'CLP', 'Cuenta corriente del hogar',
);
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)').run(householdId, ana, 'owner');
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)').run(householdId, bruno, 'member');

const categoryIds = new Map<string, string>();
for (const c of DEFAULT_CATEGORIES) {
  const id = uid();
  db.prepare('INSERT INTO categories (id, household_id, name, kind, color) VALUES (?, ?, ?, ?, ?)').run(
    id, householdId, c.name, c.kind, c.color,
  );
  categoryIds.set(c.name, id);
}
DEFAULT_CATEGORY_RULES.forEach((rule, i) => {
  const categoryId = categoryIds.get(rule.category);
  if (categoryId) {
    db.prepare('INSERT INTO category_rules (id, household_id, pattern, category_id, priority) VALUES (?, ?, ?, ?, ?)').run(
      uid(), householdId, rule.pattern, categoryId, i * 10,
    );
  }
});
BANK_TEMPLATES.forEach((t, i) => {
  db.prepare(
    `INSERT INTO email_rules (id, household_id, name, enabled, gmail_query, amount_regex, merchant_regex,
       date_regex, account_regex, type, scope, account_label, priority)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid(), householdId, t.name, t.gmail_query, t.amount_regex, t.merchant_regex, t.date_regex,
    t.account_regex, t.type, t.scope, t.account_label, i * 10,
  );
});

const months = monthsBack(4);
const salaries: Record<string, [number, number]> = {};
months.forEach((m, i) => {
  salaries[m] = [1_450_000 + i * 20_000, 980_000 + i * 10_000];
});

for (const month of months) {
  const [anaSalary, brunoSalary] = salaries[month];
  db.prepare('INSERT INTO incomes (id, household_id, user_id, month, amount) VALUES (?, ?, ?, ?, ?)').run(
    uid(), householdId, ana, month, anaSalary,
  );
  db.prepare('INSERT INTO incomes (id, household_id, user_id, month, amount) VALUES (?, ?, ?, ?, ?)').run(
    uid(), householdId, bruno, month, brunoSalary,
  );
}

const template: [string, string, number][] = [
  ['Arriendo / Dividendo', 'Inmobiliaria Los Robles', 650_000],
  ['Cuentas (luz, agua, gas)', 'Enel Distribución', 48_000],
  ['Cuentas (luz, agua, gas)', 'Aguas Andinas', 26_500],
  ['Internet y telefonía', 'VTR Banda Ancha', 39_990],
  ['Supermercado', 'Jumbo Kennedy', 182_400],
  ['Supermercado', 'Lider Express', 64_300],
  ['Transporte y bencina', 'Copec Vitacura', 55_000],
  ['Restaurantes y delivery', 'PedidosYa', 34_800],
  ['Entretención', 'Netflix', 9_990],
  ['Entretención', 'Spotify Familiar', 12_990],
  ['Salud y farmacia', 'Cruz Verde', 28_700],
  ['Hogar y mantención', 'Sodimac Homecenter', 71_200],
  ['Mascotas', 'Veterinaria Ñuñoa', 45_000],
];

const insertTx = db.prepare(
  `INSERT INTO transactions
     (id, household_id, occurred_on, amount, type, scope, funded_by, user_id, category_id,
      merchant, description, account_label, source, reviewed)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1)`,
);

months.forEach((month, monthIndex) => {
  let total = 0;
  template.forEach(([category, merchant, base], i) => {
    // Variación determinista para que los meses no salgan idénticos.
    const amount = Math.round(base * (1 + ((monthIndex * 7 + i * 3) % 11) / 100));
    const day = String(((i * 2 + 3) % 27) + 1).padStart(2, '0');
    total += amount;
    insertTx.run(
      uid(), householdId, `${month}-${day}`, amount, 'gasto', 'comun', 'oficial', null,
      categoryIds.get(category) ?? null, merchant, `Cargo ${merchant}`, 'Cuenta corriente del hogar',
    );
  });

  // Cada uno transfiere su parte proporcional del mes anterior (redondeada).
  const [anaSalary, brunoSalary] = salaries[month];
  const totalSalary = anaSalary + brunoSalary;
  const anaShare = Math.round((total * anaSalary) / totalSalary / 1000) * 1000;
  const brunoShare = Math.round((total * brunoSalary) / totalSalary / 1000) * 1000;

  insertTx.run(uid(), householdId, `${month}-05`, anaShare, 'aporte', 'comun', 'oficial', ana, null,
    'Transferencia Ana', 'Aporte mensual', 'Cuenta corriente del hogar');
  insertTx.run(uid(), householdId, `${month}-05`, brunoShare, 'aporte', 'comun', 'oficial', bruno, null,
    'Transferencia Bruno', 'Aporte mensual', 'Cuenta corriente del hogar');

  // Un gasto común pagado de bolsillo, para ejercitar la liquidación.
  insertTx.run(
    uid(), householdId, `${month}-19`, 32_000 + monthIndex * 1500, 'gasto', 'comun', bruno, bruno,
    categoryIds.get('Supermercado') ?? null, 'Feria Ñuñoa', 'Compra de la feria (pagó Bruno)', 'Efectivo',
  );
});

const check = computeSettlement(householdId, months[months.length - 1], 'CLP');
console.log(`Hogar de ejemplo creado (${householdId}).`);
console.log(`Entra con ana@ejemplo.cl o bruno@ejemplo.cl — contraseña: hogar1234`);
console.log(`Liquidación de ${check.month}: ${check.note}`);

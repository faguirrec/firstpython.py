/** La migración de presupuestos y metas sobre una base que ya tenía datos. */
import { db, uid } from '../src/lib/db.js';

let fallas = 0;
function ok(n: string, c: boolean, d?: unknown) {
  console.log(`${c ? '  ok' : 'FALLA'}  ${n}`);
  if (!c) { fallas += 1; if (d !== undefined) console.log('        ', d); }
}

const indices = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='budgets'")
  .all() as { name: string }[];
const nombres = indices.map((i) => i.name);
ok('los índices viejos ya no están',
   !nombres.includes('idx_budget_base') && !nombres.includes('idx_budget_month'), nombres);
ok('están los nuevos, con dueño',
   nombres.includes('idx_budget_base_duenio') && nombres.includes('idx_budget_month_duenio'), nombres);

const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
ok('budgets tiene dueño', cols('budgets').includes('user_id'), cols('budgets'));
ok('savings_goals tiene dueño', cols('savings_goals').includes('user_id'), cols('savings_goals'));

// Un hogar mínimo para probar la unicidad.
const u1 = uid(), u2 = uid(), h = uid(), cat = uid();
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(u1, 'a@p.cl', 'x', 'Ana');
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(u2, 'b@p.cl', 'x', 'Bruno');
db.prepare('INSERT INTO households (id,name,currency,official_account) VALUES (?,?,?,?)').run(h, 'Casa', 'CLP', 'C');
db.prepare('INSERT INTO categories (id,household_id,name,kind,color,emoji) VALUES (?,?,?,?,?,?)')
  .run(cat, h, 'Supermercado', 'necesidad', '#16a34a', '🛒');

const meter = (duenio: string | null, monto: number) =>
  db.prepare('INSERT INTO budgets (id,household_id,user_id,category_id,month,amount) VALUES (?,?,?,?,NULL,?)')
    .run(uid(), h, duenio, cat, monto);

meter(null, 300000);
ok('el hogar puede tener su presupuesto', true);

let choco = false;
try { meter(null, 400000); } catch { choco = true; }
ok('pero no dos para la misma categoría', choco);

meter(u1, 80000);
meter(u2, 50000);
ok('cada persona puede tener el suyo, en la misma categoría', true);

let choco2 = false;
try { meter(u1, 90000); } catch { choco2 = true; }
ok('y tampoco dos de la misma persona', choco2);

const cuantos = db.prepare('SELECT COUNT(*) AS n FROM budgets WHERE household_id = ?').get(h) as { n: number };
ok('quedaron los tres', cuantos.n === 3, cuantos);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

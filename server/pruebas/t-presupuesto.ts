/**
 * El semáforo del presupuesto mira el ritmo del mes, no sólo el tope.
 *
 * Gastar el 75% del supermercado el día 15 va acelerado aunque quede un cuarto
 * disponible; verlo en verde es peor que no tener aviso, porque tranquiliza.
 */
import { db, uid } from '../src/lib/db.js';
import { seedHousehold } from '../src/routes/household.js';
import { computeBudgetStatus } from '../src/services/planning.js';

let fallas = 0;
function ok(n: string, c: boolean, d?: unknown) {
  console.log(`${c ? '  ok' : 'FALLA'}  ${n}`);
  if (!c) { fallas += 1; if (d !== undefined) console.log('        ', d); }
}

const u = uid(), h = uid();
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(u, `${u}@p.cl`, 'x', 'Ana');
db.prepare('INSERT INTO households (id,name,currency,official_account) VALUES (?,?,?,?)').run(h, 'Casa', 'CLP', 'C');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(h, u, 'owner');
seedHousehold(h);

const cat = db.prepare("SELECT id FROM categories WHERE household_id = ? AND name LIKE 'Supermercado%'")
  .get(h) as { id: string };
db.prepare('INSERT INTO budgets (id,household_id,user_id,category_id,month,amount) VALUES (?,?,NULL,?,NULL,?)')
  .run(uid(), h, cat.id, 100000);

function gastar(monto: number, periodo: string) {
  db.prepare(
    `INSERT INTO transactions (id, household_id, occurred_on, period, amount, type, scope, funded_by, category_id, source, reviewed)
     VALUES (?, ?, ?, ?, ?, 'gasto', 'comun', 'oficial', ?, 'manual', 1)`,
  ).run(uid(), h, `${periodo}-10`, periodo, monto, cat.id);
}

const estadoDe = (mes: string) =>
  computeBudgetStatus(h, mes).categories.find((c) => c.categoryId === cat.id)!;

// Un mes ya terminado: el ritmo es 1, así que sólo importa el tope.
const PASADO = '2026-01';
gastar(75000, PASADO);
ok('en un mes cerrado, 75% del tope está en rango', estadoDe(PASADO).status === 'ok', estadoDe(PASADO));

const PASADO2 = '2026-02';
gastar(95000, PASADO2);
ok('pero 95% ya es atención aunque no se haya pasado',
   estadoDe(PASADO2).status === 'atencion', estadoDe(PASADO2));

const PASADO3 = '2026-03';
gastar(120000, PASADO3);
ok('y pasarse es excedido', estadoDe(PASADO3).status === 'excedido', estadoDe(PASADO3));

// El mes en curso: lo que manda es el ritmo.
const AHORA = new Date().toISOString().slice(0, 7);
const avance = computeBudgetStatus(h, AHORA).monthProgress;
gastar(Math.round(100000 * Math.min(avance + 0.30, 0.95)), AHORA);
ok('ir bastante más rápido que el mes enciende la alerta',
   estadoDe(AHORA).status === 'atencion', [avance, estadoDe(AHORA).used, estadoDe(AHORA).status]);

const OTRO = uid();
db.prepare('INSERT INTO households (id,name,currency,official_account) VALUES (?,?,?,?)').run(OTRO, 'Otra', 'CLP', 'C');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(OTRO, u, 'member');
seedHousehold(OTRO);
const cat2 = db.prepare("SELECT id FROM categories WHERE household_id = ? AND name LIKE 'Supermercado%'")
  .get(OTRO) as { id: string };
db.prepare('INSERT INTO budgets (id,household_id,user_id,category_id,month,amount) VALUES (?,?,NULL,?,NULL,?)')
  .run(uid(), OTRO, cat2.id, 100000);
db.prepare(
  `INSERT INTO transactions (id, household_id, occurred_on, period, amount, type, scope, funded_by, category_id, source, reviewed)
   VALUES (?, ?, ?, ?, ?, 'gasto', 'comun', 'oficial', ?, 'manual', 1)`,
).run(uid(), OTRO, `${AHORA}-02`, AHORA, Math.round(100000 * Math.max(avance - 0.10, 0)), cat2.id);
const alRitmo = computeBudgetStatus(OTRO, AHORA).categories.find((c) => c.categoryId === cat2.id)!;
ok('ir al ritmo del mes se ve en rango', alRitmo.status === 'ok', [avance, alRitmo.used, alRitmo.status]);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

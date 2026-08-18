/**
 * Un aporte importado tiene que quedar a nombre de alguien.
 *
 * La liquidación suma lo que puso cada persona por su usuario. Antes, todo lo
 * que entraba por correo quedaba sin dueño, así que un abono a la cuenta del
 * hogar aparecía en el saldo de la cuenta pero no le contaba a nadie: los dos
 * salían debiendo la misma plata que ya habían puesto.
 */
import { db, uid } from '../src/lib/db.js';
import { seedHousehold } from '../src/routes/household.js';
import { cifrar } from '../src/lib/cripto.js';
import { sincronizarImap } from '../src/services/imap.js';
import { computeSettlement } from '../src/services/split.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

// Dos personas con sueldos distintos: 60/40.
const francisco = uid();
const pareja = uid();
db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
  .run(francisco, `f${francisco}@ejemplo.cl`, 'x', 'Francisco Aguirre');
db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
  .run(pareja, `p${pareja}@ejemplo.cl`, 'x', 'Su pareja');

const hogar = uid();
db.prepare('INSERT INTO households (id, name, currency, official_account) VALUES (?, ?, ?, ?)')
  .run(hogar, 'Casa', 'CLP', 'Mercado Pago');
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
  .run(hogar, francisco, 'owner');
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
  .run(hogar, pareja, 'member');
seedHousehold(hogar);

const MES = '2026-08';
db.prepare('INSERT INTO incomes (id, household_id, user_id, month, amount) VALUES (?, ?, ?, ?, ?)')
  .run(uid(), hogar, francisco, MES, 1_500_000);
db.prepare('INSERT INTO incomes (id, household_id, user_id, month, amount) VALUES (?, ?, ?, ?, ?)')
  .run(uid(), hogar, pareja, MES, 1_000_000);

// La regla del comprobante, atribuida a Francisco.
db.prepare(
  `UPDATE email_rules SET enabled = 1, user_id = ?, must_contain = ?
    WHERE household_id = ? AND name LIKE 'Banco de Chile — transferencia recibida%'`,
).run(francisco, 'Mercado Pago; Francisco Javier Aguirre', hogar);

const activadas = db
  .prepare('SELECT COUNT(*) AS n FROM email_rules WHERE household_id = ? AND enabled = 1')
  .get(hogar) as { n: number };
ok('la plantilla del comprobante existe y quedó activa', activadas.n === 1, activadas);

db.prepare(
  `INSERT INTO imap_accounts (id, household_id, user_id, email, secreto, host, port, carpeta)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(uid(), hogar, francisco, 'testuser', cifrar('testpass'), 'localhost', 9993, 'INBOX');

async function main() {
  const r = await sincronizarImap(hogar, 100, false);
  ok('importa el comprobante', r.imported === 1, r);

  const mov = db
    .prepare("SELECT * FROM transactions WHERE household_id = ? AND type = 'aporte'")
    .get(hogar) as any;
  ok('queda registrado como aporte', mov?.type === 'aporte', mov?.type);
  ok('por $14.000', mov?.amount === 14000, mov?.amount);
  ok('a nombre de Francisco, no de nadie', mov?.user_id === francisco, mov?.user_id);

  const liq = computeSettlement(hogar, MES);
  const suyo = liq.members.find((m) => m.userId === francisco);
  const deElla = liq.members.find((m) => m.userId === pareja);

  ok('la liquidación le cuenta los $14.000 a Francisco', suyo?.transferred === 14000, suyo);
  ok('y no se los cuenta a la otra persona', deElla?.transferred === 0, deElla);
  ok('el saldo de la cuenta del hogar refleja el abono',
     liq.officialAccountBalance === 14000, liq.officialAccountBalance);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

void main().catch((e) => { console.error('La prueba se cayó:', e.message); process.exit(1); });

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

/*
 * Las reglas se activan tal como vienen sembradas, sin tocarles los patrones.
 *
 * Es a propósito: antes esta prueba pisaba `must_contain` con un valor propio,
 * así que las plantillas de verdad —las que usa un hogar recién creado— no las
 * ejercitaba nadie de punta a punta. Lo único que se ajusta es de quién es el
 * aporte, que es una decisión del hogar y no puede venir en una plantilla.
 */
db.prepare(
  `UPDATE email_rules SET enabled = 1, user_id = ?
    WHERE household_id = ? AND template_key = 'bancochile_transferencia_recibida'`,
).run(francisco, hogar);

/*
 * Y también la de transferencias enviadas, que comparte búsqueda con la
 * anterior. Tenerlas las dos activas es el caso normal —de un banco entra y
 * sale plata— y es justo el que se rompía: la primera regla bajaba el correo,
 * lo descartaba por un filtro de texto y lo dejaba marcado como visto, así que
 * la segunda no lo veía nunca.
 */
db.prepare(
  `UPDATE email_rules SET enabled = 1
    WHERE household_id = ? AND template_key = 'bancochile_transferencia_enviada'`,
).run(hogar);

const activadas = db
  .prepare('SELECT COUNT(*) AS n FROM email_rules WHERE household_id = ? AND enabled = 1')
  .get(hogar) as { n: number };
ok('las dos plantillas existen y quedaron activas', activadas.n === 2, activadas);

const conPatron = db
  .prepare(
    `SELECT period_regex AS pr FROM email_rules
      WHERE household_id = ? AND template_key = 'bancochile_transferencia_recibida'`,
  )
  .get(hogar) as { pr: string | null };
ok('la regla sembrada trae el patrón del mes', Boolean(conPatron.pr), conPatron.pr);

db.prepare(
  `INSERT INTO imap_accounts (id, household_id, user_id, email, secreto, host, port, carpeta)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(uid(), hogar, francisco, 'testuser', cifrar('testpass'), 'localhost', 9993, 'INBOX');

async function main() {
  const r = await sincronizarImap(hogar, 100, false);
  ok('importa los dos comprobantes', r.imported === 2, r);

  const mov = db
    .prepare("SELECT * FROM transactions WHERE household_id = ? AND type = 'aporte'")
    .get(hogar) as any;
  ok('queda registrado como aporte', mov?.type === 'aporte', mov?.type);
  ok('por $14.000', mov?.amount === 14000, mov?.amount);
  ok('a nombre de Francisco, no de nadie', mov?.user_id === francisco, mov?.user_id);
  ok('con la fecha del comprobante', mov?.occurred_on === '2026-08-18', mov?.occurred_on);
  // El correo dice "Mensualidad septiembre": esa plata es de septiembre aunque
  // se haya transferido en agosto.
  ok('pero contando en septiembre, por el comentario', mov?.period === '2026-09', mov?.period);

  /*
   * El correo de la transferencia enviada.
   *
   * La regla de "recibida" lo descarta —dice "Transferencia a terceros"— y la
   * de "enviada" lo toma. Que llegue acá es la prueba de que descartarlo no lo
   * pierde para las reglas siguientes.
   */
  const salida = db
    .prepare("SELECT * FROM transactions WHERE household_id = ? AND type = 'gasto'")
    .get(hogar) as any;
  ok('la transferencia enviada no se pierde al descartarla la primera regla',
     salida != null, salida);
  ok('y entra como gasto de $25.000', salida?.amount === 25000, salida?.amount);

  const aportes = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE household_id = ? AND type = 'aporte'")
    .get(hogar) as { n: number };
  ok('el aporte entra una sola vez, no dos', aportes.n === 1, aportes);

  /*
   * El aporte cuenta en el mes que dice el correo, no en el de la fecha.
   *
   * Se transfirió el 18 de agosto con el comentario "Mensualidad septiembre",
   * así que en agosto no aparece y en septiembre sí. Es el comportamiento que
   * se buscaba: los sueldos no llegan a fin de mes exacto y la plata de
   * septiembre suele moverse en agosto.
   */
  const agosto = computeSettlement(hogar, MES);
  const enAgosto = agosto.members.find((m) => m.userId === francisco);
  ok('en agosto el aporte todavía no cuenta', enAgosto?.transferred === 0, enAgosto);

  const septiembre = computeSettlement(hogar, '2026-09');
  const suyo = septiembre.members.find((m) => m.userId === francisco);
  const deElla = septiembre.members.find((m) => m.userId === pareja);

  ok('la liquidación de septiembre le cuenta los $14.000 a Francisco',
     suyo?.transferred === 14000, suyo);
  ok('y no se los cuenta a la otra persona', deElla?.transferred === 0, deElla);
  ok('el saldo de la cuenta del hogar refleja el abono',
     septiembre.officialAccountBalance === 14000, septiembre.officialAccountBalance);

  // Y el gasto sí es de agosto: su correo no dice ningún mes.
  ok('el gasto se queda en agosto', salida?.period === '2026-08', salida?.period);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

void main().catch((e) => { console.error('La prueba se cayó:', e.message); process.exit(1); });

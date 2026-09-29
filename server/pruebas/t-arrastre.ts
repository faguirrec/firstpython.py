/**
 * Pasar al mes siguiente el saldo con el que cierra un mes.
 *
 * El caso: el mes cuadra, los dos transfirieron su parte, y a fin de mes uno
 * tuvo que desembolsar de su bolsillo por una emergencia. Esa plata se reparte
 * proporcionalmente igual que todo lo demás, y el otro le queda debiendo su
 * parte. En vez de transferírsela hoy, se puede arrastrar: el mes que viene
 * ajusta cuánto pone cada uno.
 *
 * Lo delicado no es la suma, es que no se cuente dos veces: el saldo tiene que
 * estar o abierto en su mes o arrastrado al siguiente, nunca en los dos.
 */
import { db, uid } from '../src/lib/db.js';
import {
  computeReserve,
  computeSettlement,
  pasarSaldoAlMesSiguiente,
  projectContributions,
  quitarSaldoArrastrado,
  repartoDelExcedente,
} from '../src/services/split.js';
import { computeGoals } from '../src/services/planning.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

const hogar = uid(), ana = uid(), bruno = uid();
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(ana, `a${ana}@x.cl`, 'x', 'Ana');
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(bruno, `b${bruno}@x.cl`, 'x', 'Bruno');
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(hogar, 'Casa', 'CLP');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(hogar, ana, 'owner');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(hogar, bruno, 'member');

const AGOSTO = '2026-08';
const SEPTIEMBRE = '2026-09';
for (const mes of [AGOSTO, SEPTIEMBRE]) {
  db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
    .run(uid(), hogar, ana, mes, 1_500_000);   // 60%
  db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
    .run(uid(), hogar, bruno, mes, 1_000_000); // 40%
}

function mov(mes: string, monto: number, tipo: string, pagador: string, duenio: string | null) {
  db.prepare(
    `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
     VALUES (?,?,?,?,?,?,'comun',?,?,'manual',1)`,
  ).run(uid(), hogar, `${mes}-10`, mes, monto, tipo, pagador, duenio);
}

// --- Agosto: el mes normal, cuadrado ---
mov(AGOSTO, 1_000_000, 'gasto', 'oficial', null);
mov(AGOSTO, 600_000, 'aporte', 'oficial', ana);
mov(AGOSTO, 400_000, 'aporte', 'oficial', bruno);
ok('agosto parte cuadrado',
   computeSettlement(hogar, AGOSTO).members.every((m) => m.deviation === 0));

// --- La emergencia: Bruno desembolsa $300.000 ---
mov(AGOSTO, 300_000, 'gasto', bruno, bruno);
const agosto = computeSettlement(hogar, AGOSTO);
const anaAgo = agosto.members.find((m) => m.userId === ana)!;
const brunoAgo = agosto.members.find((m) => m.userId === bruno)!;

ok('el gasto de emergencia entra al total del mes', agosto.totalSharedExpenses === 1_300_000, agosto.totalSharedExpenses);
ok('y se reparte proporcional: a Ana le toca el 60%', anaAgo.fairShare === 780_000, anaAgo.fairShare);
ok('a Bruno se le acredita lo que puso de su bolsillo', brunoAgo.paidOutOfPocket === 300_000, brunoAgo.paidOutOfPocket);
ok('Ana queda debiendo su parte de la emergencia', anaAgo.deviation === -180_000, anaAgo.deviation);
ok('y Bruno a favor por lo mismo', brunoAgo.deviation === 180_000, brunoAgo.deviation);

// --- Septiembre, antes de arrastrar nada ---
mov(SEPTIEMBRE, 1_000_000, 'gasto', 'oficial', null);
const sinArrastre = computeSettlement(hogar, SEPTIEMBRE).members.find((m) => m.userId === ana)!;
ok('sin arrastrar, septiembre no sabe nada de la deuda',
   sinArrastre.carriedOver === 0 && sinArrastre.deviation === -600_000, sinArrastre);

// --- Se arrastra ---
const r = pasarSaldoAlMesSiguiente(hogar, AGOSTO);
ok('se arrastran los $180.000', r.arrastrado === 180_000, r);
ok('hacia septiembre', r.hacia === SEPTIEMBRE, r.hacia);

const sep = computeSettlement(hogar, SEPTIEMBRE);
const anaSep = sep.members.find((m) => m.userId === ana)!;
const brunoSep = sep.members.find((m) => m.userId === bruno)!;

ok('Ana llega a septiembre debiendo $180.000', anaSep.carriedOver === -180_000, anaSep.carriedOver);
ok('y sabe de qué mes viene', anaSep.carriedFrom === AGOSTO, anaSep.carriedFrom);
ok('Bruno llega con $180.000 a favor', brunoSep.carriedOver === 180_000, brunoSep.carriedOver);

// Lo que le toca del gasto no cambia: el arrastre es entre ellos, no un gasto.
ok('el arrastre NO cambia lo que le toca del gasto del mes',
   anaSep.fairShare === 600_000, anaSep.fairShare);
ok('ni el total de gastos comunes de septiembre',
   sep.totalSharedExpenses === 1_000_000, sep.totalSharedExpenses);
ok('pero sí su saldo: 600.000 que le tocan más 180.000 que debía',
   anaSep.deviation === -780_000, anaSep.deviation);
ok('lo arrastrado suma cero entre los dos',
   anaSep.carriedOver + brunoSep.carriedOver === 0);

// --- La proyección del mes también lo tiene que ver ---
const proy = projectContributions(hogar, SEPTIEMBRE, 1_000_000, 0);
const anaProy = proy.rows.find((r2) => r2.userId === ana)!;
const brunoProy = proy.rows.find((r2) => r2.userId === bruno)!;
ok('a Ana le toca transferir su parte más lo que debía',
   anaProy.pending === 780_000, anaProy);
ok('y a Bruno su parte menos lo que tenía a favor',
   brunoProy.pending === 220_000, brunoProy);

// --- No se cuenta dos veces ---
ok('agosto sigue mostrando su saldo, no lo pierde',
   computeSettlement(hogar, AGOSTO).members.find((m) => m.userId === ana)!.deviation === -180_000);

// Cerrar dos veces no duplica.
pasarSaldoAlMesSiguiente(hogar, AGOSTO);
const dosVeces = computeSettlement(hogar, SEPTIEMBRE).members.find((m) => m.userId === ana)!;
ok('arrastrar dos veces el mismo mes no duplica la deuda',
   dosVeces.carriedOver === -180_000, dosVeces.carriedOver);

// --- Reabrir el mes lo deshace ---
quitarSaldoArrastrado(hogar, AGOSTO);
const tras = computeSettlement(hogar, SEPTIEMBRE).members.find((m) => m.userId === ana)!;
ok('reabrir agosto quita el arrastre de septiembre', tras.carriedOver === 0, tras.carriedOver);
ok('y septiembre vuelve a su saldo propio', tras.deviation === -600_000, tras.deviation);

// --- Saldar de verdad en septiembre ---
pasarSaldoAlMesSiguiente(hogar, AGOSTO);
mov(SEPTIEMBRE, 780_000, 'aporte', 'oficial', ana);
mov(SEPTIEMBRE, 220_000, 'aporte', 'oficial', bruno);
const cerrado = computeSettlement(hogar, SEPTIEMBRE);
ok('poniendo lo que dice la proyección, septiembre queda a cero',
   cerrado.members.every((m) => Math.abs(m.deviation) < 1),
   cerrado.members.map((m) => `${m.name}:${m.deviation}`));

// --- Cuando el hogar puso más de lo que gastó ---
/**
 * La desviación de cada uno mezcla dos cosas: lo que le debe al otro y lo que
 * al hogar le sobró en la cuenta. Las dos viajan, y por eso los arrastres suman
 * cero sólo si el mes cerró financiado justo. Con excedente el mes siguiente
 * pide menos, que es lo correcto: esa plata ya está en la cuenta.
 */
const conSobra = uid();
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(conSobra, 'Sobra', 'CLP');
for (const [u, sueldo] of [[ana, 1_500_000], [bruno, 1_000_000]] as [string, number][]) {
  db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(conSobra, u, 'member');
  db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
    .run(uid(), conSobra, u, AGOSTO, sueldo);
}
function movEn(hogarId: string, monto: number, tipo: string, pagador: string, duenio: string | null) {
  db.prepare(
    `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
     VALUES (?,?,?,?,?,?,'comun',?,?,'manual',1)`,
  ).run(uid(), hogarId, `${AGOSTO}-10`, AGOSTO, monto, tipo, pagador, duenio);
}
movEn(conSobra, 1_000_000, 'gasto', 'oficial', null);
movEn(conSobra, 700_000, 'aporte', 'oficial', ana);   // le tocaban 600.000
movEn(conSobra, 400_000, 'aporte', 'oficial', bruno); // le tocaban 400.000
// Por defecto, el excedente se queda en el hogar hasta el tope de ahorro. Acá
// el tope (10% de $1.000.000) cubre los $100.000 enteros.
const sobra = pasarSaldoAlMesSiguiente(conSobra, AGOSTO);
ok('por defecto el excedente se ahorra hasta el tope', sobra.ahorrado === 100_000, sobra);
ok('y entonces no vuelve como crédito',
   computeSettlement(conSobra, SEPTIEMBRE).members.every((m) => m.carriedOver === 0));
ok('nadie quedó debiendo, así que no se arrastra deuda', sobra.arrastrado === 0, sobra);

// Pidiendo ahorrar cero, el excedente vuelve entero a quien lo puso.
pasarSaldoAlMesSiguiente(conSobra, AGOSTO, 'CLP', 0);
const haciaSep = computeSettlement(conSobra, SEPTIEMBRE).members;
const suma = haciaSep.reduce((a, m) => a + m.carriedOver, 0);
ok('sin ahorrar nada, el arrastre no suma cero: queda el excedente', suma === 100_000, suma);
ok('y el que puso de más llega con eso a favor',
   haciaSep.find((m) => m.userId === ana)!.carriedOver === 100_000);
ok('el que puso justo no arrastra nada',
   haciaSep.find((m) => m.userId === bruno)!.carriedOver === 0);

// --- Encadenar: agosto → septiembre → octubre ---
/**
 * Si el saldo se arrastra otra vez sin haberse saldado, tiene que moverse
 * entero hacia adelante, no duplicarse ni perderse por el camino.
 */
const cadena = uid();
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(cadena, 'Cadena', 'CLP');
for (const [u, sueldo] of [[ana, 1_500_000], [bruno, 1_000_000]] as [string, number][]) {
  db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(cadena, u, 'member');
  for (const mes of [AGOSTO, SEPTIEMBRE, '2026-10']) {
    db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
      .run(uid(), cadena, u, mes, sueldo);
  }
}
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'gasto','comun',?,?,'manual',1)`,
).run(uid(), cadena, `${AGOSTO}-10`, AGOSTO, 100_000, bruno, bruno);
// Bruno pagó los 100.000; a Ana le tocaban 60.000.
pasarSaldoAlMesSiguiente(cadena, AGOSTO);
ok('tras agosto, Ana debe 60.000 en septiembre',
   computeSettlement(cadena, SEPTIEMBRE).members.find((m) => m.userId === ana)!.carriedOver === -60_000);
// Septiembre pasa sin gastos ni aportes: la deuda sigue igual y se arrastra otra vez.
pasarSaldoAlMesSiguiente(cadena, SEPTIEMBRE);
const oct = computeSettlement(cadena, '2026-10').members;
ok('y en octubre sigue siendo la misma deuda, no el doble',
   oct.find((m) => m.userId === ana)!.carriedOver === -60_000,
   oct.map((m) => `${m.name}:${m.carriedOver}`));
ok('con el crédito de Bruno intacto',
   oct.find((m) => m.userId === bruno)!.carriedOver === 60_000);
ok('septiembre ya no la muestra: se movió, no se copió',
   computeSettlement(cadena, SEPTIEMBRE).members.find((m) => m.userId === ana)!.carriedOver === -60_000);

// Un desbalance de céntimos no se arrastra: sería una línea de un peso.
const chico = uid();
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(chico, 'Redondeo', 'CLP');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(chico, ana, 'owner');
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'gasto','comun','oficial',NULL,'manual',1)`,
).run(uid(), chico, `${AGOSTO}-10`, AGOSTO, 0.4);
const nada = pasarSaldoAlMesSiguiente(chico, AGOSTO);
ok('un desbalance de céntimos no se arrastra', nada.arrastrado === 0, nada);

/* ------------------- Qué pasa con lo que sobra en la cuenta --------------- */

/**
 * Cuando un mes cierra con plata de más en la cuenta, esa plata tiene dos
 * dueños posibles: el hogar —que la ahorra— o quien la puso —que la recibe de
 * vuelta como crédito—. Antes no había regla y quedaba prometida a los dos a la
 * vez: al fondo de reserva, a las metas de ahorro y al crédito del mes
 * siguiente, todo con los mismos pesos.
 */
const exc = uid();
db.prepare('INSERT INTO households (id,name,currency,savings_pct) VALUES (?,?,?,?)').run(exc, 'Excedente', 'CLP', 10);
for (const [u, sueldo] of [[ana, 1_500_000], [bruno, 1_000_000]] as [string, number][]) {
  db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(exc, u, 'member');
  for (const mes of [AGOSTO, SEPTIEMBRE]) {
    db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
      .run(uid(), exc, u, mes, sueldo);
  }
}
function movExc(monto: number, tipo: string, quien: string | null) {
  db.prepare(
    `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
     VALUES (?,?,?,?,?,?,'comun','oficial',?,'manual',1)`,
  ).run(uid(), exc, `${AGOSTO}-10`, AGOSTO, monto, tipo, quien);
}
movExc(1_000_000, 'gasto', null);
movExc(700_000, 'aporte', ana);   // le tocaban 600.000: pone 100.000 de más
movExc(400_000, 'aporte', bruno); // justo

const reparto = repartoDelExcedente(exc, AGOSTO);
ok('el excedente del mes es la suma de las desviaciones', reparto.excedente === 100_000, reparto.excedente);
ok('el tope de ahorro es el 10% del gasto del mes', reparto.tope === 100_000, reparto.tope);
ok('con ese tope, todo el excedente se sugiere ahorrar',
   reparto.sugeridoAlAhorro === 100_000 && reparto.sugeridoComoCredito === 0, reparto);

// Con un tope más chico, parte vuelve como crédito.
db.prepare('UPDATE households SET savings_pct = 3 WHERE id = ?').run(exc);
const parcial = repartoDelExcedente(exc, AGOSTO);
ok('con tope del 3%, se ahorran $30.000', parcial.sugeridoAlAhorro === 30_000, parcial.sugeridoAlAhorro);
ok('y $70.000 vuelven como crédito', parcial.sugeridoComoCredito === 70_000, parcial.sugeridoComoCredito);
ok('el crédito va entero a quien puso de más',
   parcial.creditos.length === 1 && parcial.creditos[0].userId === ana && parcial.creditos[0].amount === 70_000,
   parcial.creditos);

// Al cerrar, el arrastre respeta el reparto.
const cierre = pasarSaldoAlMesSiguiente(exc, AGOSTO, 'CLP', 30_000);
ok('el cierre informa lo ahorrado', cierre.ahorrado === 30_000, cierre);
const sepExc = computeSettlement(exc, SEPTIEMBRE).members;
ok('Ana llega a septiembre con $70.000 a favor, no $100.000',
   sepExc.find((m) => m.userId === ana)!.carriedOver === 70_000,
   sepExc.find((m) => m.userId === ana)!.carriedOver);
ok('Bruno no arrastra nada', sepExc.find((m) => m.userId === bruno)!.carriedOver === 0);

// --- Y la plata deja de estar prometida dos veces ---
const res = computeReserve(exc);
ok('el fondo tiene los $100.000 en la cuenta', res.balance === 100_000, res.balance);
ok('pero $70.000 están prometidos como crédito', res.committed === 70_000, res.committed);
ok('así que libre para metas quedan $30.000', res.free === 30_000, res.free);

db.prepare('INSERT INTO savings_goals (id,household_id,name,target_amount,priority) VALUES (?,?,?,?,?)')
  .run(uid(), exc, 'Vacaciones', 500_000, 1);
ok('la meta se financia sólo con lo libre, no con lo que hay que devolver',
   computeGoals(exc).goals[0].funded === 30_000, computeGoals(exc).goals[0].funded);

// --- No se puede ahorrar más de lo que hay ---
const pasado = pasarSaldoAlMesSiguiente(exc, AGOSTO, 'CLP', 999_999);
ok('pedir ahorrar más que el excedente se recorta al excedente',
   pasado.ahorrado === 100_000, pasado.ahorrado);
ok('y entonces no queda crédito para nadie',
   computeSettlement(exc, SEPTIEMBRE).members.every((m) => m.carriedOver === 0));

// --- Una deuda no se toca por ahorrar ---
/**
 * Lo que el hogar decida ahorrar no puede cambiarle el saldo a quien puso de
 * menos: el recorte cae sólo sobre los créditos.
 */
const conDeuda = uid();
db.prepare('INSERT INTO households (id,name,currency,savings_pct) VALUES (?,?,?,?)').run(conDeuda, 'Deuda', 'CLP', 10);
for (const [u, sueldo] of [[ana, 1_500_000], [bruno, 1_000_000]] as [string, number][]) {
  db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(conDeuda, u, 'member');
  db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)')
    .run(uid(), conDeuda, u, AGOSTO, sueldo);
}
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'gasto','comun','oficial',NULL,'manual',1)`,
).run(uid(), conDeuda, `${AGOSTO}-10`, AGOSTO, 1_000_000);
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'aporte','comun','oficial',?,'manual',1)`,
).run(uid(), conDeuda, `${AGOSTO}-10`, AGOSTO, 800_000, ana);   // le tocaban 600.000
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'aporte','comun','oficial',?,'manual',1)`,
).run(uid(), conDeuda, `${AGOSTO}-10`, AGOSTO, 300_000, bruno); // le tocaban 400.000
// Excedente: 1.100.000 - 1.000.000 = 100.000. Ana +200.000, Bruno -100.000.
pasarSaldoAlMesSiguiente(conDeuda, AGOSTO, 'CLP', 100_000);
const conD = computeSettlement(conDeuda, SEPTIEMBRE).members;
ok('la deuda de Bruno sigue intacta después de ahorrar',
   conD.find((m) => m.userId === bruno)!.carriedOver === -100_000,
   conD.find((m) => m.userId === bruno)!.carriedOver);
ok('y el crédito de Ana baja en lo ahorrado',
   conD.find((m) => m.userId === ana)!.carriedOver === 100_000,
   conD.find((m) => m.userId === ana)!.carriedOver);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

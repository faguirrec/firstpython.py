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
  computeSettlement,
  pasarSaldoAlMesSiguiente,
  projectContributions,
  quitarSaldoArrastrado,
} from '../src/services/split.js';

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
const sobra = pasarSaldoAlMesSiguiente(conSobra, AGOSTO);
const haciaSep = computeSettlement(conSobra, SEPTIEMBRE).members;
const suma = haciaSep.reduce((a, m) => a + m.carriedOver, 0);
ok('con excedente en la cuenta, el arrastre no suma cero', suma === 100_000, suma);
ok('y el que puso de más llega con eso a favor',
   haciaSep.find((m) => m.userId === ana)!.carriedOver === 100_000);
ok('el que puso justo no arrastra nada',
   haciaSep.find((m) => m.userId === bruno)!.carriedOver === 0);
ok('nadie quedó debiendo, así que no se arrastra deuda', sobra.arrastrado === 0, sobra);

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

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

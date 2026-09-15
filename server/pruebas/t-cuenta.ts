/**
 * El saldo de la cuenta del hogar: lo que debería haber en el banco.
 *
 * Es el número con el que uno cuadra contra la cartola, así que tiene que
 * contar **todo** lo que entra y sale de esa cuenta. El caso que se escapaba:
 * alguien compra algo suyo con la tarjeta de la casa. Esa plata sale del banco
 * igual, y además es plata del pozo común que esa persona se llevó.
 */
import { db, uid } from '../src/lib/db.js';
import { computeReserve, computeSettlement } from '../src/services/split.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

const hogar = uid(), ana = uid(), bruno = uid();
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(ana, `a${ana}@x.cl`, 'x', 'Ana');
db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(bruno, `b${bruno}@x.cl`, 'x', 'Bruno');
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(hogar, 'Casa', 'CLP');
for (const u of [ana, bruno]) {
  db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(hogar, u, 'member');
}
const M = '2026-08';
db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)').run(uid(), hogar, ana, M, 1_500_000);
db.prepare('INSERT INTO incomes (id,household_id,user_id,month,amount) VALUES (?,?,?,?,?)').run(uid(), hogar, bruno, M, 1_000_000);

function mov(monto: number, tipo: string, scope: string, funded: string, duenio: string | null) {
  db.prepare(
    `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
     VALUES (?,?,?,?,?,?,?,?,?,'manual',1)`,
  ).run(uid(), hogar, `${M}-10`, M, monto, tipo, scope, funded, duenio);
}

mov(600_000, 'aporte', 'comun', 'oficial', ana);
mov(400_000, 'aporte', 'comun', 'oficial', bruno);
mov(300_000, 'gasto', 'comun', 'oficial', null);      // sale de la cuenta
mov(200_000, 'gasto', 'personal', 'oficial', ana);    // sale de la cuenta también
mov(150_000, 'gasto', 'comun', bruno, bruno);         // NO sale: de su bolsillo

// Banco: 1.000.000 entró, 500.000 salió.
ok('el saldo cuenta lo personal pagado con la cuenta del hogar',
   computeReserve(hogar).balance === 500_000, computeReserve(hogar).balance);

const s = computeSettlement(hogar, M, 'CLP', ana);
const a = s.members.find((m) => m.userId === ana)!;
const b = s.members.find((m) => m.userId === bruno)!;

ok('el gasto personal no entra a los gastos comunes del hogar',
   s.totalSharedExpenses === 450_000, s.totalSharedExpenses);
ok('a Ana se le anota lo que sacó del pozo para ella',
   a.personalFromAccount === 200_000, a.personalFromAccount);
ok('y se le descuenta de lo que puso: 600.000 − 200.000',
   a.contributed === 400_000, a.contributed);
ok('a Bruno se le acredita lo de su bolsillo: 400.000 + 150.000',
   b.contributed === 550_000, b.contributed);
ok('Bruno no sacó nada para él', b.personalFromAccount === 0);

// La identidad que sostiene el reparto del excedente.
const suma = s.members.reduce((acc, m) => acc + m.deviation, 0);
ok('la suma de las desviaciones sigue siendo el saldo del mes',
   Math.abs(suma - s.officialAccountBalance) < 0.01,
   { suma, saldo: s.officialAccountBalance });

// Y sin gastos personales el resultado no cambia respecto de antes.
const limpio = uid();
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(limpio, 'Limpio', 'CLP');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(limpio, ana, 'member');
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'aporte','comun','oficial',?,'manual',1)`,
).run(uid(), limpio, `${M}-10`, M, 500_000, ana);
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'gasto','comun','oficial',NULL,'manual',1)`,
).run(uid(), limpio, `${M}-10`, M, 300_000);
ok('un hogar sin gastos personales cuadra igual que siempre',
   computeReserve(limpio).balance === 200_000, computeReserve(limpio).balance);

/* --------------------------- Cuadrar con el banco ------------------------- */

/**
 * La app suma desde cero el día que el hogar empieza a usarla. Si la cuenta ya
 * tenía plata, el número queda corrido para siempre y hasta ahora no había
 * dónde decirlo.
 */
const conAjuste = uid();
db.prepare('INSERT INTO households (id,name,currency) VALUES (?,?,?)').run(conAjuste, 'Con historia', 'CLP');
db.prepare('INSERT INTO household_members (household_id,user_id,role) VALUES (?,?,?)').run(conAjuste, ana, 'member');
db.prepare(
  `INSERT INTO transactions (id,household_id,occurred_on,period,amount,type,scope,funded_by,user_id,source,reviewed)
   VALUES (?,?,?,?,?,'aporte','comun','oficial',?,'manual',1)`,
).run(uid(), conAjuste, `${M}-10`, M, 50_000, ana);

ok('sin ajuste, el saldo es sólo lo que la app vio',
   computeReserve(conAjuste).balance === 50_000, computeReserve(conAjuste).balance);

// El banco dice 131.000: había 81.000 antes de empezar.
db.prepare(
  `UPDATE households SET balance_adjustment = balance_adjustment + ?, balance_adjusted_at = datetime('now')
    WHERE id = ?`,
).run(131_000 - computeReserve(conAjuste).balance, conAjuste);

const cuadrado = computeReserve(conAjuste);
ok('tras cuadrar, el saldo es el del banco', cuadrado.balance === 131_000, cuadrado.balance);
ok('y queda anotado cuánto se ajustó', cuadrado.adjustment === 81_000, cuadrado.adjustment);
ok('con la fecha del cuadre', Boolean(cuadrado.adjustedAt), cuadrado.adjustedAt);
ok('la última fila del histórico coincide con el saldo',
   cuadrado.history[cuadrado.history.length - 1].balance === 131_000,
   cuadrado.history.map((h) => `${h.month}:${h.balance}`));

// El ajuste es del hogar, no de nadie: no puede aparecer en la liquidación.
const liq = computeSettlement(conAjuste, M);
ok('el ajuste no le cuenta a nadie como aporte',
   liq.members.every((m) => m.transferred === 50_000 || m.transferred === 0),
   liq.members.map((m) => `${m.name}:${m.transferred}`));

// Cuadrar de nuevo suma sobre lo anterior, no lo pisa.
db.prepare(
  `UPDATE households SET balance_adjustment = balance_adjustment + ? WHERE id = ?`,
).run(140_000 - computeReserve(conAjuste).balance, conAjuste);
ok('cuadrar dos veces no borra el ajuste anterior',
   computeReserve(conAjuste).balance === 140_000 && computeReserve(conAjuste).adjustment === 90_000,
   computeReserve(conAjuste));

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

/**
 * Reconocer los gastos fijos en los movimientos que ya hay.
 *
 * Lo que se prueba no es que encuentre cosas —eso es fácil— sino que **no**
 * proponga las que no son. Una lista con el supermercado y la bencina adentro
 * hay que revisarla entera, y revisar es justo el trabajo que se quería
 * ahorrar: sale más barato escribir cuatro cuentas a mano que auditar catorce
 * propuestas.
 */
import { db, uid } from '../src/lib/db.js';
import { detectarFijos, fechaRegular, crearGastoFijo } from '../src/services/gastosFijos.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

const hogar = uid();
db.prepare('INSERT INTO households (id, name, currency) VALUES (?, ?, ?)').run(hogar, 'Casa', 'CLP');

const categoria = uid();
db.prepare('INSERT INTO categories (id, household_id, name, color, emoji) VALUES (?, ?, ?, ?, ?)')
  .run(categoria, hogar, 'Cuentas', '#888888', '💡');

const MESES = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

function gasto(mes: string, dia: number, comercio: string, monto: number) {
  db.prepare(
    `INSERT INTO transactions (id, household_id, occurred_on, period, amount, type, scope, funded_by,
                               category_id, merchant, source, reviewed)
     VALUES (?, ?, ?, ?, ?, 'gasto', 'comun', 'oficial', ?, ?, 'manual', 1)`,
  ).run(uid(), hogar, `${mes}-${String(dia).padStart(2, '0')}`, mes, monto, categoria, comercio);
}

// --- Lo que SÍ es fijo ---
// Arriendo: mismo día, mismo monto.
MESES.forEach((m) => gasto(m, 5, 'Inmobiliaria Los Robles', 715_000));
// Luz: mismo día, monto que cambia con la estación. La app no debería inventar
// una cifra, pero sí reconocerlo.
[38_000, 41_000, 62_000, 71_000, 45_000].forEach((monto, i) => gasto(MESES[i], 9, 'Enel', monto));
// Una cuenta de fin de mes, que salta entre el 30 y el 2 del siguiente.
[30, 1, 31, 2, 29].forEach((dia, i) => gasto(MESES[i], dia, 'Seguro Hogar', 24_990));

// --- Lo que NO es fijo ---
// Supermercado: cuatro veces al mes.
MESES.forEach((m) => [3, 11, 19, 27].forEach((d) => gasto(m, d, 'Jumbo', 45_000)));
// Bencina: una vez al mes, pero cualquier día.
[2, 17, 8, 26, 13].forEach((dia, i) => gasto(MESES[i], dia, 'Copec', 40_000));
// Algo que pasó una sola vez.
gasto('2026-06', 14, 'Sodimac', 120_000);

const detectados = detectarFijos(hogar);
const nombres = detectados.map((d) => d.name);

ok('reconoce el arriendo', nombres.includes('Inmobiliaria Los Robles'), nombres);
ok('reconoce la luz', nombres.includes('Enel'), nombres);
ok('reconoce la cuenta que cae a fin de mes', nombres.includes('Seguro Hogar'), nombres);

ok('NO propone el supermercado, que es varias veces al mes',
   !nombres.includes('Jumbo'), nombres);
ok('NO propone la bencina, que cae cualquier día',
   !nombres.includes('Copec'), nombres);
ok('NO propone lo que pasó una sola vez', !nombres.includes('Sodimac'), nombres);
ok('y no propone nada más', detectados.length === 3, nombres);

const arriendo = detectados.find((d) => d.name === 'Inmobiliaria Los Robles');
ok('el arriendo trae su monto', arriendo?.amount === 715_000, arriendo?.amount);
ok('con el día de pago', arriendo?.dueDay === 5, arriendo?.dueDay);
ok('y su categoría', arriendo?.categoryName === 'Cuentas', arriendo?.categoryName);
ok('lo vio en los 5 meses', arriendo?.meses === 5, arriendo?.meses);

const luz = detectados.find((d) => d.name === 'Enel');
// De $38.000 a $71.000 no hay "un monto": decir uno sonaría igual de seguro
// que el del arriendo y no lo es.
ok('la luz no trae monto, porque varía demasiado', luz?.amount === null, luz?.amount);

// --- Lo ya declarado no se vuelve a proponer ---
crearGastoFijo(hogar, { name: 'Inmobiliaria Los Robles', amount: 715_000, matchText: 'Inmobiliaria Los Robles' });
const segunda = detectarFijos(hogar).map((d) => d.name);
ok('lo que ya está declarado desaparece de las propuestas',
   !segunda.includes('Inmobiliaria Los Robles'), segunda);
ok('y el resto sigue estando', segunda.length === 2, segunda);

// --- fechaRegular, el criterio por separado ---
ok('cinco pagos el mismo día son regulares', fechaRegular([5, 5, 5, 5, 5]));
ok('con un par de días de diferencia también', fechaRegular([4, 6, 5, 7, 5]));
ok('repartidos por todo el mes, no', !fechaRegular([2, 17, 8, 26, 13]));
ok('a fin de mes, cruzando el cambio de mes, sí', fechaRegular([30, 1, 31, 2, 29]));
ok('un solo dato no alcanza para descartar', fechaRegular([12]));

// --- Un hogar sin historia no inventa nada ---
const nuevo = uid();
db.prepare('INSERT INTO households (id, name, currency) VALUES (?, ?, ?)').run(nuevo, 'Recién', 'CLP');
ok('un hogar sin movimientos no propone nada', detectarFijos(nuevo).length === 0);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

/**
 * El plan del mes.
 *
 * La promesa entera de esta pieza es que **planear no es gastar**. Un plan dice
 * lo que se espera; mientras nadie pague, el saldo de la cuenta no se mueve y el
 * reparto no le cobra un peso a nadie. Si eso se rompe, la app le cobra a una
 * persona plata que no se gastó, que es el peor error posible acá.
 *
 * Lo demás que se verifica es lo que hace que la lista sirva:
 *
 *  - Armar octubre con lo de septiembre no cuenta dos veces la cuenta de la luz
 *    que ya está declarada como gasto fijo.
 *  - Lo específico gana sobre lo general: el cargo que paga una cuenta declarada
 *    no se lo puede comer el renglón de "Supermercado".
 *  - Un renglón acumulado no se da por cumplido con la primera compra del mes.
 *  - Editar octubre no toca la plantilla ni septiembre.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4189;
const BASE = `http://localhost:${PUERTO}/api`;

let fallas = 0;
function ok(n: string, c: boolean, d?: unknown) {
  console.log(`${c ? '  ok' : 'FALLA'}  ${n}`);
  if (!c) { fallas += 1; if (d !== undefined) console.log('        ', d); }
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sesion {
  cookie = '';
  async pedir(metodo: string, ruta: string, cuerpo?: unknown): Promise<any> {
    const r = await fetch(BASE + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const t = await r.text();
    try { return { estado: r.status, cuerpo: JSON.parse(t) }; } catch { return { estado: r.status, cuerpo: t }; }
  }
}

const SEP = '2026-09';
const OCT = '2026-10';

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'a@plan.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });

  const cats = (await s.pedir('GET', '/settings/categories')).cuerpo.categories as any[];
  const cat = (n: string) => cats.find((c) => c.name.toLowerCase().includes(n))?.id as string;
  const arriendo = cat('arriend');
  const cuentas = cat('cuentas');
  const super_ = cat('super');

  const gasto = (mes: string, monto: number, categoria: string, comercio: string, dia = 10) =>
    s.pedir('POST', '/transactions', {
      occurredOn: `${mes}-${String(dia).padStart(2, '0')}`,
      amount: monto, type: 'gasto', scope: 'comun', fundedBy: 'oficial',
      categoryId: categoria, merchant: comercio,
    });

  // ─────────────────────────── septiembre, que ya pasó
  await gasto(SEP, 620_000, arriendo, 'Arriendo', 5);
  await gasto(SEP, 46_800, cuentas, 'Enel', 12);
  await gasto(SEP, 31_200, cuentas, 'Aguas Andinas', 14);
  await gasto(SEP, 198_200, super_, 'Jumbo', 4);
  await gasto(SEP, 87_400, super_, 'Lider', 19);

  // Dos gastos fijos declarados: la plantilla.
  await s.pedir('POST', '/finance/fixed', { name: 'Arriendo', amount: 620_000, categoryId: arriendo, dueDay: 5 });
  await s.pedir('POST', '/finance/fixed', { name: 'Luz', categoryId: cuentas, dueDay: 12, matchText: 'enel' });

  // ─────────────────────────── octubre está en blanco
  const vacio = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('octubre empieza sin plan', vacio.hayPlan === false && vacio.items.length === 0, vacio);

  // ─────────────────────────── armarlo con lo de septiembre
  const armado = (await s.pedir('POST', '/finance/plan/armar', { month: OCT })).cuerpo;
  const plan = armado.plan;
  // Por nombre exacto: "Cuentas (luz, agua, gas)" también contiene "luz" y
  // buscar por pedazo devolvía la categoría en vez del gasto fijo.
  const porNombre = (n: string) => plan.items.find((i: any) => i.name === n);
  ok('armar octubre sale de septiembre', armado.desde === SEP, armado.desde);
  ok('trae los gastos fijos declarados',
     porNombre('Arriendo')?.origin === 'fijo' && porNombre('Luz')?.origin === 'fijo', plan.items);
  ok('y el supermercado como renglón de categoría, con el total del mes pasado',
     porNombre('Supermercado')?.origin === 'anterior' && porNombre('Supermercado')?.expected === 285_600,
     porNombre('Supermercado'));
  ok('el supermercado se acumula; el arriendo se paga de una',
     porNombre('Supermercado')?.modo === 'acumulado' && porNombre('Arriendo')?.modo === 'puntual');

  // La luz declarada cubre parte de "Cuentas"; el agua es lo que sobra.
  const resto = plan.items.find((i: any) => i.categoryId === cuentas && i.origin === 'anterior');
  ok('lo que los fijos ya cubren no se planea dos veces',
     resto != null && Math.round(resto.expected) === 31_200, resto);

  ok('armar de nuevo no duplica nada', (() => true)());
  const otra = (await s.pedir('POST', '/finance/plan/armar', { month: OCT })).cuerpo;
  ok('  al volver a armar no se crea nada y lo dice',
     otra.creados === 0 && otra.yaEstaban > 0 && otra.plan.items.length === plan.items.length, otra);

  /*
   * La luz no tiene monto declarado, así que se estima. Lo que se estima es lo
   * que calzó con ELLA en los meses anteriores —el cargo de Enel— y no el
   * promedio de "Cuentas", que incluiría también el agua y la dejaría estimada
   * en casi el doble de lo que es.
   */
  ok('un gasto de monto variable se estima con lo suyo, no con su categoría entera',
     porNombre('Luz')?.expected === 46_800 && porNombre('Luz')?.expectedFrom === 'promedio',
     porNombre('Luz'));

  // ─────────── LO IMPORTANTE: planear no es gastar
  const liq = (await s.pedir('GET', `/finance/settlement?month=${OCT}`)).cuerpo;
  ok('un plan NO suma a los gastos comunes del mes', liq.totalSharedExpenses === 0, liq.totalSharedExpenses);
  ok('y NO le cobra nada a nadie en el reparto',
     liq.members.every((m: any) => Math.abs(m.deviation) < 0.5), liq.members);
  const reserva = (await s.pedir('GET', '/finance/reserve')).cuerpo;
  ok('y NO mueve el saldo de la cuenta del hogar',
     reserva.totalSpentFromAccount === 983_600, reserva.totalSpentFromAccount);
  const movs = (await s.pedir('GET', `/transactions?month=${OCT}`)).cuerpo.transactions;
  ok('no se inventó ningún movimiento en octubre', movs.length === 0, movs.length);

  // ─────────────────────────── lo específico gana sobre lo general
  await gasto(OCT, 44_900, cuentas, 'ENEL DISTRIBUCION', 12);
  const conLuz = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  const luz = conLuz.items.find((i: any) => i.name === 'Luz');
  const restoCuentas = conLuz.items.find((i: any) => i.categoryId === cuentas && i.origin === 'anterior');
  ok('el cargo de Enel paga la cuenta declarada', luz?.cumplido === true, luz);
  ok('y NO se lo come el renglón de la misma categoría', restoCuentas?.gastado === 0, restoCuentas);
  ok('la luz pagada vale lo que se pagó de verdad', luz?.expected === 44_900, luz?.expected);

  // ─────────────────────────── un acumulado no se cumple con la primera compra
  await gasto(OCT, 90_000, super_, 'Jumbo', 6);
  const conSuper = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  const sm = conSuper.items.find((i: any) => i.name === 'Supermercado');
  ok('el supermercado lleva lo gastado, no queda cumplido de una',
     sm?.gastado === 90_000 && sm?.cumplido === false && sm?.expected === 285_600, sm);
  ok('y cuenta cuántas compras van', sm?.movimientos === 1, sm?.movimientos);

  await gasto(OCT, 200_000, super_, 'Lider', 22);
  const lleno = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  const sm2 = lleno.items.find((i: any) => i.name === 'Supermercado');
  ok('al pasar lo planeado, recién ahí queda cumplido',
     sm2?.gastado === 290_000 && sm2?.cumplido === true, sm2);

  // ─────────────────────────── editar octubre no toca nada más
  const elArriendo = lleno.items.find((i: any) => i.name === 'Arriendo');
  await s.pedir('PATCH', `/finance/plan/${elArriendo.id}`, { amount: 650_000 });
  const editado = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('subir el arriendo de octubre queda guardado',
     editado.items.find((i: any) => i.name === 'Arriendo')?.expected === 650_000);
  const plantilla = (await s.pedir('GET', `/finance/fixed?month=${OCT}`)).cuerpo;
  ok('pero NO cambia la plantilla de gastos fijos',
     plantilla.all.find((f: any) => f.name === 'Arriendo')?.amount === 620_000,
     plantilla.all.find((f: any) => f.name === 'Arriendo'));
  const sept = (await s.pedir('GET', `/finance/settlement?month=${SEP}`)).cuerpo;
  ok('ni toca septiembre, que ya pasó', sept.totalSharedExpenses === 983_600, sept.totalSharedExpenses);

  // ─────────────────────────── anotar un renglón lo vuelve hecho
  const antes = (await s.pedir('GET', `/transactions?month=${OCT}`)).cuerpo.transactions.length;
  const anotado = await s.pedir('POST', `/finance/plan/${elArriendo.id}/anotar`, {});
  ok('anotar el arriendo crea el movimiento por lo planeado',
     anotado.estado === 201 && anotado.cuerpo.amount === 650_000, anotado.cuerpo);
  const despues = (await s.pedir('GET', `/transactions?month=${OCT}`)).cuerpo.transactions;
  ok('y ahora sí hay un movimiento más', despues.length === antes + 1, [antes, despues.length]);
  ok('que cae en octubre, no en el mes en que uno esté parado',
     despues.find((m: any) => m.id === anotado.cuerpo.id)?.period === OCT);
  const trasAnotar = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('el renglón queda cumplido por el cruce, sin marca aparte',
     trasAnotar.items.find((i: any) => i.name === 'Arriendo')?.cumplido === true);
  const liq2 = (await s.pedir('GET', `/finance/settlement?month=${OCT}`)).cuerpo;
  ok('y AHORA sí entra al reparto, porque la plata salió',
     liq2.totalSharedExpenses === 984_900, liq2.totalSharedExpenses);

  // ─────────────────────────── lo que se gastó y no estaba planeado
  await gasto(OCT, 62_000, cat('mascot'), 'Veterinario', 24);
  const conSuelto = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('el gasto que no estaba en el plan se reporta aparte',
     conSuelto.fueraDelPlan === 62_000, conSuelto.fueraDelPlan);

  // ─────────────────────────── agregar y borrar a mano
  const suelto = await s.pedir('POST', '/finance/plan', {
    month: OCT, name: 'Patente del auto', amount: 180_000, categoryId: cat('transp'), dueDay: 31,
  });
  ok('se puede agregar algo que pasa una sola vez', suelto.estado === 201, suelto.cuerpo?.error);
  const conPatente = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('  y aparece en el plan', conPatente.items.some((i: any) => i.name === 'Patente del auto'));
  await s.pedir('DELETE', `/finance/plan/${suelto.cuerpo.id}`);
  const sinPatente = (await s.pedir('GET', `/finance/plan?month=${OCT}`)).cuerpo;
  ok('  y se puede borrar', !sinPatente.items.some((i: any) => i.name === 'Patente del auto'));

  // ─────────────────────────── noviembre no hereda solo
  const nov = (await s.pedir('GET', '/finance/plan?month=2026-11')).cuerpo;
  ok('noviembre no se arma solo: el plan es un acto explícito', nov.hayPlan === false, nov);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/plan.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

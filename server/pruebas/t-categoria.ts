/**
 * Entrar a una categoría desde el gráfico tiene que mostrar lo mismo que la
 * barra que se tocó.
 *
 * Es la regla que hace útil el gesto y la que es fácil de romper: el desglose
 * del Resumen mira un mes, sólo lo común y sin los gastos fijos, así que si la
 * lista de destino no aplica los tres recortes, el usuario ve un total en el
 * gráfico y otro distinto en la lista. Dos números que no calzan en una app de
 * plata no son un detalle: son la razón para dejar de usarla.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4186;
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
    try { return JSON.parse(t); } catch { return t; }
  }
}

const MES = '2026-09';

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'a@cat.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });

  const cats = (await s.pedir('GET', '/settings/categories')).categories as any[];
  const superm = cats.find((c) => /supermercado/i.test(c.name));
  const arriendo = cats.find((c) => /arriendo/i.test(c.name));
  ok('el hogar nuevo trae las categorías sembradas', Boolean(superm && arriendo), cats.map((c) => c.name));

  const gasto = (amount: number, categoryId: string | null, occurredOn: string, scope = 'comun') =>
    s.pedir('POST', '/transactions', {
      occurredOn, period: MES, amount, type: 'gasto', scope, categoryId,
      merchant: categoryId === superm.id ? 'Jumbo' : 'Varios',
      fundedBy: scope === 'comun' ? 'oficial' : undefined,
    });

  await gasto(30000, superm.id, `${MES}-05`);
  await gasto(46300, superm.id, `${MES}-12`);
  // Uno personal de la misma categoría: no tiene que aparecer en el desglose
  // del hogar ni, por lo tanto, en la lista a la que lleva.
  await gasto(9000, superm.id, `${MES}-13`, 'personal');
  // Y dos sin categoría, que son los que hay que ir a arreglar.
  await gasto(7000, null, `${MES}-06`);
  await gasto(3000, null, `${MES}-07`);

  // ------------------------------------------- el id viaja en el desglose
  const desglose = (await s.pedir('GET', `/finance/reports/by-category?month=${MES}&scope=comun`)).categories as any[];
  const barraSuper = desglose.find((c) => c.category === superm.name);
  const barraSin = desglose.find((c) => c.categoryId === null);
  ok('la barra trae el id para poder abrirla', barraSuper?.categoryId === superm.id, barraSuper);
  ok('y "Sin categoría" viene con id nulo, no inventado', barraSin != null && barraSin.categoryId === null, barraSin);

  // --------------------------------- la lista suma lo mismo que la barra
  const lista = async (q: string) =>
    ((await s.pedir('GET', `/transactions?${q}`)).transactions as any[]);

  const deSuper = await lista(`month=${MES}&scope=comun&categoryId=${superm.id}`);
  const sumaLista = deSuper.reduce((a, b) => a + b.amount, 0);
  ok('el total de la lista calza con el de la barra', sumaLista === barraSuper.total, [sumaLista, barraSuper.total]);
  ok('y son los dos movimientos comunes, sin el personal', deSuper.length === 2, deSuper.length);

  const sinCat = await lista(`month=${MES}&scope=comun&categoryId=sin`);
  ok('`categoria=sin` trae los que no tienen categoría', sinCat.length === 2, sinCat.length);
  ok('y suman lo que dice su barra', sinCat.reduce((a, b) => a + b.amount, 0) === barraSin.total,
     [sinCat.reduce((a, b) => a + b.amount, 0), barraSin.total]);
  ok('ninguno de ellos tiene categoría', sinCat.every((t) => t.categoryId === null), sinCat.map((t) => t.categoryId));

  // ------------------------------------- y el recorte de los gastos fijos
  //
  // El Resumen muestra el desglose sin los fijos. Con el arriendo declarado y
  // pagado, la barra de arriendo desaparece de ese gráfico; la lista pedida con
  // el mismo recorte tiene que quedar igual de vacía.
  const fijo = await s.pedir('POST', '/finance/fixed', {
    name: 'Arriendo', amount: 520000, dueDay: 3, categoryId: arriendo.id,
  });
  ok('el gasto fijo queda creado', Boolean(fijo?.id), fijo);
  // No hay que marcarlo pagado: el gasto fijo se reconoce solo en los
  // movimientos del mes por su categoría.
  await gasto(520000, arriendo.id, `${MES}-03`);
  const estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  ok('y el movimiento del mes lo da por pagado',
     estado.items?.some((i: any) => i.name === 'Arriendo' && i.paid), estado.items);

  const conFijos = (await s.pedir('GET', `/finance/reports/by-category?month=${MES}&scope=comun`)).categories as any[];
  const sinFijos = (await s.pedir(
    'GET', `/finance/reports/by-category?month=${MES}&scope=comun&excluirFijos=1`,
  )).categories as any[];
  const barraArriendoCon = conFijos.find((c) => c.categoryId === arriendo.id);
  const barraArriendoSin = sinFijos.find((c) => c.categoryId === arriendo.id);
  ok('con los fijos dentro, el arriendo aparece en el desglose', barraArriendoCon?.total === 520000, barraArriendoCon);
  ok('y sin ellos, desaparece', barraArriendoSin == null, barraArriendoSin);

  const listaArriendoSinFijos = await lista(`month=${MES}&scope=comun&categoryId=${arriendo.id}&excluirFijos=1`);
  ok('la lista con el mismo recorte también queda vacía', listaArriendoSinFijos.length === 0, listaArriendoSinFijos.length);
  const listaArriendoConFijos = await lista(`month=${MES}&scope=comun&categoryId=${arriendo.id}`);
  ok('y sin el recorte, trae el pago', listaArriendoConFijos.length === 1, listaArriendoConFijos.length);

  // El supermercado no es fijo, así que el recorte no debería tocarlo.
  const superSinFijos = await lista(`month=${MES}&scope=comun&categoryId=${superm.id}&excluirFijos=1`);
  ok('sacar los fijos no se lleva por delante lo que no lo es',
     superSinFijos.length === 2, superSinFijos.length);

  // ------------------------------------------------ todo el historial
  //
  // Análisis muestra el acumulado de todos los meses; al entrar desde ahí no se
  // manda mes y tienen que venir también los de otros meses.
  await s.pedir('POST', '/transactions', {
    occurredOn: '2026-08-20', period: '2026-08', amount: 11000, type: 'gasto',
    scope: 'comun', categoryId: superm.id, merchant: 'Jumbo agosto', fundedBy: 'oficial',
  });
  const historial = await lista(`scope=comun&categoryId=${superm.id}`);
  ok('sin mes vienen todos los meses', historial.length === 3, historial.length);
  const soloSeptiembre = await lista(`month=${MES}&scope=comun&categoryId=${superm.id}`);
  ok('y con mes, sólo el mes pedido', soloSeptiembre.length === 2, soloSeptiembre.length);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/cat.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

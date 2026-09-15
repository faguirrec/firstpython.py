/**
 * Gastos fijos: lo declarado contra lo que realmente se pagó.
 *
 * Lo que más importa probar es que la app **no invente** movimientos y que no
 * dé por pagado lo que no lo está: un mes que dice "todo al día" cuando falta
 * la luz es peor que no tener la función.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4180;
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

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'ana@f.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });

  const cats = (await s.pedir('GET', '/settings/categories')).categories as any[];
  const arriendoCat = cats.find((c) => /Arriendo/i.test(c.name));
  const cuentasCat = cats.find((c) => /Cuentas/i.test(c.name));
  const internetCat = cats.find((c) => /Internet/i.test(c.name));
  ok('las categorías por defecto están', Boolean(arriendoCat && cuentasCat && internetCat));

  const MES = new Date().toISOString().slice(0, 7);

  // Tres fijos: uno de monto fijo, uno variable, y dos que comparten categoría.
  await s.pedir('POST', '/finance/fixed', {
    name: 'Arriendo', amount: 650000, categoryId: arriendoCat.id, dueDay: 5,
  });
  await s.pedir('POST', '/finance/fixed', {
    name: 'Luz', categoryId: cuentasCat.id, dueDay: 12, matchText: 'enel',
  });
  await s.pedir('POST', '/finance/fixed', {
    name: 'Agua', categoryId: cuentasCat.id, dueDay: 15, matchText: 'aguas',
  });
  await s.pedir('POST', '/finance/fixed', {
    name: 'Internet', amount: 25000, categoryId: internetCat.id, dueDay: 20,
  });

  // ------------------------------------------------- nada pagado todavía
  let estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  ok('quedan los cuatro declarados', estado.items.length === 4, estado.items?.length);
  ok('ninguno figura pagado', estado.items.every((i: any) => !i.paid));
  ok('no se inventó ningún movimiento',
     (await s.pedir('GET', `/transactions?month=${MES}`)).transactions.length === 0);
  ok('el total esperado suma lo que se sabe', estado.totalExpected === 675000, estado.totalExpected);
  ok('la luz y el agua quedan sin estimación por falta de historia',
     estado.items.filter((i: any) => i.expectedFrom === 'sin-datos').length === 2,
     estado.items.map((i: any) => [i.name, i.expectedFrom]));

  // ------------------------------------------------------- se paga el arriendo
  await s.pedir('POST', '/transactions', {
    occurredOn: `${MES}-05`, amount: 650000, type: 'gasto', scope: 'comun',
    merchant: 'Arriendo depto', categoryId: arriendoCat.id,
  });
  estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  const arriendo = estado.items.find((i: any) => i.name === 'Arriendo');
  ok('el arriendo queda pagado al aparecer el movimiento', arriendo.paid === true, arriendo);
  ok('y queda amarrado al movimiento que lo pagó', Boolean(arriendo.paidWith?.id), arriendo.paidWith);
  ok('lo pendiente baja', estado.totalPending === 25000, estado.totalPending);

  // ------------------- dos cuentas en la misma categoría no se confunden
  await s.pedir('POST', '/transactions', {
    occurredOn: `${MES}-12`, amount: 45000, type: 'gasto', scope: 'comun',
    merchant: 'ENEL DISTRIBUCION', categoryId: cuentasCat.id,
  });
  estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  const luz = estado.items.find((i: any) => i.name === 'Luz');
  const agua = estado.items.find((i: any) => i.name === 'Agua');
  ok('el cargo de Enel paga la luz', luz.paid === true, luz.paidWith);
  ok('y NO da por pagada el agua, que es de la misma categoría', agua.paid === false, agua);
  ok('la luz pagada vale lo que se pagó de verdad', luz.expected === 45000, luz.expected);

  // ------------------------------ un cargo suelto no paga nada por su cuenta
  await s.pedir('POST', '/transactions', {
    occurredOn: `${MES}-18`, amount: 12000, type: 'gasto', scope: 'comun',
    merchant: 'FERRETERIA', categoryId: arriendoCat.id,
  });
  estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  ok('un segundo cargo en la categoría del arriendo no duplica el pago',
     estado.items.filter((i: any) => i.name === 'Arriendo' && i.paid).length === 1);

  const pendientes = estado.pendientes.map((p: any) => p.name).sort();
  ok('quedan pendientes el agua y el internet',
     pendientes.join(',') === 'Agua,Internet', pendientes);

  // ------------------------------------------------ la proyección los usa
  const proy = await s.pedir('GET', `/finance/projection?month=${MES}`);
  ok('la proyección dice que se apoya en los gastos fijos',
     /gastos fijos/.test(proy.basedOn ?? ''), proy.basedOn);

  // ------------------------------------------------------------ apagar uno
  const idInternet = estado.items.find((i: any) => i.name === 'Internet').id;
  await s.pedir('PATCH', `/finance/fixed/${idInternet}`, { active: false });
  estado = await s.pedir('GET', `/finance/fixed?month=${MES}`);
  ok('un gasto fijo apagado desaparece del mes',
     !estado.items.some((i: any) => i.name === 'Internet'), estado.items.map((i: any) => i.name));
  ok('pero sigue en la lista completa, para poder reactivarlo',
     estado.all.some((i: any) => i.name === 'Internet'), estado.all?.map((i: any) => i.name));

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/fijos.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

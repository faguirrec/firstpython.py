/**
 * El mes contable, separado de la fecha.
 *
 * Los sueldos no llegan a fin de mes exacto, así que la cuenta de septiembre se
 * paga a menudo en agosto. Lo que se prueba acá es que esa plata cuente en
 * septiembre sin que haya que mentir sobre cuándo se pagó: la fecha sirve para
 * cuadrar con la cartola, el período para cuadrar el mes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4181;
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

const AGOSTO = '2026-08';
const SEPTIEMBRE = '2026-09';

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'ana@p.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });
  const hogar = await s.pedir('GET', '/household');
  const ana = hogar.members[0].id;
  await s.pedir('PUT', '/finance/incomes', { month: AGOSTO, userId: ana, amount: 1_000_000 });

  const cats = (await s.pedir('GET', '/settings/categories')).categories as any[];
  const cuentas = cats.find((c) => /Cuentas/i.test(c.name));

  // Un gasto normal de agosto.
  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGOSTO}-10`, amount: 30000, type: 'gasto', scope: 'comun', merchant: 'SUPERMERCADO',
  });

  // La cuenta de la luz de SEPTIEMBRE, pagada el 28 de AGOSTO.
  const adelantado = await s.pedir('POST', '/transactions', {
    occurredOn: `${AGOSTO}-28`, period: SEPTIEMBRE, amount: 45000, type: 'gasto', scope: 'comun',
    merchant: 'ENEL', categoryId: cuentas.id,
  });
  ok('se puede anotar con un mes distinto al de la fecha', adelantado?.id !== undefined, adelantado);
  ok('la fecha real se conserva', adelantado?.occurredOn === `${AGOSTO}-28`, adelantado?.occurredOn);
  ok('y el período queda en septiembre', adelantado?.period === SEPTIEMBRE, adelantado?.period);

  // Y un aporte para septiembre, depositado también en agosto.
  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGOSTO}-25`, period: SEPTIEMBRE, amount: 200000, type: 'aporte', userId: ana,
  });

  // ------------------------------------------------- dónde cuenta cada cosa
  const enAgosto = await s.pedir('GET', `/finance/settlement?month=${AGOSTO}`);
  const enSeptiembre = await s.pedir('GET', `/finance/settlement?month=${SEPTIEMBRE}`);

  ok('agosto sólo tiene su propio gasto', enAgosto.totalSharedExpenses === 30000, enAgosto.totalSharedExpenses);
  ok('la cuenta adelantada cuenta en septiembre',
     enSeptiembre.totalSharedExpenses === 45000, enSeptiembre.totalSharedExpenses);
  ok('el aporte adelantado también',
     enSeptiembre.members.find((m: any) => m.userId === ana)?.contributed === 200000,
     enSeptiembre.members);
  ok('y no aparece en agosto',
     enAgosto.members.find((m: any) => m.userId === ana)?.contributed === 0, enAgosto.members);

  // ----------------------------------------------------- listas y reportes
  const listaAgosto = await s.pedir('GET', `/transactions?month=${AGOSTO}`);
  const listaSept = await s.pedir('GET', `/transactions?month=${SEPTIEMBRE}`);
  ok('la lista de agosto no muestra lo de septiembre',
     !JSON.stringify(listaAgosto).includes('ENEL'), listaAgosto.transactions?.map((t: any) => t.merchant));
  ok('la de septiembre sí', JSON.stringify(listaSept).includes('ENEL'));

  const porCategoria = await s.pedir('GET', `/finance/reports/by-category?month=${SEPTIEMBRE}&scope=comun`);
  ok('el desglose por categoría respeta el período',
     JSON.stringify(porCategoria).includes('45000'), porCategoria);

  const presupuesto = await s.pedir('GET', `/finance/budgets?month=${SEPTIEMBRE}`);
  ok('el presupuesto de septiembre ve el gasto adelantado',
     presupuesto.totalSpent === 45000, presupuesto.totalSpent);

  // ---------------------------------------- los gastos fijos lo aprovechan
  await s.pedir('POST', '/finance/fixed', {
    name: 'Luz', categoryId: cuentas.id, dueDay: 12, matchText: 'enel',
  });
  const fijosSept = await s.pedir('GET', `/finance/fixed?month=${SEPTIEMBRE}`);
  const luzSept = fijosSept.items.find((i: any) => i.name === 'Luz');
  ok('la luz de septiembre figura pagada, aunque se pagó en agosto',
     luzSept?.paid === true, luzSept);

  const fijosAgo = await s.pedir('GET', `/finance/fixed?month=${AGOSTO}`);
  const luzAgo = fijosAgo.items.find((i: any) => i.name === 'Luz');
  ok('y en agosto sigue pendiente, que es lo correcto', luzAgo?.paid === false, luzAgo);

  // -------------------------------------------- cambiar de mes un existente
  await s.pedir('PATCH', `/transactions/${adelantado.id}`, { period: AGOSTO });
  const movido = await s.pedir('GET', `/finance/settlement?month=${AGOSTO}`);
  ok('se puede mover un movimiento de mes después',
     movido.totalSharedExpenses === 75000, movido.totalSharedExpenses);

  // ------------------------------------- lo que no se dice, cae por la fecha
  const normal = await s.pedir('POST', '/transactions', {
    occurredOn: `${SEPTIEMBRE}-03`, amount: 5000, type: 'gasto', scope: 'comun', merchant: 'PAN',
  });
  ok('sin período, cuenta al mes de su fecha', normal?.period === SEPTIEMBRE, normal?.period);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/periodo.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

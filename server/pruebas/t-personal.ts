/**
 * El modo personal: presupuestos, metas y resumen propios, separados de los del
 * hogar y del otro integrante.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4178;
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
  const ana = new Sesion();
  const bruno = new Sesion();
  await ana.pedir('POST', '/auth/register', { email: 'ana@x.cl', password: 'hogar1234', name: 'Ana' });
  await ana.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });
  const inv = await ana.pedir('POST', '/household/invite', {});
  await bruno.pedir('POST', '/auth/register', {
    email: 'bruno@x.cl', password: 'hogar1234', name: 'Bruno', inviteCode: inv.code ?? inv.inviteCode,
  });

  const MES = new Date().toISOString().slice(0, 7);
  const dia = `${MES}-05`;
  const hogar = await ana.pedir('GET', '/household');
  const idAna = hogar.members.find((m: any) => m.name === 'Ana').id;

  await ana.pedir('PUT', '/finance/incomes', { month: MES, userId: idAna, amount: 1_500_000 });

  // Gasto común pagado desde la cuenta del hogar, un aporte de Ana, y lo suyo.
  await ana.pedir('POST', '/transactions', { occurredOn: dia, amount: 200000, type: 'gasto', scope: 'comun', merchant: 'Arriendo' });
  await ana.pedir('POST', '/transactions', { occurredOn: dia, amount: 300000, type: 'aporte' });
  await ana.pedir('POST', '/transactions', { occurredOn: dia, amount: 40000, type: 'gasto', scope: 'personal', merchant: 'ROPA' });
  await bruno.pedir('POST', '/transactions', { occurredOn: dia, amount: 90000, type: 'gasto', scope: 'personal', merchant: 'BICICLETA' });

  // ------------------------------------------------------ resumen personal
  const resumen = await ana.pedir('GET', `/finance/personal?month=${MES}`);
  ok('el sueldo del mes', resumen.income === 1_500_000, resumen);
  ok('sus gastos personales, no los de Bruno', resumen.personalExpenses === 40000, resumen.personalExpenses);
  ok('lo que puso en la casa aparece como salida', resumen.contributedToHousehold === 300000, resumen);
  ok('lo que le queda descuenta el aporte al hogar',
     resumen.left === 1_500_000 - 40000 - 300000, resumen.left);
  ok('y la tasa de ahorro sale de ahí',
     Math.abs((resumen.savingsRate ?? 0) - resumen.left / resumen.income) < 1e-9, resumen.savingsRate);

  // ------------------------------------------------------ presupuestos
  const cats = await ana.pedir('GET', '/settings/categories');
  const lista = cats.categories ?? cats;
  const ropa = lista.find((c: any) => /Otros/i.test(c.name)) ?? lista[0];

  await ana.pedir('PUT', '/finance/budgets', { categoryId: ropa.id, amount: 500000 });
  await ana.pedir('PUT', '/finance/budgets', { categoryId: ropa.id, amount: 60000, modo: 'personal' });

  const presHogar = await ana.pedir('GET', `/finance/budgets?month=${MES}`);
  const presAna = await ana.pedir('GET', `/finance/budgets?month=${MES}&modo=personal`);
  const enHogar = presHogar.categories.find((c: any) => c.categoryId === ropa.id);
  const enAna = presAna.categories.find((c: any) => c.categoryId === ropa.id);
  ok('el tope del hogar y el personal conviven en la misma categoría',
     enHogar.budget === 500000 && enAna.budget === 60000, [enHogar.budget, enAna.budget]);

  const presBruno = await bruno.pedir('GET', `/finance/budgets?month=${MES}&modo=personal`);
  const enBruno = presBruno.categories.find((c: any) => c.categoryId === ropa.id);
  ok('Bruno no ve el presupuesto personal de Ana', enBruno.budget === 0, enBruno.budget);

  // ------------------------------------------------------------- metas
  await ana.pedir('POST', '/finance/goals', { name: 'Vacaciones del hogar', targetAmount: 1_000_000 });
  await ana.pedir('POST', '/finance/goals', { name: 'Notebook de Ana', targetAmount: 800000, modo: 'personal' });

  const metasHogar = await ana.pedir('GET', '/finance/goals');
  const metasAna = await ana.pedir('GET', '/finance/goals?modo=personal');
  const metasBruno = await bruno.pedir('GET', '/finance/goals?modo=personal');

  ok('la meta del hogar está en el hogar',
     metasHogar.goals.length === 1 && metasHogar.goals[0].name === 'Vacaciones del hogar', metasHogar.goals);
  ok('la meta personal está en lo personal',
     metasAna.goals.length === 1 && metasAna.goals[0].name === 'Notebook de Ana', metasAna.goals);
  ok('Bruno no ve la meta personal de Ana', metasBruno.goals.length === 0, metasBruno.goals);

  ok('la meta del hogar se financia con el fondo de reserva',
     metasHogar.reserve === 100000, metasHogar.reserve);
  ok('la personal, con lo que le ha sobrado a Ana',
     metasAna.reserve === 1_500_000 - 40000 - 300000, metasAna.reserve);

  const idMetaAna = metasAna.goals[0].id;
  await bruno.pedir('DELETE', `/finance/goals/${idMetaAna}`);
  const siguen = await ana.pedir('GET', '/finance/goals?modo=personal');
  ok('Bruno no puede borrar la meta personal de Ana', siguen.goals.length === 1, siguen.goals);

  // -------------------------------------------------------- comparación
  const compHogar = await ana.pedir('GET', `/finance/reports/comparison?month=${MES}`);
  const compAna = await ana.pedir('GET', `/finance/reports/comparison?month=${MES}&modo=personal`);
  const textoHogar = JSON.stringify(compHogar);
  const textoAna = JSON.stringify(compAna);
  ok('la comparación del hogar mira el gasto común', textoHogar.includes('200000'), textoHogar.slice(0, 200));
  ok('la personal mira lo suyo', textoAna.includes('40000'), textoAna.slice(0, 200));
  ok('y no lo de Bruno', !textoAna.includes('90000'), textoAna.slice(0, 200));

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env,
    PORT: String(PUERTO),
    DB_PATH: path.join(RAIZ, 'pruebas/personal.db'),
    JWT_SECRET: 'secreto-de-prueba',
    ALLOW_SIGNUP: 'open',
    CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());

await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

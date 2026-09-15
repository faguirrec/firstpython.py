/**
 * Lo que se escribe una vez en Reparto se queda: el sueldo y el gasto estimado
 * del mes. Volver a decidirlos cada vez que se abre la pantalla es la forma más
 * rápida de que nadie la abra.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4182;
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

const AGO = '2026-08', SEP = '2026-09', OCT = '2026-10';

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'f@r.cl', password: 'hogar1234', name: 'Francisco' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });
  const inv = await s.pedir('POST', '/household/invite', {});
  const otra = new Sesion();
  await otra.pedir('POST', '/auth/register', {
    email: 'c@r.cl', password: 'hogar1234', name: 'Carolina', inviteCode: inv.code ?? inv.inviteCode,
  });
  const miembros = (await s.pedir('GET', '/household')).members as any[];
  const F = miembros.find((m) => m.name === 'Francisco').id;
  const C = miembros.find((m) => m.name === 'Carolina').id;

  // ------------------------------------------------ el sueldo se arrastra
  await s.pedir('PUT', '/finance/incomes', { month: AGO, userId: F, amount: 1_500_000 });
  await s.pedir('PUT', '/finance/incomes', { month: AGO, userId: C, amount: 1_000_000 });

  const sepLiq = await s.pedir('GET', `/finance/settlement?month=${SEP}`);
  const fSep = sepLiq.members.find((m: any) => m.userId === F);
  const cSep = sepLiq.members.find((m: any) => m.userId === C);
  ok('septiembre hereda el sueldo de agosto sin declararlo',
     fSep.income === 1_500_000 && cSep.income === 1_000_000, [fSep.income, cSep.income]);
  ok('y el porcentaje sale 60/40', Math.abs(fSep.incomeShare - 0.6) < 1e-9, fSep.incomeShare);

  // La pantalla distingue lo declarado de lo heredado por esta lista.
  const declarados = (await s.pedir('GET', '/finance/incomes')).incomes as any[];
  ok('septiembre no tiene registro propio, sólo agosto',
     declarados.filter((i) => i.month === SEP).length === 0 &&
     declarados.filter((i) => i.month === AGO).length === 2, declarados.map((i) => i.month));

  // ------------------------------------------- el gasto estimado se guarda
  const sinNada = await s.pedir('GET', `/finance/projection?month=${SEP}`);
  ok('sin nada anotado, no hay total guardado', sinNada.savedTarget == null, sinNada.savedTarget);

  await s.pedir('PUT', '/finance/target', { month: SEP, amount: 900_000 });

  const conTotal = await s.pedir('GET', `/finance/projection?month=${SEP}`);
  ok('el total queda guardado', conTotal.savedTarget === 900_000, conTotal.savedTarget);
  ok('y no figura heredado en el mes donde se escribió',
     conTotal.targetInherited === false, conTotal.targetInherited);
  ok('la proyección lo usa como base', conTotal.baseBudget === 900_000, conTotal.baseBudget);
  ok('y lo dice', /anotaron para este mes/.test(conTotal.basedOn), conTotal.basedOn);

  const octubre = await s.pedir('GET', `/finance/projection?month=${OCT}`);
  ok('octubre lo hereda sin que nadie lo escriba', octubre.savedTarget === 900_000, octubre.savedTarget);
  ok('y sabe que es heredado', octubre.targetInherited === true, octubre.targetInherited);
  ok('lo dice también', /dejaron anotado antes/.test(octubre.basedOn), octubre.basedOn);

  // Cambiarlo en octubre no toca septiembre.
  await s.pedir('PUT', '/finance/target', { month: OCT, amount: 1_200_000 });
  ok('cambiarlo en octubre no altera septiembre',
     (await s.pedir('GET', `/finance/projection?month=${SEP}`)).savedTarget === 900_000);
  ok('y octubre queda con el suyo',
     (await s.pedir('GET', `/finance/projection?month=${OCT}`)).savedTarget === 1_200_000);

  // Borrarlo vuelve a la estimación automática.
  await s.pedir('PUT', '/finance/target', { month: OCT, amount: 0 });
  const borrado = await s.pedir('GET', `/finance/projection?month=${OCT}`);
  ok('con 0 se borra y vuelve a heredar el de septiembre', borrado.savedTarget === 900_000, borrado.savedTarget);

  // ------------------------------------------- anotar el aporte a mano
  const proy = await s.pedir('GET', `/finance/projection?month=${SEP}`);
  const leToca = proy.rows.find((r: any) => r.userId === F).amount;
  ok('la proyección dice cuánto transfiere cada uno', leToca > 0, proy.rows);

  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGO}-25`, period: SEP, amount: leToca, type: 'aporte', userId: F,
  });
  const conAporte = await s.pedir('GET', `/finance/settlement?month=${SEP}`);
  ok('el aporte anotado a mano le cuenta a esa persona',
     conAporte.members.find((m: any) => m.userId === F).contributed === leToca,
     conAporte.members.map((m: any) => [m.name, m.contributed]));
  ok('y no a la otra',
     conAporte.members.find((m: any) => m.userId === C).contributed === 0);

  // ------------------------------- lo que falta baja con lo que se pone
  const despues = await s.pedir('GET', `/finance/projection?month=${SEP}`);
  const filaF = despues.rows.find((r: any) => r.userId === F);
  const filaC = despues.rows.find((r: any) => r.userId === C);
  ok('la proyección registra lo que ya puso', filaF.contributed === leToca, filaF);
  ok('y le deja cero por poner', filaF.pending === 0, filaF.pending);
  ok('sin tocar lo que le toca en total', filaF.amount === leToca, filaF.amount);
  ok('a la otra persona no le baja nada', filaC.pending === filaC.amount, filaC);

  // Un aporte parcial descuenta parcial.
  const mitad = Math.round(filaC.amount / 2);
  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGO}-26`, period: SEP, amount: mitad, type: 'aporte', userId: C,
  });
  const parcial = (await s.pedir('GET', `/finance/projection?month=${SEP}`))
    .rows.find((r: any) => r.userId === C);
  ok('un aporte parcial descuenta lo suyo',
     Math.abs(parcial.pending - (parcial.amount - mitad)) < 1, parcial);

  // Poner de más no deja un pendiente negativo.
  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGO}-27`, period: SEP, amount: filaC.amount, type: 'aporte', userId: C,
  });
  const pasado = (await s.pedir('GET', `/finance/projection?month=${SEP}`))
    .rows.find((r: any) => r.userId === C);
  ok('poner de más deja el pendiente en cero, no en negativo', pasado.pending === 0, pasado.pending);

  // Un gasto común pagado del bolsillo también cuenta como puesto.
  const antesDelBolsillo = (await s.pedir('GET', `/finance/projection?month=${SEP}`))
    .rows.find((r: any) => r.userId === F).contributed;
  await s.pedir('POST', '/transactions', {
    occurredOn: `${AGO}-28`, period: SEP, amount: 20000, type: 'gasto', scope: 'comun',
    fundedBy: F, merchant: 'FERRETERIA',
  });
  const conBolsillo = (await s.pedir('GET', `/finance/projection?month=${SEP}`))
    .rows.find((r: any) => r.userId === F).contributed;
  ok('pagar un gasto común de su bolsillo cuenta como aporte',
     conBolsillo === antesDelBolsillo + 20000, [antesDelBolsillo, conBolsillo]);

  // Y la liquidación tiene que decir exactamente lo mismo.
  const liq = await s.pedir('GET', `/finance/settlement?month=${SEP}`);
  const proyF = (await s.pedir('GET', `/finance/projection?month=${SEP}`))
    .rows.find((r: any) => r.userId === F);
  ok('la proyección y la liquidación coinciden en lo que puso cada uno',
     liq.members.find((m: any) => m.userId === F).contributed === proyF.contributed,
     [liq.members.find((m: any) => m.userId === F).contributed, proyF.contributed]);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/reparto.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

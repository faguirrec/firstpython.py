/**
 * El mes contado para leerlo de a dos.
 *
 * Lo que se verifica no es que los números existan —eso ya lo cubren otras
 * pruebas— sino las decisiones de qué contar y qué callar, que es donde vive el
 * valor de esta pantalla:
 *
 *  - El gasto destacado no puede ser el arriendo. Es el más caro todos los
 *    meses y nombrarlo no le dice nada a nadie; lo que vale la pena mirar
 *    juntos es lo que pasó una sola vez.
 *  - Una variación de mil pesos sobre un millón no es una noticia. Si se
 *    nombra, el resumen se llena de ruido y deja de leerse.
 *  - El primer mes no puede inventar una comparación contra un promedio que no
 *    existe.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4187;
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

const AGO = '2026-08';
const SEP = '2026-09';

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'a@cita.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });
  const inv = await s.pedir('POST', '/household/invite', {});
  const otra = new Sesion();
  await otra.pedir('POST', '/auth/register', {
    email: 'b@cita.cl', password: 'hogar1234', name: 'Beto', inviteCode: inv.code ?? inv.inviteCode,
  });
  const miembros = (await s.pedir('GET', '/household')).members as any[];
  const ana = miembros.find((m) => m.name === 'Ana').id;
  const beto = miembros.find((m) => m.name === 'Beto').id;
  await s.pedir('PUT', '/finance/incomes', { month: AGO, userId: ana, amount: 1_500_000 });
  await s.pedir('PUT', '/finance/incomes', { month: AGO, userId: beto, amount: 1_000_000 });

  const cats = (await s.pedir('GET', '/settings/categories')).categories as any[];
  const arriendo = cats.find((c) => /arriendo/i.test(c.name));
  const superm = cats.find((c) => /supermercado/i.test(c.name));
  const entrete = cats.find((c) => /entreten/i.test(c.name));

  const gasto = (amount: number, cat: any, dia: string, mes: string, merchant: string) =>
    s.pedir('POST', '/transactions', {
      occurredOn: dia, period: mes, amount, type: 'gasto', scope: 'comun',
      categoryId: cat?.id ?? null, merchant, fundedBy: 'oficial',
    });

  // El arriendo es un gasto fijo declarado: se reconoce solo en los movimientos.
  await s.pedir('POST', '/finance/fixed', {
    name: 'Arriendo', amount: 520_000, dueDay: 3, categoryId: arriendo.id,
  });

  // ─────────────────────────────────────────────── el primer mes: agosto
  await gasto(520_000, arriendo, `${AGO}-03`, AGO, 'Arriendo');
  await gasto(60_000, superm, `${AGO}-10`, AGO, 'Jumbo');
  await gasto(9_990, entrete, `${AGO}-11`, AGO, 'Netflix');

  const deAgosto = await s.pedir('GET', `/finance/settlement/cierre?month=${AGO}`);
  ok('el primer mes no inventa un promedio', deAgosto.mesesDeHistoria === 0, deAgosto.mesesDeHistoria);
  ok('ni una diferencia contra él', deAgosto.contraPromedio === 0, deAgosto.contraPromedio);
  ok('el gasto destacado no es el arriendo, que es fijo',
     deAgosto.elGrande?.merchant === 'Jumbo', deAgosto.elGrande);
  ok('y es el más caro de los que no son fijos', deAgosto.elGrande?.amount === 60_000, deAgosto.elGrande?.amount);

  // ─────────────────────────────────────── septiembre, con qué comparar
  await gasto(520_000, arriendo, `${SEP}-03`, SEP, 'Arriendo');
  // Supermercado sube fuerte: eso sí es noticia.
  await gasto(140_000, superm, `${SEP}-08`, SEP, 'Jumbo');
  // Y entretención baja mil pesos: eso no lo es.
  await gasto(8_990, entrete, `${SEP}-11`, SEP, 'Netflix');
  // Un gasto único grande, pero menor que el arriendo.
  await gasto(180_000, null, `${SEP}-20`, SEP, 'Pasajes a Mendoza');

  const c = await s.pedir('GET', `/finance/settlement/cierre?month=${SEP}`);

  ok('el total del mes es el de los gastos comunes',
     c.total === 520_000 + 140_000 + 8_990 + 180_000, c.total);
  ok('ahora sí hay un mes de historia con qué comparar', c.mesesDeHistoria === 1, c.mesesDeHistoria);
  ok('y el promedio es el de agosto', c.promedio === 589_990, c.promedio);

  /*
   * "Sin categoría" se movió $180.000 —más que supermercado— y aun así no se
   * nombra: no es un cambio de hábito, es información que falta.
   */
  ok('nombra la categoría que subió de verdad, no la bolsa de lo sin clasificar',
     c.subio?.category === superm.name, c.subio);
  ok('con el id para poder entrar a verla', c.subio?.categoryId === superm.id, c.subio);
  ok('por la diferencia correcta', c.subio?.delta === 80_000, c.subio?.delta);
  ok('y calla la baja de mil pesos, que no es noticia', c.bajo == null, c.bajo);

  ok('el destacado es el gasto único, no el arriendo',
     c.elGrande?.merchant === 'Pasajes a Mendoza', c.elGrande);

  ok('dice el mes que viene', c.nextMonth === '2026-10', c.nextMonth);
  ok('y lo que ya se sabe que hay que pagar en él',
     c.loQueViene.fijos === 1 && c.loQueViene.total === 520_000, c.loQueViene);

  ok('cuenta a las dos personas', c.personas.length === 2, c.personas.length);
  const suyo = c.personas.find((p: any) => p.userId === ana);
  ok('con lo que le toca a cada una según el sueldo',
     Math.abs(suyo.fairShare - c.total * 0.6) < 1, [suyo.fairShare, c.total * 0.6]);

  ok('y cuántos movimientos entraron solos',
     c.automaticos.total === 4 && c.automaticos.porCorreo === 0, c.automaticos);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/cita.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

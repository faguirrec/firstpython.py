/**
 * Lo personal es privado: ningún camino de la API puede mostrarle a una persona
 * los gastos personales de la otra.
 *
 * Se prueba contra el servidor de verdad y con dos sesiones distintas, porque el
 * riesgo no está en la consulta que uno recuerda arreglar sino en la que se
 * olvida: basta un reporte que sume sin filtrar para que el detalle se filtre en
 * forma de total.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** La raíz del servidor, para que dé lo mismo desde dónde se invoque la prueba. */
const RAIZ = path.resolve(import.meta.dirname, '..');

const PUERTO = 4177;
const BASE = `http://localhost:${PUERTO}/api`;

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sesión con su propia galleta, para poder mirar la app como cada persona. */
class Sesion {
  cookie = '';
  constructor(readonly nombre: string) {}

  async pedir(metodo: string, ruta: string, cuerpo?: unknown): Promise<any> {
    const r = await fetch(BASE + ruta, {
      method: metodo,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const texto = await r.text();
    try { return JSON.parse(texto); } catch { return texto; }
  }
}

async function main() {
  const ana = new Sesion('Ana');
  const bruno = new Sesion('Bruno');

  await ana.pedir('POST', '/auth/register', { email: 'ana@p.cl', password: 'hogar1234', name: 'Ana' });
  const hogar = await ana.pedir('POST', '/household', {
    name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta',
  });
  const invite = await ana.pedir('POST', '/household/invite', {});
  const codigo = invite.code ?? invite.inviteCode;
  ok('se generó un código de invitación', Boolean(codigo), invite);

  await bruno.pedir('POST', '/auth/register', {
    email: 'bruno@p.cl', password: 'hogar1234', name: 'Bruno', inviteCode: codigo,
  });
  const hogarBruno = await bruno.pedir('GET', '/household');
  ok('Bruno entró al mismo hogar', hogarBruno.members?.length === 2, hogarBruno);

  const MES = new Date().toISOString().slice(0, 7);
  const dia = `${MES}-05`;

  // Un gasto común: los dos lo tienen que ver.
  await ana.pedir('POST', '/transactions', {
    occurredOn: dia, amount: 50000, type: 'gasto', scope: 'comun', merchant: 'Supermercado',
  });
  // Y uno personal de cada uno.
  await ana.pedir('POST', '/transactions', {
    occurredOn: dia, amount: 11111, type: 'gasto', scope: 'personal', merchant: 'PELUQUERIA DE ANA',
  });
  await bruno.pedir('POST', '/transactions', {
    occurredOn: dia, amount: 22222, type: 'gasto', scope: 'personal', merchant: 'GIMNASIO DE BRUNO',
  });

  // ---------------------------------------------------- lista de movimientos
  const listaAna = await ana.pedir('GET', `/transactions?month=${MES}`);
  const textoAna = JSON.stringify(listaAna);
  ok('Ana ve el gasto común', /Supermercado/.test(textoAna));
  ok('Ana ve lo suyo', /PELUQUERIA DE ANA/.test(textoAna));
  ok('Ana NO ve el gasto personal de Bruno', !/GIMNASIO DE BRUNO/.test(textoAna), textoAna.slice(0, 300));
  ok('Ana no ve ni el monto de lo de Bruno', !textoAna.includes('22222'));

  const listaBruno = JSON.stringify(await bruno.pedir('GET', `/transactions?month=${MES}`));
  ok('Bruno NO ve el gasto personal de Ana', !/PELUQUERIA DE ANA/.test(listaBruno));
  ok('pero sí ve el común', /Supermercado/.test(listaBruno));

  // Ni siquiera pidiendo explícitamente el ámbito personal.
  const forzado = JSON.stringify(await bruno.pedir('GET', `/transactions?month=${MES}&scope=personal`));
  ok('pedir scope=personal no destapa lo del otro', !/PELUQUERIA/.test(forzado), forzado.slice(0, 200));

  // ------------------------------------------------------------- reportes
  const mensual = JSON.stringify(await ana.pedir('GET', '/finance/reports/monthly'));
  ok('el resumen mensual sólo cuenta lo personal de quien pregunta',
     mensual.includes('11111') && !mensual.includes('22222'), mensual.slice(0, 300));

  const porCategoria = JSON.stringify(await ana.pedir('GET', `/finance/reports/by-category?month=${MES}`));
  ok('el desglose por categoría no incluye lo del otro',
     !porCategoria.includes('22222'), porCategoria.slice(0, 300));

  const tendencia = JSON.stringify(await ana.pedir('GET', '/finance/reports/category-trend'));
  ok('la evolución por categoría tampoco', !tendencia.includes('22222'), tendencia.slice(0, 200));

  const liquidacion = await ana.pedir('GET', `/finance/settlement?month=${MES}`);
  ok('la liquidación le muestra a Ana sus $11.111 personales',
     liquidacion.totalPersonalExpenses === 11111, liquidacion.totalPersonalExpenses);
  const liqBruno = await bruno.pedir('GET', `/finance/settlement?month=${MES}`);
  ok('y a Bruno los suyos, no los de Ana',
     liqBruno.totalPersonalExpenses === 22222, liqBruno.totalPersonalExpenses);
  ok('el gasto común es el mismo para los dos',
     liquidacion.totalSharedExpenses === liqBruno.totalSharedExpenses, [liquidacion.totalSharedExpenses, liqBruno.totalSharedExpenses]);

  // ------------------------------------------------- editar y borrar ajeno
  const mios = await bruno.pedir('GET', `/transactions?month=${MES}&scope=personal`);
  const idDeBruno = mios.transactions?.[0]?.id;
  const idsDeAna = (await ana.pedir('GET', `/transactions?month=${MES}&scope=personal`)).transactions;
  const idDeAna = idsDeAna?.[0]?.id;
  ok('cada uno encuentra su movimiento personal', Boolean(idDeBruno && idDeAna));

  const intentoEditar = await bruno.pedir('PATCH', `/transactions/${idDeAna}`, { amount: 1 });
  ok('Bruno no puede editar el movimiento personal de Ana',
     intentoEditar?.error !== undefined, intentoEditar);

  await bruno.pedir('DELETE', `/transactions/${idDeAna}`);
  const siguePresente = JSON.stringify(await ana.pedir('GET', `/transactions?month=${MES}`));
  ok('ni borrarlo', /PELUQUERIA DE ANA/.test(siguePresente));

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

// El servidor de verdad, con su base recién creada.
const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env,
    PORT: String(PUERTO),
    DB_PATH: path.join(RAIZ, 'pruebas/privacidad.db'),
    JWT_SECRET: 'secreto-de-prueba',
    ALLOW_SIGNUP: 'open',
    CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());

await esperar(2500);
await main().catch((e) => {
  console.error('La prueba se cayó:', e.message);
  servidor.kill();
  process.exit(1);
});

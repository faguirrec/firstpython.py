/**
 * La compra que entra desde el iPhone.
 *
 * Banco Falabella no manda correo por las compras con tarjeta, así que esta es
 * la única vía que las ve en el momento. Lo que se verifica acá es lo que
 * duele si falla:
 *
 *  - Leer el monto. iOS lo manda con el formato de la región del teléfono, y
 *    confundir el separador de miles con el decimal convierte $38.450 en $38.
 *    Es el error más caro posible en una app de plata y el más silencioso.
 *  - Que la llave sirva para una sola cosa. Si se filtra, lo peor que puede
 *    pasar es que alguien ensucie la lista; no que lea el mes ni cierre nada.
 *  - Que el mismo pago no entre dos veces. La automatización de iOS a veces se
 *    ejecuta de más, y un gasto duplicado hay que cazarlo a mano.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PUERTO = 4188;
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

/** Lo que hace el Atajo: un POST con la llave y nada más. */
async function comoElAtajo(clave: string | null, cuerpo: unknown) {
  const r = await fetch(`${BASE}/atajo/movimiento`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(clave ? { authorization: `Bearer ${clave}` } : {}),
    },
    body: JSON.stringify(cuerpo),
  });
  const t = await r.text();
  try { return { estado: r.status, cuerpo: JSON.parse(t) }; } catch { return { estado: r.status, cuerpo: t }; }
}

async function main() {
  const s = new Sesion();
  await s.pedir('POST', '/auth/register', { email: 'a@atajo.cl', password: 'hogar1234', name: 'Ana' });
  await s.pedir('POST', '/household', { name: 'Casa', currency: 'CLP', officialAccount: 'Cuenta' });

  // ───────────────────────────────────────────── la llave
  const creada = await s.pedir('POST', '/atajo/claves', { nombre: 'iPhone de Ana' });
  const clave = creada.cuerpo.clave as string;
  ok('crear una llave la devuelve entera, una sola vez', typeof clave === 'string' && clave.length > 20, creada.cuerpo);
  ok('y lleva prefijo reconocible', clave.startsWith('mh_'), clave.slice(0, 6));

  const lista = await s.pedir('GET', '/atajo/claves');
  ok('la lista muestra la llave', lista.cuerpo.claves.length === 1, lista.cuerpo);
  ok('pero nunca el secreto, sólo la cola',
     !JSON.stringify(lista.cuerpo).includes(clave) && lista.cuerpo.claves[0].cola === clave.slice(-4),
     lista.cuerpo.claves[0]);

  // ───────────────────────────────────── sin llave no entra nada
  ok('sin llave, 401', (await comoElAtajo(null, { monto: '1000' })).estado === 401);
  ok('con una llave inventada, 401', (await comoElAtajo('mh_inventada', { monto: '1000' })).estado === 401);

  // ─────────────────────────────── leer el monto, el punto delicado
  //
  // El primero es el formato chileno, que es el que va a llegar el 99% de las
  // veces. Los demás son lo que manda un iPhone configurado en otra región.
  const casos: [string | number, number, string][] = [
    ['$38.450', 38_450, 'chileno con signo y punto de miles'],
    ['38.450', 38_450, 'chileno sin signo'],
    ['138.300', 138_300, 'seis cifras con punto de miles'],
    ['1.963.077', 1_963_077, 'millones con dos puntos'],
    ['38450', 38_450, 'sin separadores'],
    ['38,450.00', 38_450, 'inglés: coma de miles y punto decimal'],
    ['12.990,50', 12_991, 'chileno con decimales, que se redondean'],
    [59_445, 59_445, 'ya viene como número'],
  ];
  for (const [entrada, esperado, porque] of casos) {
    const r = await comoElAtajo(clave, { monto: entrada, comercio: `Prueba ${porque}` });
    ok(`lee ${JSON.stringify(entrada)} como $${esperado.toLocaleString('es-CL')} (${porque})`,
       r.cuerpo?.monto === esperado, r.cuerpo);
  }

  for (const malo of ['', 'no es plata', '0', '-500']) {
    const r = await comoElAtajo(clave, { monto: malo });
    ok(`rechaza ${JSON.stringify(malo)} en vez de anotar cualquier cosa`, r.estado === 400, r);
  }

  // ─────────────────────────────────── cómo queda el movimiento
  const hoy = new Date().toISOString().slice(0, 10);
  const compra = await comoElAtajo(clave, {
    monto: '$16.738', comercio: 'MINIMARKET CAROL ANDRE CAUTIN CHL', tarjeta: 'CMR', fecha: hoy,
  });
  ok('la compra queda creada', compra.estado === 201, compra);
  ok('le quita el sufijo de país al comercio',
     compra.cuerpo.comercio === 'MINIMARKET CAROL ANDRE CAUTIN', compra.cuerpo.comercio);

  const movs = (await s.pedir('GET', `/transactions?month=${hoy.slice(0, 7)}`)).cuerpo.transactions as any[];
  const mia = movs.find((m) => m.id === compra.cuerpo.id);
  ok('entra como gasto común pagado con la cuenta del hogar',
     mia?.type === 'gasto' && mia?.scope === 'comun' && mia?.fundedBy === 'oficial', mia);
  ok('y SIN revisar: el disparador de iOS pierde eventos, no es fuente de verdad',
     mia?.reviewed === 0, mia?.reviewed);
  ok('queda dicho de dónde vino', mia?.source === 'atajo', mia?.source);

  // ─────────────────────────────────── el mismo pago, dos veces
  const otraVez = await comoElAtajo(clave, {
    monto: '$16.738', comercio: 'MINIMARKET CAROL ANDRE CAUTIN CHL', tarjeta: 'CMR', fecha: hoy,
  });
  ok('el mismo pago repetido no se anota dos veces',
     otraVez.cuerpo.duplicado === true && otraVez.cuerpo.id === compra.cuerpo.id, otraVez.cuerpo);
  const despues = (await s.pedir('GET', `/transactions?month=${hoy.slice(0, 7)}`)).cuerpo.transactions as any[];
  ok('y la lista no creció', despues.length === movs.length, [movs.length, despues.length]);

  // Pero dos compras distintas en el mismo comercio sí son dos.
  const distinta = await comoElAtajo(clave, {
    monto: '$24.450', comercio: 'MINIMARKET CAROL ANDRE CAUTIN CHL', fecha: hoy,
  });
  ok('dos montos distintos en el mismo comercio sí son dos compras',
     distinta.estado === 201 && distinta.cuerpo.id !== compra.cuerpo.id, distinta.cuerpo);

  // ─────────────────────────────── la llave no puede hacer nada más
  const conLlave = async (metodo: string, ruta: string) => {
    const r = await fetch(BASE + ruta, { method: metodo, headers: { authorization: `Bearer ${clave}` } });
    return r.status;
  };
  ok('la llave no sirve para leer los movimientos', (await conLlave('GET', '/transactions')) === 401);
  ok('ni para ver la liquidación', (await conLlave('GET', '/finance/settlement?month=2026-09')) === 401);
  ok('ni para ver el hogar', (await conLlave('GET', '/household')) === 401);

  // ───────────────────────────────────────────── revocar
  const id = (await s.pedir('GET', '/atajo/claves')).cuerpo.claves[0].id;
  await s.pedir('DELETE', `/atajo/claves/${id}`);
  ok('revocada, la llave deja de servir en el acto',
     (await comoElAtajo(clave, { monto: '1000' })).estado === 401);
  const tras = (await s.pedir('GET', '/atajo/claves')).cuerpo.claves[0];
  ok('pero queda el registro de que existió y cuándo se dio de baja',
     tras != null && tras.revocadaAt != null, tras);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

const servidor: ChildProcess = spawn('node', ['dist/index.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: String(PUERTO), DB_PATH: path.join(RAIZ, 'pruebas/atajo.db'),
    JWT_SECRET: 'secreto-de-prueba', ALLOW_SIGNUP: 'open', CORREO_TIEMPO_REAL: '0',
  },
  stdio: 'ignore',
});
process.on('exit', () => servidor.kill());
await esperar(2500);
await main().catch((e) => { console.error('La prueba se cayó:', e.message); servidor.kill(); process.exit(1); });

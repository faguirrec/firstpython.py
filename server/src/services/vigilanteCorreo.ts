import { ImapFlow } from 'imapflow';
import {
  conectar,
  cuentasDeTodosLosHogares,
  explicarErrorImap,
  secretoDe,
  sincronizarImap,
  type CuentaImap,
} from './imap.js';

/**
 * Vigilante del correo: la parte que hace que los gastos entren solos.
 *
 * Mantiene una conexión abierta contra el buzón de cada cuenta. IMAP tiene un
 * comando —IDLE— con el que el servidor avisa apenas llega un correo, en vez de
 * que uno pregunte cada tanto; imapflow lo activa solo mientras la conexión no
 * esté ocupada. Cuando llega el aviso, se sincroniza ese hogar.
 *
 * Hay además un sondeo de respaldo cada cierto rato. No es redundancia por si
 * acaso: una conexión IDLE se cae en silencio más seguido de lo que uno
 * quisiera —un proxy que corta lo que lleva mucho rato quieto, el servidor que
 * recicla conexiones—, y un aviso que no llega no se nota hasta que alguien
 * revisa por qué no aparecen los gastos.
 */

/** Espera tras el aviso, para que una tanda de correos se sincronice de una vez. */
const ESPERA_POR_DEFECTO_MS = 10_000;
let esperaMs = ESPERA_POR_DEFECTO_MS;

/** Reintentos de reconexión: 5s, 15s, 45s… hasta 5 minutos. */
const REINTENTO_BASE_MS = 5_000;
const REINTENTO_MAXIMO_MS = 5 * 60_000;

type Vigilancia = {
  cuenta: CuentaImap & { householdId: string };
  cliente: ImapFlow | null;
  temporizador: NodeJS.Timeout | null;
  intentos: number;
  cerrado: boolean;
};

const vigilancias = new Map<string, Vigilancia>();
let sondeo: NodeJS.Timeout | null = null;
let sincronizando = new Set<string>();

/**
 * Sincroniza un hogar cuidando de no pisarse con otra sincronización en curso.
 * Sin esto, dos avisos seguidos podrían insertar el mismo correo dos veces: la
 * deduplicación consulta la base antes de escribir, y entre la consulta de una
 * y la escritura de la otra hay una ventana.
 */
async function sincronizar(householdId: string, motivo: string): Promise<void> {
  if (sincronizando.has(householdId)) return;
  sincronizando.add(householdId);
  try {
    const resultado = await sincronizarImap(householdId);
    if (resultado.imported > 0) {
      console.log(`Correo (${motivo}): ${resultado.imported} movimientos nuevos en el hogar ${householdId}.`);
    }
    for (const error of resultado.errors) console.error(`Correo (${motivo}): ${error}`);
  } catch (err) {
    console.error(`Correo (${motivo}): ${explicarErrorImap(err)}`);
  } finally {
    sincronizando.delete(householdId);
  }
}

function programarSincronizacion(v: Vigilancia): void {
  if (v.temporizador) clearTimeout(v.temporizador);
  v.temporizador = setTimeout(() => {
    v.temporizador = null;
    void sincronizar(v.cuenta.householdId, 'aviso del buzón');
  }, esperaMs);
  v.temporizador.unref();
}

async function abrir(v: Vigilancia): Promise<void> {
  if (v.cerrado) return;

  try {
    const cliente = await conectar(v.cuenta, secretoDe(v.cuenta.id));
    v.cliente = cliente;
    v.intentos = 0;

    // Sin cerrojo: esta conexión no ejecuta comandos, sólo escucha, y tomar el
    // cerrojo impediría que imapflow entre en IDLE.
    await cliente.mailboxOpen(v.cuenta.carpeta, { readOnly: true });
    console.log(`Correo: escuchando ${v.cuenta.email} en tiempo real.`);

    cliente.on('exists', () => programarSincronizacion(v));

    // 'close' cubre tanto la caída como el cierre ordenado del servidor.
    cliente.on('close', () => {
      if (v.cerrado) return;
      v.cliente = null;
      reintentar(v);
    });

    // Sin este manejador, un error de socket tumba el proceso entero.
    cliente.on('error', (err: Error) => {
      console.error(`Correo (${v.cuenta.email}): ${explicarErrorImap(err)}`);
    });
  } catch (err) {
    console.error(`Correo (${v.cuenta.email}): ${explicarErrorImap(err)}`);
    reintentar(v);
  }
}

function reintentar(v: Vigilancia): void {
  if (v.cerrado) return;
  v.intentos += 1;
  const espera = Math.min(REINTENTO_BASE_MS * 3 ** (v.intentos - 1), REINTENTO_MAXIMO_MS);
  const t = setTimeout(() => void abrir(v), espera);
  t.unref();
}

/**
 * Arranca la escucha de todas las cuentas configuradas.
 *
 * Es seguro llamarla varias veces: reconcilia contra lo que ya está escuchando,
 * así que sirve tanto al arrancar el servidor como después de conectar o
 * desconectar una cuenta.
 */
export function vigilarCorreo(sondeoMinutos = 15, espera = ESPERA_POR_DEFECTO_MS): void {
  esperaMs = espera;
  const actuales = new Map(cuentasDeTodosLosHogares().map((c) => [c.id, c]));

  // Cuentas que ya no están: se cierran.
  for (const [id, v] of vigilancias) {
    if (!actuales.has(id)) {
      v.cerrado = true;
      if (v.temporizador) clearTimeout(v.temporizador);
      void v.cliente?.logout().catch(() => undefined);
      vigilancias.delete(id);
    }
  }

  // Cuentas nuevas: se abren.
  for (const [id, cuenta] of actuales) {
    if (vigilancias.has(id)) continue;
    const v: Vigilancia = { cuenta, cliente: null, temporizador: null, intentos: 0, cerrado: false };
    vigilancias.set(id, v);
    void abrir(v);
  }

  if (sondeo) clearInterval(sondeo);
  if (actuales.size === 0) {
    sondeo = null;
    return;
  }

  sondeo = setInterval(
    () => {
      for (const householdId of new Set([...actuales.values()].map((c) => c.householdId))) {
        void sincronizar(householdId, 'sondeo de respaldo');
      }
    },
    Math.max(1, sondeoMinutos) * 60_000,
  );
  sondeo.unref();
}

/** Cierra todo. Existe para las pruebas y para un apagado ordenado. */
export async function detenerVigilancia(): Promise<void> {
  if (sondeo) clearInterval(sondeo);
  sondeo = null;
  for (const v of vigilancias.values()) {
    v.cerrado = true;
    if (v.temporizador) clearTimeout(v.temporizador);
    await v.cliente?.logout().catch(() => undefined);
  }
  vigilancias.clear();
}

/** Para la pantalla de ajustes: qué cuentas están efectivamente escuchando. */
export function cuentasEscuchando(): string[] {
  return [...vigilancias.values()].filter((v) => v.cliente !== null).map((v) => v.cuenta.email);
}

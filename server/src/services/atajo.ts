import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, uid } from '../lib/db.js';

/**
 * Las llaves con las que un Atajo de iOS anota una compra.
 *
 * Por qué existe esto: Banco Falabella no manda correo por las compras con
 * tarjeta, sólo por transferencias, así que el camino por IMAP —que ya funciona
 * para todo lo demás— no las ve. Lo único que las ve en el momento es el iPhone
 * mismo: al pagar con una tarjeta de Apple Wallet, iOS dispara una
 * automatización de Atajos que entrega monto y comercio. Desde ahí, un POST.
 *
 * Un Atajo no tiene sesión, no guarda cookies y no sabe renovar un token, así
 * que hace falta una llave larga y estable. Las reglas que la hacen defendible:
 *
 *  - Se guarda el hash y no la llave. Llevarse la base no es llevarse una llave.
 *  - Sólo puede hacer una cosa: crear un movimiento. No lee, no borra, no toca
 *    sueldos ni cierra meses. Si se filtra, lo peor que pasa es que alguien
 *    ensucie la lista con gastos inventados, que se borran.
 *  - Se compara en tiempo constante. Comparar hashes con `===` filtra, por el
 *    tiempo que tarda, cuántos caracteres iniciales acertó quien prueba.
 */

/** Prefijo visible para reconocer la llave si aparece pegada en otra parte. */
const PREFIJO = 'mh_';

export type ClaveAtajo = {
  id: string;
  nombre: string;
  cola: string;
  createdAt: string;
  lastUsedAt: string | null;
  revocadaAt: string | null;
};

function hashear(secreto: string): string {
  return createHash('sha256').update(secreto).digest('hex');
}

export function crearClave(householdId: string, userId: string, nombre: string): { clave: string; id: string } {
  // 32 bytes en base64url: suficiente para que no tenga sentido probar al azar.
  const secreto = PREFIJO + randomBytes(32).toString('base64url');
  const id = uid();
  db.prepare(
    `INSERT INTO claves_atajo (id, household_id, user_id, nombre, hash, cola)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, householdId, userId, nombre.trim() || 'Atajo del iPhone', hashear(secreto), secreto.slice(-4));
  return { clave: secreto, id };
}

export function listarClaves(householdId: string, userId: string): ClaveAtajo[] {
  return db
    .prepare(
      `SELECT id, nombre, cola, created_at AS createdAt, last_used_at AS lastUsedAt, revocada_at AS revocadaAt
         FROM claves_atajo
        WHERE household_id = ? AND user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(householdId, userId) as ClaveAtajo[];
}

export function revocarClave(id: string, householdId: string, userId: string): boolean {
  const r = db
    .prepare(
      `UPDATE claves_atajo SET revocada_at = datetime('now')
        WHERE id = ? AND household_id = ? AND user_id = ? AND revocada_at IS NULL`,
    )
    .run(id, householdId, userId);
  return r.changes > 0;
}

/**
 * Quién es el dueño de esta llave, si es que vale.
 *
 * La comparación va en tiempo constante sobre el hash. Se recorren todas las
 * llaves vivas en vez de buscar por índice: con dos personas y una llave cada
 * una eso no cuesta nada, y buscar por hash en la base dejaría el mismo canal
 * de tiempo abierto en el motor de SQLite.
 */
export function duenoDeLaClave(secreto: string): { householdId: string; userId: string; id: string } | null {
  if (!secreto.startsWith(PREFIJO)) return null;
  const buscado = Buffer.from(hashear(secreto), 'hex');

  const filas = db
    .prepare(
      `SELECT id, household_id AS householdId, user_id AS userId, hash
         FROM claves_atajo WHERE revocada_at IS NULL`,
    )
    .all() as { id: string; householdId: string; userId: string; hash: string }[];

  for (const fila of filas) {
    const candidato = Buffer.from(fila.hash, 'hex');
    if (candidato.length === buscado.length && timingSafeEqual(candidato, buscado)) {
      db.prepare("UPDATE claves_atajo SET last_used_at = datetime('now') WHERE id = ?").run(fila.id);
      return { householdId: fila.householdId, userId: fila.userId, id: fila.id };
    }
  }
  return null;
}

/**
 * Lo que manda el Atajo, normalizado.
 *
 * El monto llega como lo escribe iOS y eso varía con la región del teléfono:
 * "38.450", "38450", "$38.450", "38,450.00". Acá se resuelve una sola vez, y
 * mal resuelto significa anotar mil pesos como un millón, así que va con su
 * propia prueba.
 */
export function leerMonto(bruto: string | number): number | null {
  if (typeof bruto === 'number') return Number.isFinite(bruto) && bruto > 0 ? Math.round(bruto) : null;

  const limpio = String(bruto).replace(/[^\d.,-]/g, '').trim();
  if (!limpio) return null;

  /*
   * Cuál de los dos separadores son los decimales.
   *
   * En Chile el punto agrupa los miles y la coma separa los decimales, pero un
   * iPhone configurado en inglés manda lo contrario. La regla que funciona para
   * los dos: el separador que aparece más a la derecha es el decimal, siempre
   * que le sigan uno o dos dígitos. Si le siguen tres, es de miles.
   */
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  const corte = Math.max(ultimaComa, ultimoPunto);
  let normalizado: string;
  if (corte === -1) {
    normalizado = limpio;
  } else {
    const decimales = limpio.length - corte - 1;
    normalizado =
      decimales >= 1 && decimales <= 2
        ? limpio.slice(0, corte).replace(/[.,]/g, '') + '.' + limpio.slice(corte + 1)
        : limpio.replace(/[.,]/g, '');
  }

  const n = Number(normalizado);
  if (!Number.isFinite(n) || n <= 0) return null;
  // El peso chileno no tiene decimales; los que vengan se redondean acá y no
  // en la pantalla, para que lo guardado y lo mostrado nunca discrepen.
  return Math.round(n);
}

/**
 * Limpia el nombre del comercio que manda Apple.
 *
 * Llega con ruido: sufijos de país, la ciudad pegada, códigos de terminal. Lo
 * que queda tiene que servirle a las reglas de categorización que ya existen,
 * que buscan texto dentro del nombre.
 */
export function leerComercio(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const limpio = bruto
    .replace(/\s+/g, ' ')
    .replace(/\s+(CHL|CHILE)\s*$/i, '')
    .trim();
  return limpio.length > 0 ? limpio.slice(0, 120) : null;
}

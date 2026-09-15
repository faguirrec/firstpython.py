/**
 * Traducción de la búsqueda estilo Gmail a algo que entienda un servidor IMAP.
 *
 * Las reglas guardan su búsqueda en la sintaxis de Gmail (`from:(banco.cl)
 * newer_than:60d`) porque es la que uno puede probar pegándola en el buscador
 * de Gmail antes de guardarla. IMAP no habla ese idioma, así que hay que
 * traducir.
 *
 * La traducción es deliberadamente parcial: al servidor se le pide sólo lo que
 * sabe hacer rápido y sin ambigüedad —el rango de fechas y, cuando se puede, el
 * remitente— y el resto se filtra en memoria. Pedirle de más a un servidor IMAP
 * es la forma segura de que cada uno responda distinto.
 */

export type Consulta = {
  /** Grupos en AND; dentro de cada grupo, los valores están en OR. */
  remitentes: string[];
  asuntos: string[];
  texto: string[];
  /** Sólo correos posteriores a esta fecha. */
  desde: Date | null;
};

const UNIDADES: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/** Separa "a OR b" o "a, b" dentro de un paréntesis; también acepta un valor suelto. */
function valores(bruto: string): string[] {
  return bruto
    .replace(/^\(|\)$/g, '')
    .split(/\s+OR\s+|,/i)
    .map((v) => v.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function interpretarConsulta(consulta: string, ahora = new Date()): Consulta {
  const resultado: Consulta = { remitentes: [], asuntos: [], texto: [], desde: null };

  // Los operadores admiten paréntesis, comillas o una palabra suelta.
  const operador = /(from|to|subject|newer_than|older_than):(\([^)]*\)|"[^"]*"|\S+)/gi;
  let resto = consulta;

  for (const m of consulta.matchAll(operador)) {
    const clave = m[1].toLowerCase();
    const bruto = m[2];
    resto = resto.replace(m[0], ' ');

    if (clave === 'from') resultado.remitentes.push(...valores(bruto));
    else if (clave === 'subject') resultado.asuntos.push(...valores(bruto));
    else if (clave === 'newer_than') {
      const edad = /^(\d+)([dwmy])$/i.exec(bruto);
      if (edad) {
        const dias = Number(edad[1]) * UNIDADES[edad[2].toLowerCase()];
        resultado.desde = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
      }
    }
    // `to:` y `older_than:` se reconocen para sacarlos del texto libre, pero no
    // se aplican: en un buzón propio `to:` es casi siempre uno mismo, y el
    // límite superior de fecha no aporta cuando ya se pide "los más nuevos".
  }

  // Lo que sobra son palabras sueltas que deben aparecer en algún lado.
  resultado.texto = resto
    .split(/\s+/)
    .map((v) => v.trim().replace(/^"|"$/g, ''))
    .filter((v) => v && !/^(and|or)$/i.test(v));

  return resultado;
}

/**
 * Lo que se le pide al servidor. Sólo la fecha y, si hay un único remitente, ese
 * remitente: con varios en OR, cada servidor implementa la combinación distinto
 * y sale más barato traer un poco de más y filtrar acá.
 */
export function criteriosImap(consulta: Consulta): { since?: Date; from?: string } {
  const criterios: { since?: Date; from?: string } = {};
  // Sin rango, un buzón viejo se recorrería entero en cada sincronización.
  criterios.since = consulta.desde ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (consulta.remitentes.length === 1) criterios.from = consulta.remitentes[0];
  return criterios;
}

function algunoCalza(valores: string[], texto: string): boolean {
  if (valores.length === 0) return true;
  const minuscula = texto.toLowerCase();
  return valores.some((v) => minuscula.includes(v.toLowerCase()));
}

/**
 * Filtro por encabezados solamente. Es una condición necesaria —los operadores
 * van en AND—, así que sirve para descartar sin bajar el cuerpo del correo, que
 * es lo caro por IMAP.
 */
export function calzaEncabezado(consulta: Consulta, correo: { from: string; subject: string }): boolean {
  return algunoCalza(consulta.remitentes, correo.from) && algunoCalza(consulta.asuntos, correo.subject);
}

/**
 * El filtro fino, ya con el correo en la mano.
 *
 * La fecha se vuelve a comprobar acá aunque ya se le haya pedido al servidor:
 * el `SINCE` de IMAP mira la fecha en que el mensaje entró a la carpeta, no la
 * del correo. Un correo viejo movido de carpeta —o un buzón migrado de
 * proveedor— entra como si fuera de hoy, y sin esta comprobación se importarían
 * gastos de hace años.
 */
export function calza(
  consulta: Consulta,
  correo: { from: string; subject: string; body: string; fecha?: Date },
): boolean {
  if (consulta.desde && correo.fecha && correo.fecha < consulta.desde) return false;
  if (!algunoCalza(consulta.remitentes, correo.from)) return false;
  if (!algunoCalza(consulta.asuntos, correo.subject)) return false;
  // Las palabras sueltas van en AND, como en Gmail, y buscan en todo el correo.
  const todo = `${correo.from}\n${correo.subject}\n${correo.body}`.toLowerCase();
  return consulta.texto.every((palabra) => todo.includes(palabra.toLowerCase()));
}

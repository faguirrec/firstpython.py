/**
 * Lo personal es privado.
 *
 * Un hogar comparte los gastos comunes, no las finanzas de cada uno. Los
 * movimientos marcados como personales pertenecen a quien los registró y nadie
 * más los ve: ni en la lista de movimientos, ni en los reportes, ni sumados en
 * un total.
 *
 * La regla vive acá y en un solo lugar a propósito. Repartida por cada consulta
 * sería cosa de tiempo que alguna nueva se olvide de aplicarla, y una fuga de
 * este tipo no se nota mirando la pantalla: los números simplemente vienen un
 * poco más altos de lo que corresponde.
 *
 * Las consultas que la usan tienen que pasar sus parámetros **por nombre**
 * (`{ yo: userId, ... }`), no por posición.
 */

/**
 * Predicado SQL: la fila es común, o es personal y mía.
 *
 * @param alias prefijo de la tabla de transacciones en la consulta ('t' o '').
 */
export function soloMisMovimientos(alias = 't'): string {
  const p = alias ? `${alias}.` : '';
  // Los personales sin dueño son de antes de que lo personal fuera privado.
  // Se dejan a la vista de los dos, como estaban: hacerlos desaparecer de
  // ambas pantallas sería peor que la fuga que se está cerrando, y no hay
  // forma de adivinar de quién era cada uno. Los nuevos siempre nacen con
  // dueño, así que esta rama se va vaciando sola.
  return `(${p}scope = 'comun' OR ${p}user_id = @yo OR ${p}user_id IS NULL)`;
}

/**
 * Ámbito de análisis: las cuentas del hogar, o las de una persona.
 *
 * Es la misma app mirando dos bolsillos distintos. Presupuestos, metas y
 * comparaciones existen en los dos, y lo único que cambia entre uno y otro es
 * qué movimientos se cuentan.
 */
export type Ambito = { tipo: 'hogar' } | { tipo: 'personal'; userId: string };

export const HOGAR: Ambito = { tipo: 'hogar' };

export function personal(userId: string): Ambito {
  return { tipo: 'personal', userId };
}

/** Predicado sobre gastos, según el ámbito. Usa el parámetro nombrado @duenio. */
export function filtroGastos(ambito: Ambito, alias = 't'): string {
  const p = alias ? `${alias}.` : '';
  return ambito.tipo === 'hogar'
    ? `${p}type = 'gasto' AND ${p}scope = 'comun'`
    : `${p}type = 'gasto' AND ${p}scope = 'personal' AND ${p}user_id = @duenio`;
}

/** Los parámetros nombrados que exige el predicado de arriba. */
export function paramsAmbito(ambito: Ambito): Record<string, unknown> {
  return ambito.tipo === 'hogar' ? {} : { duenio: ambito.userId };
}

/**
 * Columna por la que filtrar presupuestos y metas: los del hogar no tienen
 * dueño, los personales sí.
 */
export function filtroDuenio(ambito: Ambito, alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return ambito.tipo === 'hogar' ? `${p}user_id IS NULL` : `${p}user_id = @duenio`;
}

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
 * Predicado para las consultas que además distinguen el ámbito de análisis:
 * las cuentas del hogar (lo común) o las de una persona (lo suyo).
 */
export type Ambito = 'hogar' | 'personal';

export function filtroAmbito(ambito: Ambito, alias = 't'): string {
  const p = alias ? `${alias}.` : '';
  return ambito === 'hogar'
    ? `${p}scope = 'comun'`
    : `(${p}scope = 'personal' AND ${p}user_id = @yo)`;
}

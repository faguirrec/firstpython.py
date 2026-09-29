/**
 * Dar por cumplido lo que se esperaba, cruzándolo con lo que de verdad pasó.
 *
 * Es el corazón de los gastos fijos y del plan del mes: los dos declaran que
 * algo se espera, y ninguno de los dos crea movimientos. Lo que convierte una
 * expectativa en "ya está" es encontrarle un movimiento real que le calce.
 *
 * El cruce es a propósito conservador. Un movimiento calza si cae en la misma
 * categoría y, cuando lo esperado define un texto, si el comercio o la glosa lo
 * mencionan. Sin categoría ni texto no hay con qué reconocerlo y se deja
 * pendiente, antes que dar por pagado cualquier cosa. Cada movimiento se usa una
 * sola vez, así dos cuentas de la misma categoría no se dan por pagadas con un
 * solo cargo.
 */

export type MovimientoCalzable = {
  id: string;
  amount: number;
  occurredOn: string;
  merchant: string | null;
  description: string | null;
  categoryId: string | null;
};

export type Esperado = {
  categoryId: string | null;
  matchText: string | null;
};

/**
 * Para cada cosa esperada, el movimiento que la da por cumplida —o null.
 *
 * Devuelve un arreglo en el mismo orden que `esperados`, y no un mapa por id,
 * porque quien llama ya tiene sus filas ordenadas y lo único que necesita es
 * saber, renglón por renglón, si apareció.
 */
export function calzarConMovimientos(
  esperados: readonly Esperado[],
  movimientos: readonly MovimientoCalzable[],
): (MovimientoCalzable | null)[] {
  const usados = new Set<string>();

  return esperados.map((e) => {
    const texto = e.matchText?.trim().toLowerCase();

    const calce = movimientos.find((m) => {
      if (usados.has(m.id)) return false;
      if (e.categoryId && m.categoryId !== e.categoryId) return false;
      if (texto) {
        const donde = `${m.merchant ?? ''} ${m.description ?? ''}`.toLowerCase();
        if (!donde.includes(texto)) return false;
      }
      return Boolean(e.categoryId || texto);
    });

    if (calce) usados.add(calce.id);
    return calce ?? null;
  });
}

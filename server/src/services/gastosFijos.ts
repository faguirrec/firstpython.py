import { db, uid } from '../lib/db.js';
import { round2 } from './split.js';

/**
 * Gastos fijos del hogar: el arriendo, las cuentas, las suscripciones.
 *
 * Lo importante del diseño está en lo que **no** hace: no crea movimientos. Un
 * gasto fijo declara que algo se espera, no que ocurrió. Si la app los diera
 * por pagados sola, el mes mostraría plata que quizá nadie transfirió todavía,
 * y encima chocarían con los que entran solos desde el correo.
 *
 * En vez de eso cruza lo declarado con los movimientos reales del mes. De ahí
 * sale la pregunta que uno se hace a mitad de mes: qué falta por pagar.
 */

export type GastoFijo = {
  id: string;
  name: string;
  /** Null cuando el monto cambia mes a mes. */
  amount: number | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  dueDay: number | null;
  matchText: string | null;
  active: boolean;
};

export type EstadoGastoFijo = GastoFijo & {
  /** Lo que se espera pagar: el monto declarado o el promedio de lo pagado. */
  expected: number;
  /** De dónde salió esa cifra, para que la pantalla no muestre un número mudo. */
  expectedFrom: 'declarado' | 'promedio' | 'sin-datos';
  /** El movimiento del mes que lo da por pagado, si hay alguno. */
  paidWith: { id: string; amount: number; occurredOn: string; merchant: string | null } | null;
  paid: boolean;
};

export type EstadoMes = {
  month: string;
  items: EstadoGastoFijo[];
  /** Total esperado del mes, pagado o no. */
  totalExpected: number;
  totalPaid: number;
  totalPending: number;
  pendientes: EstadoGastoFijo[];
};

type Fila = {
  id: string;
  name: string;
  amount: number | null;
  category_id: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  due_day: number | null;
  match_text: string | null;
  active: number;
};

const SELECT = `
  SELECT f.id, f.name, f.amount, f.category_id, f.due_day, f.match_text, f.active,
         c.name AS categoryName, c.emoji AS categoryEmoji
    FROM fixed_expenses f
    LEFT JOIN categories c ON c.id = f.category_id
`;

function aGastoFijo(f: Fila): GastoFijo {
  return {
    id: f.id,
    name: f.name,
    amount: f.amount,
    categoryId: f.category_id,
    categoryName: f.categoryName,
    categoryEmoji: f.categoryEmoji,
    dueDay: f.due_day,
    matchText: f.match_text,
    active: f.active === 1,
  };
}

export function listarGastosFijos(householdId: string): GastoFijo[] {
  return (
    db.prepare(`${SELECT} WHERE f.household_id = ? ORDER BY f.due_day, f.name`).all(householdId) as Fila[]
  ).map(aGastoFijo);
}

/** Promedio de lo que se pagó en meses anteriores, para los de monto variable. */
function promedioHistorico(householdId: string, fijo: Fila, hasta: string): number | null {
  if (!fijo.category_id) return null;
  const fila = db
    .prepare(
      `SELECT AVG(total) AS promedio FROM (
          SELECT SUM(amount) AS total FROM transactions
           WHERE household_id = @hogar AND category_id = @categoria
             AND type = 'gasto' AND scope = 'comun'
             AND substr(occurred_on, 1, 7) < @hasta
           GROUP BY substr(occurred_on, 1, 7)
           ORDER BY substr(occurred_on, 1, 7) DESC
           LIMIT 3)`,
    )
    .get({ hogar: householdId, categoria: fijo.category_id, hasta }) as { promedio: number | null };
  return fila.promedio;
}

/**
 * Qué se espera este mes y qué se pagó ya.
 *
 * El cruce es a propósito conservador: un movimiento da por pagado un gasto
 * fijo si cae en su misma categoría y, cuando el gasto define un texto, si el
 * comercio o la glosa lo mencionan. Cada movimiento se usa una sola vez, así
 * dos cuentas de la misma categoría no se dan por pagadas con un solo cargo.
 */
export function estadoDelMes(householdId: string, month: string): EstadoMes {
  const fijos = db
    .prepare(`${SELECT} WHERE f.household_id = ? AND f.active = 1 ORDER BY f.due_day, f.name`)
    .all(householdId) as Fila[];

  const movimientos = db
    .prepare(
      `SELECT id, amount, occurred_on AS occurredOn, merchant, description, category_id AS categoryId
         FROM transactions
        WHERE household_id = ? AND occurred_on LIKE ?
          AND type = 'gasto' AND scope = 'comun'
        ORDER BY occurred_on`,
    )
    .all(householdId, `${month}-%`) as {
    id: string;
    amount: number;
    occurredOn: string;
    merchant: string | null;
    description: string | null;
    categoryId: string | null;
  }[];

  const usados = new Set<string>();

  const items: EstadoGastoFijo[] = fijos.map((f) => {
    const texto = f.match_text?.trim().toLowerCase();

    const calce = movimientos.find((m) => {
      if (usados.has(m.id)) return false;
      if (f.category_id && m.categoryId !== f.category_id) return false;
      if (texto) {
        const donde = `${m.merchant ?? ''} ${m.description ?? ''}`.toLowerCase();
        if (!donde.includes(texto)) return false;
      }
      // Sin categoría ni texto no hay con qué reconocerlo; se deja pendiente
      // antes que dar por pagado cualquier cosa.
      return Boolean(f.category_id || texto);
    });

    if (calce) usados.add(calce.id);

    let expected = f.amount;
    let expectedFrom: EstadoGastoFijo['expectedFrom'] = 'declarado';
    if (expected == null) {
      const promedio = promedioHistorico(householdId, f, month);
      expected = promedio;
      expectedFrom = promedio == null ? 'sin-datos' : 'promedio';
    }
    // Si ya se pagó, lo que vale es lo que se pagó de verdad.
    if (calce) {
      expected = calce.amount;
      expectedFrom = 'declarado';
    }

    return {
      ...aGastoFijo(f),
      expected: round2(expected ?? 0),
      expectedFrom,
      paidWith: calce
        ? { id: calce.id, amount: calce.amount, occurredOn: calce.occurredOn, merchant: calce.merchant }
        : null,
      paid: Boolean(calce),
    };
  });

  const totalExpected = items.reduce((a, b) => a + b.expected, 0);
  const totalPaid = items.filter((i) => i.paid).reduce((a, b) => a + b.expected, 0);
  const pendientes = items.filter((i) => !i.paid);

  return {
    month,
    items,
    totalExpected: round2(totalExpected),
    totalPaid: round2(totalPaid),
    totalPending: round2(totalExpected - totalPaid),
    pendientes,
  };
}

export function crearGastoFijo(
  householdId: string,
  datos: {
    name: string;
    amount?: number | null;
    categoryId?: string | null;
    dueDay?: number | null;
    matchText?: string | null;
  },
): string {
  const id = uid();
  db.prepare(
    `INSERT INTO fixed_expenses (id, household_id, name, amount, category_id, due_day, match_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, householdId, datos.name, datos.amount ?? null, datos.categoryId ?? null,
    datos.dueDay ?? null, datos.matchText ?? null,
  );
  return id;
}

export function actualizarGastoFijo(
  householdId: string,
  id: string,
  datos: {
    name?: string;
    amount?: number | null;
    categoryId?: string | null;
    dueDay?: number | null;
    matchText?: string | null;
    active?: boolean;
  },
): void {
  db.prepare(
    `UPDATE fixed_expenses SET
        name = COALESCE(@name, name),
        amount = CASE WHEN @tocaMonto = 1 THEN @amount ELSE amount END,
        category_id = CASE WHEN @tocaCategoria = 1 THEN @categoryId ELSE category_id END,
        due_day = CASE WHEN @tocaDia = 1 THEN @dueDay ELSE due_day END,
        match_text = CASE WHEN @tocaTexto = 1 THEN @matchText ELSE match_text END,
        active = COALESCE(@active, active)
      WHERE id = @id AND household_id = @hogar`,
  ).run({
    id,
    hogar: householdId,
    name: datos.name ?? null,
    // Estos campos aceptan null como valor válido —"el monto cambia cada mes"—,
    // así que hace falta distinguir "lo mando en null" de "no lo mando".
    tocaMonto: 'amount' in datos ? 1 : 0,
    amount: datos.amount ?? null,
    tocaCategoria: 'categoryId' in datos ? 1 : 0,
    categoryId: datos.categoryId ?? null,
    tocaDia: 'dueDay' in datos ? 1 : 0,
    dueDay: datos.dueDay ?? null,
    tocaTexto: 'matchText' in datos ? 1 : 0,
    matchText: datos.matchText ?? null,
    active: datos.active === undefined ? null : datos.active ? 1 : 0,
  });
}

export function borrarGastoFijo(householdId: string, id: string): void {
  db.prepare('DELETE FROM fixed_expenses WHERE id = ? AND household_id = ?').run(id, householdId);
}

/**
 * Lo que se espera gastar el mes: los fijos más el promedio de lo variable.
 *
 * Es bastante más fiel que promediar el gasto total de meses anteriores, que es
 * lo que había: mezcla lo que se sabe con lo que se supone, en vez de suponerlo
 * todo.
 */
export function gastoEsperadoDelMes(householdId: string, month: string): { total: number; fijos: number } | null {
  const estado = estadoDelMes(householdId, month);
  if (estado.items.length === 0) return null;

  const categoriasFijas = new Set(estado.items.map((i) => i.categoryId).filter(Boolean));

  // Promedio mensual de lo que NO cae en las categorías de los gastos fijos.
  const variable = db
    .prepare(
      `SELECT AVG(total) AS promedio FROM (
          SELECT SUM(amount) AS total FROM transactions
           WHERE household_id = ? AND type = 'gasto' AND scope = 'comun'
             AND substr(occurred_on, 1, 7) < ?
             ${categoriasFijas.size > 0
               ? `AND (category_id IS NULL OR category_id NOT IN (${[...categoriasFijas].map(() => '?').join(',')}))`
               : ''}
           GROUP BY substr(occurred_on, 1, 7)
           ORDER BY substr(occurred_on, 1, 7) DESC
           LIMIT 3)`,
    )
    .get(householdId, month, ...categoriasFijas) as { promedio: number | null };

  return {
    total: round2(estado.totalExpected + (variable.promedio ?? 0)),
    fijos: estado.totalExpected,
  };
}

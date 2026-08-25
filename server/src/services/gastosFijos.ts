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
             AND period < @hasta
           GROUP BY period
           ORDER BY period DESC
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
        WHERE household_id = ? AND period = ?
          AND type = 'gasto' AND scope = 'comun'
        ORDER BY occurred_on`,
    )
    .all(householdId, month) as {
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
             AND period < ?
             ${categoriasFijas.size > 0
               ? `AND (category_id IS NULL OR category_id NOT IN (${[...categoriasFijas].map(() => '?').join(',')}))`
               : ''}
           GROUP BY period
           ORDER BY period DESC
           LIMIT 3)`,
    )
    .get(householdId, month, ...categoriasFijas) as { promedio: number | null };

  return {
    total: round2(estado.totalExpected + (variable.promedio ?? 0)),
    fijos: estado.totalExpected,
  };
}

/* -------------------- Detectar los fijos en el historial ------------------ */

/**
 * Un gasto fijo que la app cree reconocer en los movimientos que ya existen.
 *
 * Se propone, no se crea. Un gasto fijo es una **expectativa declarada**: dice
 * "esto se espera pagar". Si la app inventara expectativas sola, el mes
 * mostraría deudas que nadie contrajo y la proyección se llenaría de ruido que
 * nadie pidió. Lo que sí puede hacer —y es lo que ahorra el trabajo— es mirar
 * lo que ya pasó y dejar la lista lista para aceptar de un toque.
 */
export type FijoDetectado = {
  /** El comercio tal como aparece en los movimientos; sirve de nombre y de calce. */
  name: string;
  /** Null cuando el monto varía demasiado como para dar una cifra. */
  amount: number | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  categoryColor: string | null;
  dueDay: number | null;
  /** En cuántos de los meses mirados apareció. */
  meses: number;
  /** De cuántos meses con movimientos se está hablando. */
  mesesConDatos: number;
  /** Lo último que se pagó, para que la cifra no sea un número mudo. */
  ultimo: number;
};

/** "JUMBO KENNEDY  " y "Jumbo Kennedy" son el mismo comercio. */
function normalizar(texto: string): string {
  return texto.trim().toLowerCase().replace(/\s+/g, ' ');
}

function mediana(valores: number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

/**
 * ¿Cae siempre alrededor del mismo día del mes?
 *
 * Se mira la dispersión respecto de la mediana. El mes se trata como un círculo
 * —el 31 y el 1 están a dos días, no a treinta—, porque una cuenta que vence a
 * fin de mes se paga indistintamente el 30 o el 2 y no por eso deja de ser fija.
 */
export function fechaRegular(dias: number[], tolerancia = 4): boolean {
  if (dias.length < 2) return true;

  const dispersion = (valores: number[]) => {
    const centro = mediana(valores);
    return Math.max(...valores.map((d) => Math.abs(d - centro)));
  };

  // La segunda lectura corre los primeros días al final del mes, para que un
  // grupo repartido entre el 29 y el 2 se vea junto y no de punta a punta.
  const corridos = dias.map((d) => (d <= 7 ? d + 31 : d));
  return Math.min(dispersion(dias), dispersion(corridos)) <= tolerancia;
}

/**
 * Gastos fijos que se pueden reconocer en los movimientos de los últimos meses.
 *
 * El comercio es la clave, no la categoría: "Supermercado" pasa todos los meses
 * y no es un gasto fijo, mientras que "Aguas Andinas" sí lo es. Un candidato es
 * un comercio que aparece **en varios meses distintos y a lo más una vez por
 * mes**; esa segunda condición es la que deja fuera al supermercado y a la
 * bencina, que se repiten dentro del mismo mes.
 *
 * El monto se propone sólo si es estable. Para el arriendo eso es una cifra
 * exacta; para la cuenta de la luz, que cambia con la estación, es mejor
 * dejarlo en blanco y que la app use el promedio: una cifra inventada se vería
 * igual de segura que una real.
 */
export function detectarFijos(householdId: string, meses = 6): FijoDetectado[] {
  const periodos = db
    .prepare(
      `SELECT DISTINCT period FROM transactions
        WHERE household_id = ? AND type = 'gasto' AND scope = 'comun'
        ORDER BY period DESC LIMIT ?`,
    )
    .all(householdId, meses) as { period: string }[];

  // Con uno o dos meses no hay repetición que observar, y proponer a partir de
  // eso sería adivinar en voz alta.
  if (periodos.length < 2) return [];
  const desde = periodos[periodos.length - 1].period;

  const movimientos = db
    .prepare(
      `SELECT t.period, t.amount, t.occurred_on AS occurredOn, t.merchant, t.description,
              t.category_id AS categoryId, c.name AS categoryName, c.emoji AS categoryEmoji,
              c.color AS categoryColor
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ? AND t.type = 'gasto' AND t.scope = 'comun'
          AND t.period >= ?
        ORDER BY t.period`,
    )
    .all(householdId, desde) as {
    period: string;
    amount: number;
    occurredOn: string;
    merchant: string | null;
    description: string | null;
    categoryId: string | null;
    categoryName: string | null;
    categoryEmoji: string | null;
    categoryColor: string | null;
  }[];

  // Lo que ya está declarado no se vuelve a proponer, se llame como se llame.
  const yaDeclarados = new Set(
    (db
      .prepare('SELECT name, match_text AS matchText FROM fixed_expenses WHERE household_id = ?')
      .all(householdId) as { name: string; matchText: string | null }[])
      .flatMap((f) => [normalizar(f.name), f.matchText ? normalizar(f.matchText) : ''])
      .filter(Boolean),
  );

  type Grupo = {
    nombre: string;
    porMes: Map<string, number[]>;
    dias: number[];
    categorias: Map<string, { id: string; name: string | null; emoji: string | null; color: string | null; veces: number }>;
    ultimo: number;
  };
  const grupos = new Map<string, Grupo>();

  for (const m of movimientos) {
    const bruto = m.merchant ?? m.description;
    // Sin comercio no hay con qué reconocerlo después: el calce del mes mira el
    // comercio y la glosa, y un fijo que no calza con nada queda pendiente para
    // siempre.
    if (!bruto || bruto.trim().length < 3) continue;
    const clave = normalizar(bruto);
    if (yaDeclarados.has(clave)) continue;

    const grupo: Grupo = grupos.get(clave) ?? {
      nombre: bruto.trim(),
      porMes: new Map(),
      dias: [],
      categorias: new Map(),
      ultimo: 0,
    };
    grupo.porMes.set(m.period, [...(grupo.porMes.get(m.period) ?? []), m.amount]);
    grupo.dias.push(Number(m.occurredOn.slice(8, 10)));
    grupo.ultimo = m.amount;
    if (m.categoryId) {
      const c = grupo.categorias.get(m.categoryId) ?? {
        id: m.categoryId, name: m.categoryName, emoji: m.categoryEmoji, color: m.categoryColor, veces: 0,
      };
      c.veces += 1;
      grupo.categorias.set(m.categoryId, c);
    }
    grupos.set(clave, grupo);
  }

  const conDatos = periodos.length;
  // Con pocos meses basta que se repita en todos; con historia larga, en la
  // mayoría —una cuenta puede haberse pagado tarde y saltarse un período—.
  const minimoMeses = conDatos <= 3 ? 2 : Math.ceil(conDatos * 0.6);

  const candidatos: FijoDetectado[] = [];

  for (const grupo of grupos.values()) {
    const mesesVistos = grupo.porMes.size;
    if (mesesVistos < minimoMeses) continue;

    // Más de una vez por mes es un gasto corriente, no una cuenta que llega.
    const vecesTotales = [...grupo.porMes.values()].reduce((a, b) => a + b.length, 0);
    if (vecesTotales > mesesVistos * 1.4) continue;

    /*
     * Y tiene que llegar siempre por la misma fecha.
     *
     * Es la señal que separa una cuenta de un gasto corriente que se repite:
     * el arriendo se paga el 4, el internet el 10, Netflix el 20, porque hay un
     * ciclo de facturación detrás. Ir al supermercado una vez al mes también se
     * repite, pero cae cualquier día. Sin esta condición la lista proponía la
     * feria y la bencina junto al arriendo, y una lista así hay que revisarla
     * entera —que es exactamente el trabajo que se quería ahorrar—.
     */
    if (!fechaRegular(grupo.dias)) continue;

    // Un monto por mes: si en algún mes hubo dos cargos, se suman.
    const porMes = [...grupo.porMes.values()].map((v) => v.reduce((a, b) => a + b, 0));
    const centro = mediana(porMes);
    const desvio = centro > 0 ? Math.max(...porMes.map((v) => Math.abs(v - centro))) / centro : 1;

    const categoria = [...grupo.categorias.values()].sort((a, b) => b.veces - a.veces)[0] ?? null;

    candidatos.push({
      name: grupo.nombre,
      // Hasta un 15% de diferencia sigue siendo "el mismo monto todos los
      // meses"; más que eso, mejor no decir una cifra.
      amount: desvio <= 0.15 ? round2(centro) : null,
      categoryId: categoria?.id ?? null,
      categoryName: categoria?.name ?? null,
      categoryEmoji: categoria?.emoji ?? null,
      categoryColor: categoria?.color ?? null,
      dueDay: grupo.dias.length ? Math.round(mediana(grupo.dias)) : null,
      meses: mesesVistos,
      mesesConDatos: conDatos,
      ultimo: round2(grupo.ultimo),
    });
  }

  // Los más grandes primero: son los que mueven la proyección del mes.
  return candidatos.sort((a, b) => (b.amount ?? b.ultimo) - (a.amount ?? a.ultimo));
}

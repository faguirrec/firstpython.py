import { db, uid } from '../lib/db.js';
import { round2 } from './split.js';
import { calzarConMovimientos, type MovimientoCalzable } from './calce.js';
import { promedioDeLoQueCalzo } from './gastosFijos.js';

/**
 * El plan del mes: lo que se espera gastar en un mes concreto.
 *
 * Los gastos fijos son la **plantilla** —"esto pasa todos los meses"— y esto es
 * la **instancia** de un mes en particular. Nace de la plantilla más lo que se
 * gastó el mes pasado, y desde ahí se edita libre: que en octubre el arriendo
 * suba, que este mes además venga la patente, que la suscripción se dio de
 * baja. Nada de eso toca la plantilla ni los meses ya pasados.
 *
 * Sigue sin crear movimientos, por la misma razón de siempre: un plan dice que
 * algo se espera, no que ocurrió. Mientras nadie pague, el saldo de la cuenta no
 * se mueve y el reparto no le cobra nada a nadie. Lo que convierte un renglón en
 * hecho es un movimiento real —del correo, de Apple Pay o anotado a mano— y de
 * eso se encarga el cruce, no una marca que alguien tenga que acordarse de
 * poner.
 */

export type ModoRenglon = 'puntual' | 'acumulado';
export type OrigenRenglon = 'fijo' | 'anterior' | 'mano';

export type RenglonPlan = {
  id: string;
  name: string;
  /** Lo declarado en el renglón. Null cuando se deja que la app lo estime. */
  amount: number | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  categoryColor: string | null;
  dueDay: number | null;
  matchText: string | null;
  modo: ModoRenglon;
  origin: OrigenRenglon;
  /** Lo que se espera gastar: lo declarado, o el promedio si no se declaró. */
  expected: number;
  /** De dónde salió esa cifra, para que la pantalla no muestre un número mudo. */
  expectedFrom: 'declarado' | 'promedio' | 'sin-datos';
  /** Lo que de verdad se ha gastado contra este renglón. */
  gastado: number;
  /** En los puntuales, el movimiento que lo cumplió. En los acumulados, cuántos van. */
  cumplidoCon: { id: string; amount: number; occurredOn: string; merchant: string | null } | null;
  movimientos: number;
  cumplido: boolean;
};

export type Plan = {
  month: string;
  /** Si este mes tiene plan armado. Sin esto la pantalla no sabe qué ofrecer. */
  hayPlan: boolean;
  items: RenglonPlan[];
  totalEsperado: number;
  totalGastado: number;
  /** Lo que falta por gastar de lo planeado. Nunca baja de cero. */
  totalPendiente: number;
  /** Gasto real del mes que no estaba en ningún renglón del plan. */
  fueraDelPlan: number;
};

type Fila = {
  id: string;
  name: string;
  amount: number | null;
  category_id: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  categoryColor: string | null;
  due_day: number | null;
  match_text: string | null;
  modo: string;
  origin: string;
};

const SELECT = `
  SELECT p.id, p.name, p.amount, p.category_id, p.due_day, p.match_text, p.modo, p.origin,
         c.name AS categoryName, c.emoji AS categoryEmoji, c.color AS categoryColor
    FROM planned_expenses p
    LEFT JOIN categories c ON c.id = p.category_id
`;

/** Los gastos comunes del mes, que son contra los que se cruza todo. */
function gastosDelMes(householdId: string, month: string): MovimientoCalzable[] {
  return db
    .prepare(
      `SELECT id, amount, occurred_on AS occurredOn, merchant, description, category_id AS categoryId
         FROM transactions
        WHERE household_id = ? AND period = ?
          AND type = 'gasto' AND scope = 'comun'
        ORDER BY occurred_on`,
    )
    .all(householdId, month) as MovimientoCalzable[];
}

export function planDelMes(householdId: string, month: string): Plan {
  const filas = db
    .prepare(`${SELECT} WHERE p.household_id = ? AND p.period = ? ORDER BY p.due_day, p.name`)
    .all(householdId, month) as Fila[];

  const movimientos = gastosDelMes(householdId, month);

  /*
   * Primero los puntuales, después los acumulados.
   *
   * El orden importa y no es un detalle de implementación: si el supermercado
   * se llevara los movimientos primero, podría comerse el cargo que en realidad
   * pagaba una cuenta declarada, y esa cuenta quedaría eternamente pendiente. Lo
   * específico tiene prioridad sobre lo general.
   */
  const puntuales = filas.filter((f) => f.modo !== 'acumulado');
  const calces = calzarConMovimientos(
    puntuales.map((f) => ({ categoryId: f.category_id, matchText: f.match_text })),
    movimientos,
  );
  const tomados = new Map<string, MovimientoCalzable>();
  puntuales.forEach((f, i) => {
    if (calces[i]) tomados.set(f.id, calces[i]!);
  });
  const usados = new Set([...tomados.values()].map((m) => m.id));

  const items: RenglonPlan[] = filas.map((f) => {
    const acumulado = f.modo === 'acumulado';

    // Lo que queda sin reclamar en la categoría del renglón.
    const suyos = acumulado
      ? movimientos.filter((m) => !usados.has(m.id) && f.category_id != null && m.categoryId === f.category_id)
      : [];
    if (acumulado) for (const m of suyos) usados.add(m.id);

    const calce = tomados.get(f.id) ?? null;

    let expected = f.amount;
    let expectedFrom: RenglonPlan['expectedFrom'] = 'declarado';
    if (expected == null) {
      const promedio = promedioDeLoQueCalzo(
        householdId,
        { categoryId: f.category_id, matchText: f.match_text },
        month,
      );
      expected = promedio;
      expectedFrom = promedio == null ? 'sin-datos' : 'promedio';
    }

    const gastado = acumulado ? suyos.reduce((a, m) => a + m.amount, 0) : (calce?.amount ?? 0);

    /*
     * Ya pagado, lo que vale es lo que se pagó de verdad.
     *
     * Sólo para los puntuales: en un acumulado la cifra esperada es la meta del
     * mes y pisarla con lo que van gastando borraría justamente la comparación
     * que el renglón existe para hacer.
     */
    if (calce && !acumulado) {
      expected = calce.amount;
      expectedFrom = 'declarado';
    }

    return {
      id: f.id,
      name: f.name,
      amount: f.amount,
      categoryId: f.category_id,
      categoryName: f.categoryName,
      categoryEmoji: f.categoryEmoji,
      categoryColor: f.categoryColor,
      dueDay: f.due_day,
      matchText: f.match_text,
      modo: acumulado ? 'acumulado' : 'puntual',
      origin: (['fijo', 'anterior', 'mano'].includes(f.origin) ? f.origin : 'mano') as OrigenRenglon,
      expected: round2(expected ?? 0),
      expectedFrom,
      gastado: round2(gastado),
      cumplidoCon: calce
        ? { id: calce.id, amount: calce.amount, occurredOn: calce.occurredOn, merchant: calce.merchant }
        : null,
      movimientos: acumulado ? suyos.length : calce ? 1 : 0,
      // Un acumulado se da por cumplido cuando llegó a lo planeado, no con la
      // primera compra.
      cumplido: acumulado ? gastado >= (expected ?? 0) && (expected ?? 0) > 0 : Boolean(calce),
    };
  });

  const totalEsperado = items.reduce((a, b) => a + b.expected, 0);
  const totalGastado = items.reduce((a, b) => a + b.gastado, 0);
  const fueraDelPlan = movimientos.filter((m) => !usados.has(m.id)).reduce((a, m) => a + m.amount, 0);

  return {
    month,
    hayPlan: filas.length > 0,
    items,
    totalEsperado: round2(totalEsperado),
    totalGastado: round2(totalGastado),
    totalPendiente: round2(Math.max(0, totalEsperado - totalGastado)),
    fueraDelPlan: round2(fueraDelPlan),
  };
}

/* ------------------------------ Armar el mes ------------------------------ */

/** El mes anterior a uno dado, en el mismo formato. */
function mesAnterior(month: string): string {
  const [a, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type Armado = {
  creados: number;
  /** Lo que ya estaba y no se tocó, para poder decirlo en vez de callarlo. */
  yaEstaban: number;
  desde: string;
};

/**
 * Armar el plan de un mes con lo que ya se sabe.
 *
 * Dos fuentes, y las dos hacen falta:
 *
 *  - Los gastos fijos declarados, uno por renglón. Son los puntuales: el
 *    arriendo, el internet, la cuenta de la luz.
 *  - Lo que se gastó el mes pasado en cada categoría, como un renglón acumulado
 *    por categoría. Es lo que contesta "cuánto hay que asignarle al
 *    supermercado este mes" sin obligar a anotar las siete compras.
 *
 * A la segunda se le resta lo que ya cubren los fijos de esa misma categoría,
 * para no contar dos veces la cuenta de la luz. Lo que sobra entra igual aunque
 * sea poco: dejar cosas fuera en silencio es peor que una lista con un renglón
 * de más, que se borra deslizando.
 *
 * Es sumar, no reemplazar: se puede volver a armar sin miedo, y lo que ya está
 * planeado —incluso editado a mano— se queda como está.
 */
export function armarPlan(householdId: string, month: string): Armado {
  const desde = mesAnterior(month);

  const existentes = db
    .prepare('SELECT category_id, origin, fixed_id FROM planned_expenses WHERE household_id = ? AND period = ?')
    .all(householdId, month) as { category_id: string | null; origin: string; fixed_id: string | null }[];
  const fijosYaPuestos = new Set(existentes.map((e) => e.fixed_id).filter(Boolean));
  const categoriasYaPuestas = new Set(
    existentes.filter((e) => e.origin === 'anterior').map((e) => e.category_id),
  );

  const insertar = db.prepare(
    `INSERT INTO planned_expenses
       (id, household_id, period, name, amount, category_id, due_day, match_text, modo, origin, fixed_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let creados = 0;
  let yaEstaban = 0;

  const fijos = db
    .prepare(
      `SELECT id, name, amount, category_id, due_day, match_text
         FROM fixed_expenses WHERE household_id = ? AND active = 1 ORDER BY due_day, name`,
    )
    .all(householdId) as {
    id: string;
    name: string;
    amount: number | null;
    category_id: string | null;
    due_day: number | null;
    match_text: string | null;
  }[];

  const armado = db.transaction(() => {
    for (const f of fijos) {
      if (fijosYaPuestos.has(f.id)) { yaEstaban += 1; continue; }
      insertar.run(
        uid(), householdId, month, f.name, f.amount, f.category_id, f.due_day, f.match_text,
        'puntual', 'fijo', f.id,
      );
      creados += 1;
    }

    /*
     * Qué parte del mes pasado ya la cubren los fijos.
     *
     * No se estima: se cruza la plantilla contra los movimientos reales del mes
     * anterior y se descuenta exactamente lo que calzó. Estimarlo con el
     * promedio de la categoría estaba mal y se notaba con dos cuentas juntas —la
     * luz declarada sin monto fijo se llevaba también el agua, y el agua
     * desaparecía del plan sin que nadie lo pidiera.
     */
    const delMesPasado = gastosDelMes(householdId, desde);
    const calzados = calzarConMovimientos(
      fijos.map((f) => ({ categoryId: f.category_id, matchText: f.match_text })),
      delMesPasado,
    );
    const cubierto = new Map<string, number>();
    for (const m of calzados) {
      if (!m || !m.categoryId) continue;
      cubierto.set(m.categoryId, (cubierto.get(m.categoryId) ?? 0) + m.amount);
    }

    const porCategoria = db
      .prepare(
        `SELECT t.category_id AS categoryId, c.name AS categoryName, SUM(t.amount) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.household_id = ? AND t.period = ?
            AND t.type = 'gasto' AND t.scope = 'comun'
            AND t.category_id IS NOT NULL
          GROUP BY t.category_id
          ORDER BY total DESC`,
      )
      .all(householdId, desde) as { categoryId: string; categoryName: string | null; total: number }[];

    for (const c of porCategoria) {
      if (categoriasYaPuestas.has(c.categoryId)) { yaEstaban += 1; continue; }
      const resto = c.total - (cubierto.get(c.categoryId) ?? 0);
      // Cubierto entero por los fijos: no hay nada que planear aparte.
      if (resto <= 0) continue;
      insertar.run(
        uid(), householdId, month, c.categoryName ?? 'Sin categoría', round2(resto), c.categoryId,
        null, null, 'acumulado', 'anterior', null,
      );
      creados += 1;
    }
  });
  armado();

  return { creados, yaEstaban, desde };
}

/* ----------------------------- Editar el plan ----------------------------- */

export function agregarRenglon(
  householdId: string,
  month: string,
  datos: {
    name: string;
    amount?: number | null;
    categoryId?: string | null;
    dueDay?: number | null;
    matchText?: string | null;
    modo?: ModoRenglon;
  },
): string {
  const id = uid();
  db.prepare(
    `INSERT INTO planned_expenses
       (id, household_id, period, name, amount, category_id, due_day, match_text, modo, origin, fixed_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mano', NULL)`,
  ).run(
    id, householdId, month, datos.name, datos.amount ?? null, datos.categoryId ?? null,
    datos.dueDay ?? null, datos.matchText ?? null, datos.modo ?? 'puntual',
  );
  return id;
}

export function actualizarRenglon(
  householdId: string,
  id: string,
  datos: {
    name?: string;
    amount?: number | null;
    categoryId?: string | null;
    dueDay?: number | null;
    matchText?: string | null;
    modo?: ModoRenglon;
  },
): boolean {
  const r = db
    .prepare(
      `UPDATE planned_expenses SET
          name = COALESCE(@name, name),
          amount = CASE WHEN @tocaMonto = 1 THEN @amount ELSE amount END,
          category_id = CASE WHEN @tocaCategoria = 1 THEN @categoryId ELSE category_id END,
          due_day = CASE WHEN @tocaDia = 1 THEN @dueDay ELSE due_day END,
          match_text = CASE WHEN @tocaTexto = 1 THEN @matchText ELSE match_text END,
          modo = COALESCE(@modo, modo)
        WHERE id = @id AND household_id = @hogar`,
    )
    .run({
      id,
      hogar: householdId,
      name: datos.name ?? null,
      // Estos aceptan null como valor válido —"no sé cuánto va a ser"—, así que
      // hace falta distinguir "lo mando en null" de "no lo mando".
      tocaMonto: 'amount' in datos ? 1 : 0,
      amount: datos.amount ?? null,
      tocaCategoria: 'categoryId' in datos ? 1 : 0,
      categoryId: datos.categoryId ?? null,
      tocaDia: 'dueDay' in datos ? 1 : 0,
      dueDay: datos.dueDay ?? null,
      tocaTexto: 'matchText' in datos ? 1 : 0,
      matchText: datos.matchText ?? null,
      modo: datos.modo ?? null,
    });
  return r.changes > 0;
}

export function borrarRenglon(householdId: string, id: string): boolean {
  return (
    db.prepare('DELETE FROM planned_expenses WHERE id = ? AND household_id = ?').run(id, householdId)
      .changes > 0
  );
}

/** Borrar el plan entero de un mes, para volver a empezar. */
export function borrarPlan(householdId: string, month: string): number {
  return db
    .prepare('DELETE FROM planned_expenses WHERE household_id = ? AND period = ?')
    .run(householdId, month).changes;
}

/* --------------------------- De plan a movimiento -------------------------- */

/**
 * Anotar que un renglón del plan efectivamente se pagó.
 *
 * Crea el movimiento real y nada más: el renglón no se marca ni se borra. Lo que
 * lo da por cumplido es el cruce, que encontrará este movimiento igual que
 * encontraría el que llega del correo. Así da lo mismo por dónde entró la plata
 * —correo, Apple Pay o este botón—, y no hay dos maneras distintas de que un
 * renglón quede listo que puedan contradecirse.
 *
 * La fecha se acota al mes del plan: confirmar el arriendo de octubre desde
 * septiembre no puede anotar un gasto en septiembre.
 */
export function confirmarRenglon(
  householdId: string,
  id: string,
  datos: { amount?: number; occurredOn?: string } = {},
): { id: string; amount: number } | null {
  const fila = db
    .prepare(`${SELECT} WHERE p.id = ? AND p.household_id = ?`)
    .get(id, householdId) as (Fila & { period?: string }) | undefined;
  if (!fila) return null;

  const period = db
    .prepare('SELECT period FROM planned_expenses WHERE id = ? AND household_id = ?')
    .get(id, householdId) as { period: string };

  const monto =
    datos.amount ??
    fila.amount ??
    promedioDeLoQueCalzo(
      householdId,
      { categoryId: fila.category_id, matchText: fila.match_text },
      period.period,
    ) ??
    0;
  if (!(monto > 0)) return null;

  const hoy = new Date().toISOString().slice(0, 10);
  const pedida = datos.occurredOn && /^\d{4}-\d{2}-\d{2}$/.test(datos.occurredOn) ? datos.occurredOn : hoy;
  // Si hoy cae fuera del mes que se está planeando, se ancla al día de
  // vencimiento del renglón, o al día 1.
  const dentro = pedida.slice(0, 7) === period.period;
  const dia = String(Math.min(Math.max(fila.due_day ?? 1, 1), 28)).padStart(2, '0');
  const occurredOn = dentro ? pedida : `${period.period}-${dia}`;

  const nuevo = uid();
  db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, period, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, source, reviewed)
     VALUES (?, ?, ?, ?, ?, 'gasto', 'comun', 'oficial', NULL, ?, ?, ?, 'plan', 1)`,
  ).run(
    nuevo, householdId, occurredOn, period.period, round2(monto), fila.category_id, fila.name,
    'Anotado desde el plan del mes',
  );

  return { id: nuevo, amount: round2(monto) };
}

import { db } from '../lib/db.js';
import { computeReserve, round2 } from './split.js';

/**
 * Presupuestos, metas de ahorro y comparación entre meses.
 *
 * Todo acá mira **sólo los gastos comunes**: lo que cada uno gasta por su cuenta
 * queda registrado en la app pero no entra en el análisis del hogar.
 */

const SHARED = "type = 'gasto' AND scope = 'comun'";

export type CategoryBudget = {
  categoryId: string;
  category: string;
  color: string;
  budget: number;
  /** true si el monto viene del presupuesto base y no de uno propio del mes. */
  fromBase: boolean;
  spent: number;
  remaining: number;
  /** Proporción gastada (puede pasar de 1). */
  used: number;
  status: 'sin-presupuesto' | 'ok' | 'atencion' | 'excedido';
};

export type BudgetStatus = {
  month: string;
  totalBudget: number;
  /** Todo el gasto común del mes, tenga presupuesto o no. */
  totalSpent: number;
  /**
   * Gasto sólo en las categorías con tope. Es el único número comparable con
   * totalBudget: medir el gasto completo contra un presupuesto parcial daría
   * un excedido falso.
   */
  budgetedSpent: number;
  /** Gasto común en categorías sin presupuesto asignado. */
  unbudgetedSpent: number;
  categories: CategoryBudget[];
  /** Cuánto del mes ha transcurrido (0..1); sirve para saber si el ritmo cuadra. */
  monthProgress: number;
  overBudget: CategoryBudget[];
  nearLimit: CategoryBudget[];
};

function monthProgress(month: string): number {
  const now = new Date();
  const current = now.toISOString().slice(0, 7);
  if (month < current) return 1;
  if (month > current) return 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / daysInMonth;
}

export function computeBudgetStatus(householdId: string, month: string): BudgetStatus {
  const rows = db
    .prepare(
      `SELECT c.id AS categoryId, c.name AS category, c.color,
              COALESCE(bm.amount, bb.amount) AS budget,
              CASE WHEN bm.amount IS NULL AND bb.amount IS NOT NULL THEN 1 ELSE 0 END AS fromBase,
              COALESCE((
                SELECT SUM(t.amount) FROM transactions t
                 WHERE t.household_id = c.household_id
                   AND t.category_id = c.id
                   AND t.occurred_on LIKE ?
                   AND ${SHARED}
              ), 0) AS spent
         FROM categories c
         LEFT JOIN budgets bb ON bb.category_id = c.id AND bb.month IS NULL
         LEFT JOIN budgets bm ON bm.category_id = c.id AND bm.month = ?
        WHERE c.household_id = ? AND c.archived = 0
        ORDER BY c.name`,
    )
    .all(`${month}-%`, month, householdId) as {
    categoryId: string;
    category: string;
    color: string;
    budget: number | null;
    fromBase: number;
    spent: number;
  }[];

  const categories: CategoryBudget[] = rows.map((r) => {
    const budget = r.budget ?? 0;
    const used = budget > 0 ? r.spent / budget : 0;
    let status: CategoryBudget['status'] = 'sin-presupuesto';
    if (budget > 0) {
      if (used > 1) status = 'excedido';
      else if (used >= 0.8) status = 'atencion';
      else status = 'ok';
    }
    return {
      categoryId: r.categoryId,
      category: r.category,
      color: r.color,
      budget: round2(budget),
      fromBase: r.fromBase === 1,
      spent: round2(r.spent),
      remaining: round2(budget - r.spent),
      used,
      status,
    };
  });

  const withBudget = categories.filter((c) => c.budget > 0);

  const totalSpentShared = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND occurred_on LIKE ? AND ${SHARED}`,
      )
      .get(householdId, `${month}-%`) as { total: number }
  ).total;

  const budgetedSpent = withBudget.reduce((a, b) => a + b.spent, 0);

  return {
    month,
    totalBudget: round2(withBudget.reduce((a, b) => a + b.budget, 0)),
    totalSpent: round2(totalSpentShared),
    budgetedSpent: round2(budgetedSpent),
    unbudgetedSpent: round2(totalSpentShared - budgetedSpent),
    categories,
    monthProgress: monthProgress(month),
    overBudget: categories.filter((c) => c.status === 'excedido'),
    nearLimit: categories.filter((c) => c.status === 'atencion'),
  };
}

/* ---------------------------- Metas de ahorro ---------------------------- */

export type Goal = {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  priority: number;
  /** Cuánto del fondo alcanza a cubrir esta meta. */
  funded: number;
  progress: number;
  complete: boolean;
  monthsLeft: number | null;
  /** Cuánto habría que apartar cada mes para llegar a tiempo. */
  monthlyNeeded: number | null;
  onTrack: boolean | null;
};

export type GoalsView = {
  /** Saldo disponible en la cuenta del hogar por sobre los gastos. */
  reserve: number;
  goals: Goal[];
  /** Lo que sobra del fondo una vez cubiertas todas las metas. */
  unassigned: number;
};

function monthsUntil(date: string): number {
  const target = new Date(`${date}T00:00:00`);
  const now = new Date();
  const months =
    (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  return Math.max(months, 0);
}

/**
 * El fondo de reserva es una sola bolsa de plata. Repartirlo entre varias metas
 * "a la vez" daría a entender que hay más de la que hay, así que se llena en
 * orden de prioridad: la primera meta se completa antes de que la siguiente
 * reciba un peso.
 */
export function computeGoals(householdId: string): GoalsView {
  const reserve = computeReserve(householdId).balance;
  const rows = db
    .prepare(
      `SELECT id, name, target_amount AS targetAmount, target_date AS targetDate, priority
         FROM savings_goals WHERE household_id = ? ORDER BY priority, created_at`,
    )
    .all(householdId) as {
    id: string;
    name: string;
    targetAmount: number;
    targetDate: string | null;
    priority: number;
  }[];

  let available = Math.max(reserve, 0);

  const goals: Goal[] = rows.map((row) => {
    const funded = Math.min(available, row.targetAmount);
    available = round2(available - funded);

    const missing = Math.max(row.targetAmount - funded, 0);
    const monthsLeft = row.targetDate ? monthsUntil(row.targetDate) : null;
    const monthlyNeeded =
      monthsLeft != null && missing > 0 ? round2(missing / Math.max(monthsLeft, 1)) : missing > 0 ? null : 0;

    return {
      id: row.id,
      name: row.name,
      targetAmount: round2(row.targetAmount),
      targetDate: row.targetDate,
      priority: row.priority,
      funded: round2(funded),
      progress: row.targetAmount > 0 ? funded / row.targetAmount : 0,
      complete: missing <= 0.005,
      monthsLeft,
      monthlyNeeded,
      // Sin fecha no hay contra qué medir el ritmo.
      onTrack: monthsLeft == null ? null : missing <= 0.005 || monthsLeft > 0,
    };
  });

  return { reserve: round2(reserve), goals, unassigned: round2(available) };
}

/* ------------------------- Comparación entre meses ------------------------ */

export type CategoryChange = {
  category: string;
  color: string;
  current: number;
  previous: number;
  /** Promedio de los meses anteriores considerados, sin contar el actual. */
  average: number;
  deltaPrevious: number;
  deltaAverage: number;
  /** Variación relativa contra el mes anterior; null si el anterior fue cero. */
  changePct: number | null;
};

export type Comparison = {
  month: string;
  previousMonth: string;
  totalCurrent: number;
  totalPrevious: number;
  totalAverage: number;
  categories: CategoryChange[];
  /** Las que más subieron, que es donde conviene mirar primero. */
  biggestIncreases: CategoryChange[];
  biggestDecreases: CategoryChange[];
};

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(year, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function compareMonths(householdId: string, month: string, lookback = 3): Comparison {
  const previousMonth = shiftMonth(month, -1);
  const since = shiftMonth(month, -lookback);

  const rows = db
    .prepare(
      `SELECT COALESCE(c.name, 'Sin categoría') AS category,
              COALESCE(c.color, '#898781') AS color,
              substr(t.occurred_on, 1, 7) AS month,
              SUM(t.amount) AS total
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ?
          AND t.type = 'gasto' AND t.scope = 'comun'
          AND substr(t.occurred_on, 1, 7) >= ?
          AND substr(t.occurred_on, 1, 7) <= ?
        GROUP BY category, color, month`,
    )
    .all(householdId, since, month) as {
    category: string;
    color: string;
    month: string;
    total: number;
  }[];

  const byCategory = new Map<string, { color: string; months: Map<string, number> }>();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, { color: row.color, months: new Map() });
    byCategory.get(row.category)!.months.set(row.month, row.total);
  }

  const priorMonths: string[] = [];
  for (let i = 1; i <= lookback; i += 1) priorMonths.push(shiftMonth(month, -i));

  const categories: CategoryChange[] = [...byCategory.entries()].map(([category, data]) => {
    const current = data.months.get(month) ?? 0;
    const previous = data.months.get(previousMonth) ?? 0;
    const priorValues = priorMonths.map((m) => data.months.get(m) ?? 0);
    const average = priorValues.reduce((a, b) => a + b, 0) / Math.max(priorValues.length, 1);

    return {
      category,
      color: data.color,
      current: round2(current),
      previous: round2(previous),
      average: round2(average),
      deltaPrevious: round2(current - previous),
      deltaAverage: round2(current - average),
      changePct: previous > 0 ? (current - previous) / previous : null,
    };
  });

  categories.sort((a, b) => b.current - a.current);

  const moved = categories.filter((c) => Math.abs(c.deltaPrevious) > 0.005);

  return {
    month,
    previousMonth,
    totalCurrent: round2(categories.reduce((a, b) => a + b.current, 0)),
    totalPrevious: round2(categories.reduce((a, b) => a + b.previous, 0)),
    totalAverage: round2(categories.reduce((a, b) => a + b.average, 0)),
    categories,
    biggestIncreases: [...moved].sort((a, b) => b.deltaPrevious - a.deltaPrevious).filter((c) => c.deltaPrevious > 0).slice(0, 5),
    biggestDecreases: [...moved].sort((a, b) => a.deltaPrevious - b.deltaPrevious).filter((c) => c.deltaPrevious < 0).slice(0, 5),
  };
}

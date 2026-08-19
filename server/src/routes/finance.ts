import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { soloMisMovimientos } from '../lib/visibilidad.js';
import {
  computePersonalSummary,
  computeReserve,
  computeSettlement,
  projectContributions,
} from '../services/split.js';
import { HOGAR, personal, type Ambito } from '../lib/visibilidad.js';
import {
  actualizarGastoFijo,
  borrarGastoFijo,
  crearGastoFijo,
  estadoDelMes,
  gastoEsperadoDelMes,
  listarGastosFijos,
} from '../services/gastosFijos.js';
import { compareMonths, computeBudgetStatus, computeGoals } from '../services/planning.js';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireHousehold);

/**
 * Qué bolsillo está mirando la app: el del hogar o el de quien pregunta.
 *
 * Viaja como `?modo=personal` porque es una elección de la pantalla, no de la
 * cuenta: la misma persona cambia de un lado al otro varias veces al día.
 */
function ambitoDe(req: { query: Record<string, unknown>; user?: { id: string } }): Ambito {
  return req.query.modo === 'personal' ? personal(req.user!.id) : HOGAR;
}

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Mes inválido (YYYY-MM)');

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/* ------------------------------- Sueldos -------------------------------- */

financeRouter.get('/incomes', (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.month, i.amount, i.note, i.user_id AS userId, u.name AS userName
         FROM incomes i JOIN users u ON u.id = i.user_id
        WHERE i.household_id = ?
        ORDER BY i.month DESC, u.name`,
    )
    .all(req.household!.id);
  res.json({ incomes: rows });
});

financeRouter.put('/incomes', (req, res) => {
  const parsed = z
    .object({
      month: monthSchema,
      userId: z.string().optional(),
      amount: z.number().nonnegative(),
      note: z.string().max(200).nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const userId = parsed.data.userId ?? req.user!.id;
  const isMember = db
    .prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?')
    .get(req.household!.id, userId);
  if (!isMember) {
    res.status(403).json({ error: 'Esa persona no pertenece al hogar' });
    return;
  }

  db.prepare(
    `INSERT INTO incomes (id, household_id, user_id, month, amount, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (household_id, user_id, month)
     DO UPDATE SET amount = excluded.amount, note = excluded.note`,
  ).run(uid(), req.household!.id, userId, parsed.data.month, parsed.data.amount, parsed.data.note ?? null);

  res.json({ ok: true });
});

/* ----------------------------- Liquidación ------------------------------ */

financeRouter.get('/settlement', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  res.json(computeSettlement(req.household!.id, month.data, req.household!.currency, req.user!.id));
});

/** Congela el resultado del mes para dejar registro de lo acordado. */
financeRouter.post('/settlement/close', (req, res) => {
  const parsed = z.object({ month: monthSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const snapshot = computeSettlement(req.household!.id, parsed.data.month, req.household!.currency);
  db.prepare(
    `INSERT INTO settlements (household_id, month, snapshot, settled_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (household_id, month)
     DO UPDATE SET snapshot = excluded.snapshot, settled_at = excluded.settled_at`,
  ).run(req.household!.id, parsed.data.month, JSON.stringify(snapshot));
  res.json({ ok: true, snapshot });
});

financeRouter.delete('/settlement/close', (req, res) => {
  const month = monthSchema.safeParse(req.query.month);
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  db.prepare('DELETE FROM settlements WHERE household_id = ? AND month = ?').run(req.household!.id, month.data);
  res.json({ ok: true });
});

/** Cuánto le toca transferir a cada uno este mes, según un presupuesto. */
financeRouter.get('/projection', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  const budgetRaw = req.query.budget;
  const budget = budgetRaw != null && budgetRaw !== '' ? Number(budgetRaw) : null;
  if (budget != null && !Number.isFinite(budget)) {
    res.status(400).json({ error: 'Presupuesto inválido' });
    return;
  }

  // El porcentaje del hogar se puede sobreescribir por consulta para simular.
  const overrideRaw = req.query.contingency;
  const override = overrideRaw != null && overrideRaw !== '' ? Number(overrideRaw) : null;
  if (override != null && (!Number.isFinite(override) || override < 0 || override > 100)) {
    res.status(400).json({ error: 'La contingencia debe ir entre 0 y 100' });
    return;
  }

  const stored = db
    .prepare('SELECT contingency_pct AS pct FROM households WHERE id = ?')
    .get(req.household!.id) as { pct: number };

  // Sin presupuesto explícito, los gastos fijos declarados dan una base mejor
  // que el promedio de meses anteriores: mezcla lo que se sabe con lo que se
  // supone, en vez de suponerlo todo.
  const base = budget ?? gastoEsperadoDelMes(req.household!.id, month.data)?.total ?? null;

  const proyeccion = projectContributions(req.household!.id, month.data, base, override ?? stored.pct);
  if (budget == null && base != null) {
    proyeccion.basedOn = 'gastos fijos declarados y el promedio de lo variable';
  }
  res.json(proyeccion);
});

/** Fondo de reserva acumulado en la cuenta del hogar. */
financeRouter.get('/reserve', (req, res) => {
  res.json(computeReserve(req.household!.id));
});

/* ------------------------------ Presupuesto ------------------------------ */

financeRouter.get('/budgets', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  res.json(computeBudgetStatus(req.household!.id, month.data, ambitoDe(req)));
});

/**
 * Guarda el presupuesto de una categoría. Sin `month` queda como presupuesto
 * base y rige todos los meses; con `month` sólo afecta a ese.
 */
financeRouter.put('/budgets', (req, res) => {
  const parsed = z
    .object({
      categoryId: z.string(),
      amount: z.number().min(0),
      month: monthSchema.nullable().optional(),
      modo: z.enum(['hogar', 'personal']).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const owned = db
    .prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?')
    .get(parsed.data.categoryId, req.household!.id);
  if (!owned) {
    res.status(404).json({ error: 'La categoría no existe en este hogar' });
    return;
  }

  const month = parsed.data.month ?? null;
  // Sin dueño es del hogar; con dueño, de quien lo está poniendo.
  const duenio = parsed.data.modo === 'personal' ? req.user!.id : null;

  // Poner el presupuesto en cero equivale a quitarlo.
  if (parsed.data.amount === 0) {
    db.prepare(
      `DELETE FROM budgets WHERE household_id = ? AND category_id = ?
        AND (user_id IS ? OR user_id = ?) AND (month IS ? OR month = ?)`,
    ).run(req.household!.id, parsed.data.categoryId, duenio, duenio, month, month);
    res.json({ ok: true, removed: true });
    return;
  }

  const existing = db
    .prepare(
      `SELECT id FROM budgets WHERE household_id = ? AND category_id = ?
        AND (user_id IS ? OR user_id = ?) AND (month IS ? OR month = ?)`,
    )
    .get(req.household!.id, parsed.data.categoryId, duenio, duenio, month, month) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare('UPDATE budgets SET amount = ? WHERE id = ?').run(parsed.data.amount, existing.id);
  } else {
    db.prepare(
      'INSERT INTO budgets (id, household_id, user_id, category_id, month, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(uid(), req.household!.id, duenio, parsed.data.categoryId, month, parsed.data.amount);
  }
  res.json({ ok: true });
});

/* ----------------------------- Gastos fijos ------------------------------ */

/** Lo declarado y, cruzado con los movimientos del mes, qué falta por pagar. */
financeRouter.get('/fixed', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  res.json({
    ...estadoDelMes(req.household!.id, month.data),
    all: listarGastosFijos(req.household!.id),
  });
});

const gastoFijoInput = z.object({
  name: z.string().min(1).max(80),
  // Null significa "el monto cambia cada mes"; se estima con el histórico.
  amount: z.number().positive().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  matchText: z.string().max(120).nullable().optional(),
});

financeRouter.post('/fixed', (req, res) => {
  const parsed = gastoFijoInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  res.status(201).json({ id: crearGastoFijo(req.household!.id, parsed.data) });
});

financeRouter.patch('/fixed/:id', (req, res) => {
  const parsed = gastoFijoInput.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  actualizarGastoFijo(req.household!.id, req.params.id, parsed.data);
  res.json({ ok: true });
});

financeRouter.delete('/fixed/:id', (req, res) => {
  borrarGastoFijo(req.household!.id, req.params.id);
  res.json({ ok: true });
});

/* ---------------------------- Metas de ahorro ---------------------------- */

financeRouter.get('/goals', (req, res) => {
  res.json(computeGoals(req.household!.id, ambitoDe(req)));
});

/**
 * Las finanzas de quien pregunta: sueldo, lo que gastó en lo suyo, y lo que
 * puso en la casa —que es un gasto suyo como cualquier otro—.
 */
financeRouter.get('/personal', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  res.json(
    computePersonalSummary(req.household!.id, req.user!.id, month.data, req.household!.currency),
  );
});

financeRouter.post('/goals', (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80),
      targetAmount: z.number().positive('La meta debe ser mayor que cero'),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      priority: z.number().int().optional(),
      modo: z.enum(['hogar', 'personal']).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const duenio = parsed.data.modo === 'personal' ? req.user!.id : null;

  // La prioridad ordena dentro de su propia bolsa: las del hogar entre ellas y
  // las de cada persona entre las suyas.
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(priority), 0) + 10 AS next FROM savings_goals
        WHERE household_id = ? AND (user_id IS ? OR user_id = ?)`,
    )
    .get(req.household!.id, duenio, duenio) as { next: number };

  const id = uid();
  db.prepare(
    `INSERT INTO savings_goals (id, household_id, user_id, name, target_amount, target_date, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, req.household!.id, duenio, parsed.data.name, parsed.data.targetAmount,
    parsed.data.targetDate ?? null, parsed.data.priority ?? next.next,
  );
  res.status(201).json({ id });
});

financeRouter.patch('/goals/:id', (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80).optional(),
      targetAmount: z.number().positive().optional(),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      priority: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const p = parsed.data;
  db.prepare(
    `UPDATE savings_goals SET
        name = COALESCE(?, name),
        target_amount = COALESCE(?, target_amount),
        target_date = COALESCE(?, target_date),
        priority = COALESCE(?, priority)
      WHERE id = ? AND household_id = ? AND (user_id IS NULL OR user_id = ?)`,
  ).run(
    p.name ?? null, p.targetAmount ?? null, p.targetDate ?? null, p.priority ?? null,
    req.params.id, req.household!.id, req.user!.id,
  );
  res.json({ ok: true });
});

financeRouter.delete('/goals/:id', (req, res) => {
  db.prepare(
    'DELETE FROM savings_goals WHERE id = ? AND household_id = ? AND (user_id IS NULL OR user_id = ?)',
  ).run(req.params.id, req.household!.id, req.user!.id);
  res.json({ ok: true });
});

/* ------------------------------- Reportes ------------------------------- */

/** En qué cambió el gasto respecto del mes anterior y del promedio. */
financeRouter.get('/reports/comparison', (req, res) => {
  const month = monthSchema.safeParse(req.query.month ?? currentMonth());
  if (!month.success) {
    res.status(400).json({ error: month.error.issues[0].message });
    return;
  }
  const lookback = Math.min(Math.max(Number(req.query.lookback ?? 3) || 3, 1), 12);
  res.json(compareMonths(req.household!.id, month.data, lookback, ambitoDe(req)));
});

financeRouter.get('/reports/monthly', (req, res) => {
  const months = Math.min(Number(req.query.months ?? 12) || 12, 36);
  const rows = db
    .prepare(
      `SELECT substr(t.occurred_on, 1, 7) AS month,
              SUM(CASE WHEN t.type = 'gasto' AND t.scope = 'comun'    THEN t.amount ELSE 0 END) AS shared,
              -- Sólo lo personal de quien pregunta: el gasto personal del otro
              -- no es asunto de este reporte.
              SUM(CASE WHEN t.type = 'gasto' AND t.scope = 'personal' THEN t.amount ELSE 0 END) AS personal,
              SUM(CASE WHEN t.type = 'aporte'                         THEN t.amount ELSE 0 END) AS contributions
         FROM transactions t
        WHERE t.household_id = @hogar AND ${soloMisMovimientos()}
        GROUP BY month
        ORDER BY month DESC
        LIMIT @limite`,
    )
    .all({ hogar: req.household!.id, yo: req.user!.id, limite: months }) as
      { month: string; shared: number; personal: number; contributions: number }[];

  const incomes = db
    .prepare(
      `SELECT month, SUM(amount) AS total FROM incomes
        WHERE household_id = ? GROUP BY month`,
    )
    .all(req.household!.id) as { month: string; total: number }[];
  const incomeByMonth = new Map(incomes.map((i) => [i.month, i.total]));

  res.json({
    months: rows
      .map((r) => ({ ...r, income: incomeByMonth.get(r.month) ?? 0 }))
      .reverse(),
  });
});

financeRouter.get('/reports/by-category', (req, res) => {
  const month = req.query.month as string | undefined;
  const scope = req.query.scope as string | undefined;
  const params: Record<string, unknown> = { hogar: req.household!.id, yo: req.user!.id };
  let filter = '';
  if (month) {
    filter += ' AND t.occurred_on LIKE @mes';
    params.mes = `${month}-%`;
  }
  // Sin filtro se ven todos los que uno puede ver; las vistas del hogar piden
  // explícitamente 'comun'.
  if (scope === 'comun' || scope === 'personal') {
    filter += ' AND t.scope = @ambito';
    params.ambito = scope;
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(c.name, 'Sin categoría') AS category,
              COALESCE(c.color, '#9ca3af') AS color,
              COALESCE(c.emoji, '❓') AS emoji,
              SUM(t.amount) AS total,
              COUNT(*) AS count
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = @hogar AND t.type = 'gasto'
          AND ${soloMisMovimientos()} ${filter}
        GROUP BY category, color, emoji
        ORDER BY total DESC`,
    )
    .all(params);
  res.json({ categories: rows });
});

/** Evolución de una categoría en el tiempo, para responder "¿estamos gastando más en X?". */
financeRouter.get('/reports/category-trend', (req, res) => {
  const months = Math.min(Number(req.query.months ?? 12) || 12, 36);
  const rows = db
    .prepare(
      `SELECT substr(t.occurred_on, 1, 7) AS month,
              COALESCE(c.name, 'Sin categoría') AS category,
              SUM(t.amount) AS total
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = @hogar AND t.type = 'gasto'
          AND ${soloMisMovimientos()}
          AND substr(t.occurred_on, 1, 7) >= @desde
        GROUP BY month, category
        ORDER BY month`,
    )
    .all({ hogar: req.household!.id, yo: req.user!.id, desde: sinceMonth(months) });
  res.json({ rows });
});

function sinceMonth(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months + 1);
  return d.toISOString().slice(0, 7);
}

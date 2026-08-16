import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { computeReserve, computeSettlement, projectContributions } from '../services/split.js';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireHousehold);

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
  res.json(computeSettlement(req.household!.id, month.data, req.household!.currency));
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

  res.json(projectContributions(req.household!.id, month.data, budget, override ?? stored.pct));
});

/** Fondo de reserva acumulado en la cuenta del hogar. */
financeRouter.get('/reserve', (req, res) => {
  res.json(computeReserve(req.household!.id));
});

/* ------------------------------- Reportes ------------------------------- */

financeRouter.get('/reports/monthly', (req, res) => {
  const months = Math.min(Number(req.query.months ?? 12) || 12, 36);
  const rows = db
    .prepare(
      `SELECT substr(occurred_on, 1, 7) AS month,
              SUM(CASE WHEN type = 'gasto' AND scope = 'comun'    THEN amount ELSE 0 END) AS shared,
              SUM(CASE WHEN type = 'gasto' AND scope = 'personal' THEN amount ELSE 0 END) AS personal,
              SUM(CASE WHEN type = 'aporte'                       THEN amount ELSE 0 END) AS contributions
         FROM transactions
        WHERE household_id = ?
        GROUP BY month
        ORDER BY month DESC
        LIMIT ?`,
    )
    .all(req.household!.id, months) as { month: string; shared: number; personal: number; contributions: number }[];

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
  const params: unknown[] = [req.household!.id];
  let filter = '';
  if (month) {
    filter = 'AND t.occurred_on LIKE ?';
    params.push(`${month}-%`);
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(c.name, 'Sin categoría') AS category,
              COALESCE(c.color, '#9ca3af') AS color,
              SUM(t.amount) AS total,
              COUNT(*) AS count
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ? AND t.type = 'gasto' ${filter}
        GROUP BY category, color
        ORDER BY total DESC`,
    )
    .all(...params);
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
        WHERE t.household_id = ? AND t.type = 'gasto'
          AND substr(t.occurred_on, 1, 7) >= ?
        GROUP BY month, category
        ORDER BY month`,
    )
    .all(req.household!.id, sinceMonth(months));
  res.json({ rows });
});

function sinceMonth(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months + 1);
  return d.toISOString().slice(0, 7);
}

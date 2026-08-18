import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { categorize, recategorizeUncategorized } from '../services/categorizer.js';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth, requireHousehold);

const SELECT = `
  SELECT t.id, t.occurred_on AS occurredOn, t.amount, t.type, t.scope, t.funded_by AS fundedBy,
         t.user_id AS userId, t.category_id AS categoryId, c.name AS categoryName, c.color AS categoryColor, c.emoji AS categoryEmoji,
         t.merchant, t.description, t.account_label AS accountLabel, t.installments,
         t.source, t.raw_snippet AS rawSnippet, t.reviewed, u.name AS userName
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN users u ON u.id = t.user_id
`;

const transactionInput = z.object({
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  amount: z.number().positive('El monto debe ser mayor que cero'),
  type: z.enum(['gasto', 'aporte', 'ingreso_extra']),
  scope: z.enum(['comun', 'personal']).default('comun'),
  fundedBy: z.string().default('oficial'),
  userId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  merchant: z.string().max(120).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  accountLabel: z.string().max(80).nullable().optional(),
  installments: z.number().int().positive().nullable().optional(),
});

transactionsRouter.get('/', (req, res) => {
  const query = z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      type: z.string().optional(),
      scope: z.string().optional(),
      categoryId: z.string().optional(),
      pending: z.enum(['1', '0']).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    })
    .safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Filtros inválidos' });
    return;
  }
  const q = query.data;

  const where: string[] = ['t.household_id = ?'];
  const params: unknown[] = [req.household!.id];

  if (q.month) { where.push('t.occurred_on LIKE ?'); params.push(`${q.month}-%`); }
  if (q.from) { where.push('t.occurred_on >= ?'); params.push(q.from); }
  if (q.to) { where.push('t.occurred_on <= ?'); params.push(q.to); }
  if (q.type) { where.push('t.type = ?'); params.push(q.type); }
  if (q.scope) { where.push('t.scope = ?'); params.push(q.scope); }
  if (q.categoryId) { where.push('t.category_id = ?'); params.push(q.categoryId); }
  if (q.pending === '1') where.push('t.reviewed = 0');
  if (q.search) {
    where.push('(t.merchant LIKE ? OR t.description LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`);
  }

  const rows = db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT ?`)
    .all(...params, q.limit);

  res.json({ transactions: rows });
});

transactionsRouter.post('/', (req, res) => {
  const parsed = transactionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const t = parsed.data;

  // Un aporte a la cuenta del hogar siempre pertenece a quien lo hizo.
  const userId = t.type === 'aporte' ? t.userId ?? req.user!.id : t.userId ?? null;
  const categoryId = t.categoryId ?? categorize(req.household!.id, t.merchant ?? t.description ?? null);
  const id = uid();

  db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, account_label, installments, source, reviewed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1)`,
  ).run(
    id, req.household!.id, t.occurredOn, t.amount, t.type, t.scope, t.fundedBy, userId,
    categoryId, t.merchant ?? null, t.description ?? null, t.accountLabel ?? null, t.installments ?? null,
  );

  res.status(201).json(db.prepare(`${SELECT} WHERE t.id = ?`).get(id));
});

transactionsRouter.patch('/:id', (req, res) => {
  const parsed = transactionInput.partial().extend({ reviewed: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const owned = db
    .prepare('SELECT 1 FROM transactions WHERE id = ? AND household_id = ?')
    .get(req.params.id, req.household!.id);
  if (!owned) {
    res.status(404).json({ error: 'Movimiento no encontrado' });
    return;
  }

  const p = parsed.data;
  db.prepare(
    `UPDATE transactions SET
        occurred_on   = COALESCE(?, occurred_on),
        amount        = COALESCE(?, amount),
        type          = COALESCE(?, type),
        scope         = COALESCE(?, scope),
        funded_by     = COALESCE(?, funded_by),
        user_id       = COALESCE(?, user_id),
        category_id   = COALESCE(?, category_id),
        merchant      = COALESCE(?, merchant),
        description   = COALESCE(?, description),
        account_label = COALESCE(?, account_label),
        installments  = COALESCE(?, installments),
        reviewed      = COALESCE(?, reviewed)
      WHERE id = ? AND household_id = ?`,
  ).run(
    p.occurredOn ?? null, p.amount ?? null, p.type ?? null, p.scope ?? null, p.fundedBy ?? null,
    p.userId ?? null, p.categoryId ?? null, p.merchant ?? null, p.description ?? null,
    p.accountLabel ?? null, p.installments ?? null,
    p.reviewed === undefined ? null : p.reviewed ? 1 : 0,
    req.params.id, req.household!.id,
  );

  res.json(db.prepare(`${SELECT} WHERE t.id = ?`).get(req.params.id));
});

transactionsRouter.delete('/:id', (req, res) => {
  const info = db
    .prepare('DELETE FROM transactions WHERE id = ? AND household_id = ?')
    .run(req.params.id, req.household!.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Movimiento no encontrado' });
    return;
  }
  res.json({ ok: true });
});

/** Marca como revisados todos los movimientos importados desde Gmail. */
transactionsRouter.post('/review-all', (req, res) => {
  const info = db
    .prepare('UPDATE transactions SET reviewed = 1 WHERE household_id = ? AND reviewed = 0')
    .run(req.household!.id);
  res.json({ reviewed: info.changes });
});

transactionsRouter.post('/recategorize', (req, res) => {
  res.json({ updated: recategorizeUncategorized(req.household!.id) });
});

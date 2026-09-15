import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { categorize, recategorizeUncategorized } from '../services/categorizer.js';
import { soloMisMovimientos } from '../lib/visibilidad.js';
import { estadoDelMes } from '../services/gastosFijos.js';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth, requireHousehold);

const SELECT = `
  SELECT t.id, t.occurred_on AS occurredOn, t.period, t.amount, t.type, t.scope, t.funded_by AS fundedBy,
         t.user_id AS userId, t.category_id AS categoryId, c.name AS categoryName, c.color AS categoryColor, c.emoji AS categoryEmoji,
         t.merchant, t.description, t.account_label AS accountLabel, t.installments,
         t.source, t.raw_snippet AS rawSnippet, t.reviewed, u.name AS userName
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN users u ON u.id = t.user_id
`;

const transactionInput = z.object({
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  /**
   * A qué mes cuenta. Si no viene, es el mes de la fecha —que es lo habitual—;
   * se manda distinto cuando se paga por adelantado la cuenta del mes que
   * viene, o cuando llega atrasada la del anterior.
   */
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Mes inválido').optional(),
  amount: z.number().positive('El monto debe ser mayor que cero'),
  type: z.enum(['gasto', 'aporte', 'ingreso_extra']),
  scope: z.enum(['comun', 'personal']).default('comun'),
  /*
   * Quién puso la plata. Sin decirlo, la cuenta del hogar… salvo en un gasto
   * personal, donde lo normal es que lo haya pagado su dueño: nadie compra algo
   * suyo con la tarjeta común por defecto. Ese ajuste va más abajo, cuando ya
   * se sabe el ámbito.
   */
  fundedBy: z.string().optional(),
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
      /* Un id, o 'sin' para los que no tienen categoría: es lo que hay que
         poder pedir para abrir esa barra del gráfico. */
      categoryId: z.string().optional(),
      /* Para que la lista muestre exactamente lo que mostraba el gráfico del
         que se viene. Sin mes no aplica: los fijos se pagan por mes. */
      excluirFijos: z.enum(['1', '0']).optional(),
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

  // Parámetros por nombre: el filtro de visibilidad usa @yo y mezclarlo con
  // posicionales haría que el orden importara en una lista que se arma sola.
  const where: string[] = ['t.household_id = @hogar', soloMisMovimientos()];
  const params: Record<string, unknown> = {
    hogar: req.household!.id,
    yo: req.user!.id,
    limite: q.limit,
  };

  if (q.month) { where.push('t.period = @mes'); params.mes = q.month; }
  if (q.from) { where.push('t.occurred_on >= @desde'); params.desde = q.from; }
  if (q.to) { where.push('t.occurred_on <= @hasta'); params.hasta = q.to; }
  if (q.type) { where.push('t.type = @tipo'); params.tipo = q.type; }
  if (q.scope) { where.push('t.scope = @ambito'); params.ambito = q.scope; }
  if (q.categoryId === 'sin') {
    where.push('t.category_id IS NULL');
  } else if (q.categoryId) {
    where.push('t.category_id = @categoria');
    params.categoria = q.categoryId;
  }

  /*
   * Los gastos fijos fuera, cuando se piden así.
   *
   * El Resumen muestra el desglose por categoría sin ellos —el arriendo aplasta
   * el resto— y al entrar a una barra la lista tiene que sumar lo mismo que la
   * barra. Si no, el usuario ve un total en el gráfico y otro en la lista, y
   * deja de creerle a los dos.
   */
  if (q.excluirFijos === '1' && q.month) {
    const pagados = estadoDelMes(req.household!.id, q.month)
      .items.map((i) => i.paidWith?.id)
      .filter((id): id is string => Boolean(id));
    if (pagados.length > 0) {
      const marcas = pagados.map((_, i) => `@fijo${i}`);
      where.push(`t.id NOT IN (${marcas.join(', ')})`);
      pagados.forEach((id, i) => { params[`fijo${i}`] = id; });
    }
  }
  if (q.pending === '1') where.push('t.reviewed = 0');
  if (q.search) {
    where.push('(t.merchant LIKE @busca OR t.description LIKE @busca)');
    params.busca = `%${q.search}%`;
  }

  const rows = db
    .prepare(
      `${SELECT} WHERE ${where.join(' AND ')}
        ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT @limite`,
    )
    .all(params);

  res.json({ transactions: rows });
});

transactionsRouter.post('/', (req, res) => {
  const parsed = transactionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const t = parsed.data;

  // Un aporte a la cuenta del hogar siempre pertenece a quien lo hizo, y un
  // gasto personal también: sin dueño no sería de nadie, y lo personal es
  // justamente lo que le pertenece a una persona.
  const userId =
    t.type === 'aporte' || t.scope === 'personal' ? (t.userId ?? req.user!.id) : (t.userId ?? null);

  /*
   * Y quién puso la plata, cuando no se dijo.
   *
   * Un gasto personal lo paga su dueño salvo que digan lo contrario: asumir la
   * cuenta del hogar hacía que comprarse algo propio saliera del pozo común sin
   * que nadie respondiera por esa plata, y dejaba el saldo de la cuenta sin
   * cuadrar con el banco.
   */
  const fundedBy = t.fundedBy ?? (t.scope === 'personal' && t.type === 'gasto' ? userId! : 'oficial');
  const categoryId = t.categoryId ?? categorize(req.household!.id, t.merchant ?? t.description ?? null);
  const id = uid();

  db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, period, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, account_label, installments, source, reviewed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1)`,
  ).run(
    id, req.household!.id, t.occurredOn, t.period ?? t.occurredOn.slice(0, 7),
    t.amount, t.type, t.scope, fundedBy, userId,
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
    .prepare(
      `SELECT 1 FROM transactions t
        WHERE t.id = @id AND t.household_id = @hogar AND ${soloMisMovimientos()}`,
    )
    .get({ id: req.params.id, hogar: req.household!.id, yo: req.user!.id });
  if (!owned) {
    res.status(404).json({ error: 'Movimiento no encontrado' });
    return;
  }

  const p = parsed.data;
  db.prepare(
    `UPDATE transactions SET
        occurred_on   = COALESCE(?, occurred_on),
        period        = COALESCE(?, period),
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
    p.occurredOn ?? null, p.period ?? null, p.amount ?? null, p.type ?? null, p.scope ?? null, p.fundedBy ?? null,
    p.userId ?? null, p.categoryId ?? null, p.merchant ?? null, p.description ?? null,
    p.accountLabel ?? null, p.installments ?? null,
    p.reviewed === undefined ? null : p.reviewed ? 1 : 0,
    req.params.id, req.household!.id,
  );

  res.json(db.prepare(`${SELECT} WHERE t.id = ?`).get(req.params.id));
});

transactionsRouter.delete('/:id', (req, res) => {
  const info = db
    .prepare(
      `DELETE FROM transactions
        WHERE id = @id AND household_id = @hogar AND ${soloMisMovimientos('')}`,
    )
    .run({ id: req.params.id, hogar: req.household!.id, yo: req.user!.id });
  if (info.changes === 0) {
    res.status(404).json({ error: 'Movimiento no encontrado' });
    return;
  }
  res.json({ ok: true });
});

/** Marca como revisados todos los movimientos importados desde Gmail. */
transactionsRouter.post('/review-all', (req, res) => {
  const info = db
    .prepare(
      `UPDATE transactions SET reviewed = 1
        WHERE household_id = @hogar AND reviewed = 0 AND ${soloMisMovimientos('')}`,
    )
    .run({ hogar: req.household!.id, yo: req.user!.id });
  res.json({ reviewed: info.changes });
});

transactionsRouter.post('/recategorize', (req, res) => {
  res.json({ updated: recategorizeUncategorized(req.household!.id) });
});

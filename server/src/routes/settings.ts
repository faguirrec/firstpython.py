import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { applyRule, htmlToText, type EmailRule } from '../services/parser.js';
import { BANK_TEMPLATES } from '../services/bankTemplates.js';
import { correoConfigurado, enviarCorreo, envoltorio, probarConexion } from '../services/mailer.js';
import { construirReporte, mesPasado } from '../services/reporteMensual.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth, requireHousehold);

/* -------------------------------- Correo -------------------------------- */

settingsRouter.get('/email', (_req, res) => {
  res.json({ configured: correoConfigurado(), from: correoConfigurado() ? env.smtp.from : null });
});

/** Comprueba la conexión SMTP sin mandar nada. */
settingsRouter.post('/email/test', async (req, res) => {
  const conexion = await probarConexion();
  if (!conexion.ok) {
    res.status(502).json({ error: conexion.error });
    return;
  }

  const envio = await enviarCorreo({
    para: req.user!.email,
    asunto: 'Prueba de correo — MyHaus',
    html: envoltorio(
      'El correo está funcionando',
      `<p style="color:#52514e;margin:0;">
         Si estás leyendo esto, la app puede mandar invitaciones y el resumen mensual.
       </p>`,
    ),
    texto: 'El correo está funcionando: la app puede mandar invitaciones y el resumen mensual.',
  });

  if (!envio.ok) {
    res.status(502).json({ error: envio.error });
    return;
  }
  res.json({ ok: true, enviadoA: req.user!.email });
});

/**
 * Manda el reporte de un mes a quien lo pide, sin registrarlo como enviado:
 * sirve para ver cómo queda antes de que salga automáticamente.
 */
settingsRouter.post('/email/reporte-de-prueba', async (req, res) => {
  const parsed = z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
    .safeParse(req.body ?? {});
  const mes = parsed.success && parsed.data.month ? parsed.data.month : mesPasado();

  if (!correoConfigurado()) {
    res.status(503).json({ error: 'El envío de correo no está configurado en el servidor.' });
    return;
  }

  const reporte = construirReporte(req.household!.id, mes);
  if (!reporte) {
    res.status(404).json({ error: `No hay gastos comunes registrados en ${mes}, así que no hay reporte que enviar.` });
    return;
  }

  const envio = await enviarCorreo({
    para: req.user!.email,
    asunto: `[Prueba] ${reporte.asunto}`,
    html: reporte.html,
    texto: reporte.texto,
  });

  if (!envio.ok) {
    res.status(502).json({ error: envio.error });
    return;
  }
  res.json({ ok: true, enviadoA: req.user!.email, mes });
});

/* ------------------------------ Categorías ------------------------------ */

settingsRouter.get('/categories', (req, res) => {
  const categories = db
    .prepare(
      // El conteo de uso permite mostrar primero las categorías que el hogar
      // realmente usa, en vez de un orden alfabético que deja arriba las raras.
      `SELECT c.id, c.name, c.kind, c.color, c.emoji, c.archived,
              (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS usos
         FROM categories c WHERE c.household_id = ? ORDER BY c.name`,
    )
    .all(req.household!.id);
  res.json({ categories });
});

settingsRouter.post('/categories', (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(60),
      kind: z.enum(['necesidad', 'gusto', 'ahorro']).default('gusto'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6b7280'),
      emoji: z.string().min(1).max(8).default('📦'),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const id = uid();
  try {
    db.prepare('INSERT INTO categories (id, household_id, name, kind, color, emoji) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, req.household!.id, parsed.data.name, parsed.data.kind, parsed.data.color, parsed.data.emoji,
    );
  } catch {
    res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    return;
  }
  res.status(201).json({ id, ...parsed.data });
});

settingsRouter.patch('/categories/:id', (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(60).optional(),
      kind: z.enum(['necesidad', 'gusto', 'ahorro']).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      emoji: z.string().min(1).max(8).optional(),
      archived: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const p = parsed.data;
  db.prepare(
    `UPDATE categories SET name = COALESCE(?, name), kind = COALESCE(?, kind),
            color = COALESCE(?, color), emoji = COALESCE(?, emoji), archived = COALESCE(?, archived)
      WHERE id = ? AND household_id = ?`,
  ).run(
    p.name ?? null, p.kind ?? null, p.color ?? null, p.emoji ?? null,
    p.archived === undefined ? null : p.archived ? 1 : 0,
    req.params.id, req.household!.id,
  );
  res.json({ ok: true });
});

settingsRouter.delete('/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ? AND household_id = ?').run(req.params.id, req.household!.id);
  res.json({ ok: true });
});

/* ------------------ Reglas de categorización automática ------------------ */

settingsRouter.get('/category-rules', (req, res) => {
  const rules = db
    .prepare(
      `SELECT r.id, r.pattern, r.priority, r.category_id AS categoryId, c.name AS categoryName
         FROM category_rules r JOIN categories c ON c.id = r.category_id
        WHERE r.household_id = ? ORDER BY r.priority`,
    )
    .all(req.household!.id);
  res.json({ rules });
});

settingsRouter.post('/category-rules', (req, res) => {
  const parsed = z
    .object({ pattern: z.string().min(1).max(200), categoryId: z.string(), priority: z.number().int().default(100) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  try {
    new RegExp(parsed.data.pattern);
  } catch {
    res.status(400).json({ error: 'La expresión regular no es válida' });
    return;
  }
  const id = uid();
  db.prepare('INSERT INTO category_rules (id, household_id, pattern, category_id, priority) VALUES (?, ?, ?, ?, ?)').run(
    id, req.household!.id, parsed.data.pattern, parsed.data.categoryId, parsed.data.priority,
  );
  res.status(201).json({ id });
});

settingsRouter.delete('/category-rules/:id', (req, res) => {
  db.prepare('DELETE FROM category_rules WHERE id = ? AND household_id = ?').run(req.params.id, req.household!.id);
  res.json({ ok: true });
});

/* -------------------------- Reglas de correo ---------------------------- */

const emailRuleInput = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(false),
  gmailQuery: z.string().min(1).max(300),
  amountRegex: z.string().min(1).max(300),
  merchantRegex: z.string().max(300).nullable().optional(),
  dateRegex: z.string().max(300).nullable().optional(),
  accountRegex: z.string().max(300).nullable().optional(),
  cardFilter: z.string().max(120).nullable().optional(),
  mustContain: z.string().max(400).nullable().optional(),
  type: z.enum(['gasto', 'aporte']).default('gasto'),
  scope: z.enum(['comun', 'personal']).default('comun'),
  accountLabel: z.string().max(80).nullable().optional(),
  userId: z.string().nullable().optional(),
  priority: z.number().int().default(100),
});

function validRegexes(input: z.infer<typeof emailRuleInput>): string | null {
  for (const [label, pattern] of [
    ['monto', input.amountRegex],
    ['comercio', input.merchantRegex],
    ['fecha', input.dateRegex],
    ['cuenta', input.accountRegex],
  ] as const) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, 'i');
    } catch {
      return `La expresión regular de ${label} no es válida`;
    }
  }
  return null;
}

settingsRouter.get('/email-rules', (req, res) => {
  const rules = db
    .prepare(
      `SELECT id, name, enabled, gmail_query AS gmailQuery, amount_regex AS amountRegex,
              merchant_regex AS merchantRegex, date_regex AS dateRegex, account_regex AS accountRegex,
              card_filter AS cardFilter, type, scope, account_label AS accountLabel, priority
         FROM email_rules WHERE household_id = ? ORDER BY priority`,
    )
    .all(req.household!.id);
  res.json({ rules, templates: BANK_TEMPLATES });
});

settingsRouter.post('/email-rules', (req, res) => {
  const parsed = emailRuleInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const invalid = validRegexes(parsed.data);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const r = parsed.data;
  const id = uid();
  db.prepare(
    `INSERT INTO email_rules
       (id, household_id, name, enabled, gmail_query, amount_regex, merchant_regex, date_regex,
        account_regex, card_filter, must_contain, type, scope, account_label, user_id, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, req.household!.id, r.name, r.enabled ? 1 : 0, r.gmailQuery, r.amountRegex,
    r.merchantRegex ?? null, r.dateRegex ?? null, r.accountRegex ?? null, r.cardFilter ?? null,
    r.mustContain ?? null, r.type, r.scope, r.accountLabel ?? null, r.userId ?? null, r.priority,
  );
  res.status(201).json({ id });
});

settingsRouter.patch('/email-rules/:id', (req, res) => {
  const parsed = emailRuleInput.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const invalid = validRegexes(parsed.data as z.infer<typeof emailRuleInput>);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const r = parsed.data;
  db.prepare(
    `UPDATE email_rules SET
        name = COALESCE(?, name), enabled = COALESCE(?, enabled), gmail_query = COALESCE(?, gmail_query),
        amount_regex = COALESCE(?, amount_regex), merchant_regex = COALESCE(?, merchant_regex),
        date_regex = COALESCE(?, date_regex), account_regex = COALESCE(?, account_regex),
        card_filter = COALESCE(?, card_filter), must_contain = COALESCE(?, must_contain),
        type = COALESCE(?, type), scope = COALESCE(?, scope),
        account_label = COALESCE(?, account_label), user_id = COALESCE(?, user_id),
        priority = COALESCE(?, priority)
      WHERE id = ? AND household_id = ?`,
  ).run(
    r.name ?? null, r.enabled === undefined ? null : r.enabled ? 1 : 0, r.gmailQuery ?? null,
    r.amountRegex ?? null, r.merchantRegex ?? null, r.dateRegex ?? null, r.accountRegex ?? null,
    r.cardFilter ?? null, r.mustContain ?? null, r.type ?? null, r.scope ?? null,
    r.accountLabel ?? null, r.userId ?? null, r.priority ?? null,
    req.params.id, req.household!.id,
  );
  res.json({ ok: true });
});

settingsRouter.delete('/email-rules/:id', (req, res) => {
  db.prepare('DELETE FROM email_rules WHERE id = ? AND household_id = ?').run(req.params.id, req.household!.id);
  res.json({ ok: true });
});

/**
 * Prueba una regla contra el texto de un correo pegado a mano, sin tocar Gmail.
 * Es la forma práctica de ajustar las expresiones regulares cuando un banco
 * cambia el formato de sus avisos.
 */
settingsRouter.post('/email-rules/test', (req, res) => {
  const parsed = z
    .object({
      sample: z.string().min(1).max(20000),
      isHtml: z.boolean().default(false),
      rule: emailRuleInput.partial({ name: true, gmailQuery: true }),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const r = parsed.data.rule;
  const rule: EmailRule = {
    id: 'test',
    name: r.name ?? 'prueba',
    amount_regex: r.amountRegex ?? '',
    merchant_regex: r.merchantRegex ?? null,
    date_regex: r.dateRegex ?? null,
    account_regex: r.accountRegex ?? null,
    card_filter: r.cardFilter ?? null,
    must_contain: r.mustContain ?? null,
    type: r.type ?? 'gasto',
    scope: r.scope ?? 'comun',
    account_label: r.accountLabel ?? null,
    user_id: r.userId ?? null,
  };

  const body = parsed.data.isHtml ? htmlToText(parsed.data.sample) : parsed.data.sample;
  const movement = applyRule({ from: '', subject: '', body, internalDate: Date.now() }, rule);

  res.json({ matched: movement != null, movement, text: body.slice(0, 2000) });
});

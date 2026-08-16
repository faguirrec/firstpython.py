import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { BANK_TEMPLATES, DEFAULT_CATEGORIES, DEFAULT_CATEGORY_RULES } from '../services/bankTemplates.js';

export const householdRouter = Router();
householdRouter.use(requireAuth);

const MAX_MEMBERS = 2;

function inviteCode(): string {
  // Código corto y legible para dictar por teléfono, sin caracteres ambiguos.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function seedHousehold(householdId: string): void {
  const insertCategory = db.prepare('INSERT INTO categories (id, household_id, name, kind, color) VALUES (?, ?, ?, ?, ?)');
  const byName = new Map<string, string>();
  for (const category of DEFAULT_CATEGORIES) {
    const id = uid();
    insertCategory.run(id, householdId, category.name, category.kind, category.color);
    byName.set(category.name, id);
  }

  const insertCategoryRule = db.prepare(
    'INSERT INTO category_rules (id, household_id, pattern, category_id, priority) VALUES (?, ?, ?, ?, ?)',
  );
  DEFAULT_CATEGORY_RULES.forEach((rule, i) => {
    const categoryId = byName.get(rule.category);
    if (categoryId) insertCategoryRule.run(uid(), householdId, rule.pattern, categoryId, i * 10);
  });

  // Las reglas de correo se crean desactivadas: cada hogar activa y ajusta las de su banco.
  const insertEmailRule = db.prepare(
    `INSERT INTO email_rules
       (id, household_id, name, enabled, gmail_query, amount_regex, merchant_regex, date_regex,
        account_regex, type, scope, account_label, priority)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  BANK_TEMPLATES.forEach((t, i) => {
    insertEmailRule.run(
      uid(), householdId, t.name, t.gmail_query, t.amount_regex, t.merchant_regex,
      t.date_regex, t.account_regex, t.type, t.scope, t.account_label, i * 10,
    );
  });
}

householdRouter.post('/', (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80),
      currency: z.string().min(3).max(3).default('CLP'),
      officialAccount: z.string().max(80).default('Cuenta del hogar'),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const already = db.prepare('SELECT 1 FROM household_members WHERE user_id = ?').get(req.user!.id);
  if (already) {
    res.status(409).json({ error: 'Ya perteneces a un hogar' });
    return;
  }

  const id = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO households (id, name, currency, official_account) VALUES (?, ?, ?, ?)').run(
      id, parsed.data.name, parsed.data.currency.toUpperCase(), parsed.data.officialAccount,
    );
    db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)').run(
      id, req.user!.id, 'owner',
    );
    seedHousehold(id);
  })();

  res.status(201).json({ id });
});

householdRouter.get('/', requireHousehold, (req, res) => {
  const household = db
    .prepare('SELECT id, name, currency, official_account AS officialAccount FROM households WHERE id = ?')
    .get(req.household!.id);

  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.joined_at AS joinedAt
         FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ? ORDER BY m.joined_at`,
    )
    .all(req.household!.id);

  const invite = db
    .prepare('SELECT code FROM invites WHERE household_id = ? AND used_by IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(req.household!.id) as { code: string } | undefined;

  res.json({ household, members, inviteCode: members.length < MAX_MEMBERS ? invite?.code ?? null : null });
});

householdRouter.patch('/', requireHousehold, (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80).optional(),
      currency: z.string().length(3).optional(),
      officialAccount: z.string().max(80).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { name, currency, officialAccount } = parsed.data;
  db.prepare(
    `UPDATE households
        SET name = COALESCE(?, name),
            currency = COALESCE(?, currency),
            official_account = COALESCE(?, official_account)
      WHERE id = ?`,
  ).run(name ?? null, currency?.toUpperCase() ?? null, officialAccount ?? null, req.household!.id);
  res.json({ ok: true });
});

/** Genera (o reutiliza) el código con el que la otra persona entra al hogar. */
householdRouter.post('/invite', requireHousehold, (req, res) => {
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?')
    .get(req.household!.id) as { n: number };
  if (count.n >= MAX_MEMBERS) {
    res.status(409).json({ error: 'El hogar ya tiene sus dos integrantes' });
    return;
  }

  const existing = db
    .prepare('SELECT code FROM invites WHERE household_id = ? AND used_by IS NULL LIMIT 1')
    .get(req.household!.id) as { code: string } | undefined;
  if (existing) {
    res.json({ code: existing.code });
    return;
  }

  const code = inviteCode();
  db.prepare('INSERT INTO invites (code, household_id, created_by) VALUES (?, ?, ?)').run(
    code, req.household!.id, req.user!.id,
  );
  res.status(201).json({ code });
});

householdRouter.post('/join', (req, res) => {
  const parsed = z.object({ code: z.string().min(4).max(12) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Código inválido' });
    return;
  }

  const invite = db
    .prepare('SELECT code, household_id AS householdId FROM invites WHERE code = ? AND used_by IS NULL')
    .get(parsed.data.code.toUpperCase().trim()) as { code: string; householdId: string } | undefined;
  if (!invite) {
    res.status(404).json({ error: 'El código no existe o ya fue usado' });
    return;
  }

  const already = db.prepare('SELECT 1 FROM household_members WHERE user_id = ?').get(req.user!.id);
  if (already) {
    res.status(409).json({ error: 'Ya perteneces a un hogar' });
    return;
  }

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?')
    .get(invite.householdId) as { n: number };
  if (count.n >= MAX_MEMBERS) {
    res.status(409).json({ error: 'Ese hogar ya tiene sus dos integrantes' });
    return;
  }

  db.transaction(() => {
    db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)').run(
      invite.householdId, req.user!.id, 'member',
    );
    db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(req.user!.id, invite.code);
  })();

  res.json({ id: invite.householdId });
});

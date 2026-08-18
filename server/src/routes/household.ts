import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { BANK_TEMPLATES, DEFAULT_CATEGORIES, DEFAULT_CATEGORY_RULES } from '../services/bankTemplates.js';
import { boton, correoConfigurado, enviarCorreo, envoltorio } from '../services/mailer.js';

export const householdRouter = Router();

/**
 * Ruta pública, declarada antes del guard: quien abre un link de invitación
 * todavía no tiene cuenta, y necesita ver a qué hogar lo están invitando.
 * Sólo expone el nombre del hogar y de quien invita.
 */
householdRouter.get('/invite/:code', (req, res) => {
  const invite = db
    .prepare(
      `SELECT h.name AS householdName, u.name AS invitedBy
         FROM invites i
         JOIN households h ON h.id = i.household_id
         JOIN users u ON u.id = i.created_by
        WHERE i.code = ? AND i.used_by IS NULL AND i.revoked = 0`,
    )
    .get(req.params.code.toUpperCase().trim());

  if (!invite) {
    res.status(404).json({ error: 'El código no existe o ya fue usado' });
    return;
  }
  res.json(invite);
});

householdRouter.use(requireAuth);

const MAX_MEMBERS = 2;

function inviteCode(): string {
  // Código corto y legible para dictar por teléfono, sin caracteres ambiguos.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/**
 * Categorías, reglas de comercio y plantillas de banco de un hogar recién
 * creado. Se exporta para poder ejercitar el mismo camino desde las pruebas: un
 * hogar armado a mano no categoriza igual que uno real.
 */
export function seedHousehold(householdId: string): void {
  const insertCategory = db.prepare(
    'INSERT INTO categories (id, household_id, name, kind, color, emoji) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const byName = new Map<string, string>();
  for (const category of DEFAULT_CATEGORIES) {
    const id = uid();
    insertCategory.run(id, householdId, category.name, category.kind, category.color, category.emoji);
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
        account_regex, must_contain, type, scope, account_label, priority)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  BANK_TEMPLATES.forEach((t, i) => {
    insertEmailRule.run(
      uid(), householdId, t.name, t.gmail_query, t.amount_regex, t.merchant_regex,
      t.date_regex, t.account_regex, t.must_contain ?? null, t.type, t.scope, t.account_label, i * 10,
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
    .prepare(
      `SELECT id, name, currency, official_account AS officialAccount, contingency_pct AS contingencyPct,
              send_monthly_report AS sendMonthlyReport
         FROM households WHERE id = ?`,
    )
    .get(req.household!.id);

  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.joined_at AS joinedAt
         FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ? ORDER BY m.joined_at`,
    )
    .all(req.household!.id);

  const invite = db
    .prepare(
      `SELECT code FROM invites
        WHERE household_id = ? AND used_by IS NULL AND revoked = 0
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(req.household!.id) as { code: string } | undefined;

  res.json({ household, members, inviteCode: members.length < MAX_MEMBERS ? invite?.code ?? null : null });
});

householdRouter.patch('/', requireHousehold, (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80).optional(),
      currency: z.string().length(3).optional(),
      officialAccount: z.string().max(80).optional(),
      contingencyPct: z.number().min(0).max(100).optional(),
      sendMonthlyReport: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { name, currency, officialAccount, contingencyPct, sendMonthlyReport } = parsed.data;
  db.prepare(
    `UPDATE households
        SET name = COALESCE(?, name),
            currency = COALESCE(?, currency),
            official_account = COALESCE(?, official_account),
            contingency_pct = COALESCE(?, contingency_pct),
            send_monthly_report = COALESCE(?, send_monthly_report)
      WHERE id = ?`,
  ).run(
    name ?? null,
    currency?.toUpperCase() ?? null,
    officialAccount ?? null,
    contingencyPct ?? null,
    sendMonthlyReport === undefined ? null : sendMonthlyReport ? 1 : 0,
    req.household!.id,
  );
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
    .prepare('SELECT code FROM invites WHERE household_id = ? AND used_by IS NULL AND revoked = 0 LIMIT 1')
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

/** Manda la invitación por correo, además de mostrarla en pantalla. */
householdRouter.post('/invite/email', requireHousehold, async (req, res) => {
  const parsed = z
    .object({ email: z.string().email('Correo inválido'), origin: z.string().url().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  if (!correoConfigurado()) {
    res.status(503).json({
      error: 'El envío de correo no está configurado en el servidor. Puedes compartir el link o el QR igual.',
    });
    return;
  }

  const invitacion = db
    .prepare('SELECT code FROM invites WHERE household_id = ? AND used_by IS NULL AND revoked = 0 LIMIT 1')
    .get(req.household!.id) as { code: string } | undefined;
  if (!invitacion) {
    res.status(409).json({ error: 'No hay una invitación vigente. Genera una primero.' });
    return;
  }

  const hogar = db.prepare('SELECT name FROM households WHERE id = ?').get(req.household!.id) as { name: string };
  const base = parsed.data.origin ?? env.webOrigin;
  const link = `${base}/unirse/${invitacion.code}`;

  const envio = await enviarCorreo({
    para: parsed.data.email,
    asunto: `${req.user!.name} te invitó a administrar ${hogar.name}`,
    html: envoltorio(
      `${req.user!.name} te invitó a ${hogar.name}`,
      `<p style="color:#52514e;margin:0 0 8px;">
         Van a llevar juntos las cuentas de la casa: los gastos comunes se reparten según lo que gana cada uno,
         no a la mitad.
       </p>
       <p style="color:#52514e;margin:0;">Crea tu cuenta con este enlace y quedan conectados:</p>
       ${boton('Entrar al hogar', link)}
       <p style="font-size:13px;color:#898781;margin:0;">
         Si el botón no funciona, copia esta dirección:<br>
         <span style="word-break:break-all;">${link}</span>
       </p>
       <p style="font-size:13px;color:#898781;margin:14px 0 0;">
         O usa el código <strong style="letter-spacing:2px;">${invitacion.code}</strong> dentro de la app.
       </p>`,
    ),
    texto: `${req.user!.name} te invitó a administrar ${hogar.name}.\n\nEntra acá y crea tu cuenta: ${link}\n\nO usa el código ${invitacion.code} dentro de la app.`,
  });

  if (!envio.ok) {
    res.status(502).json({ error: envio.error });
    return;
  }
  res.json({ ok: true, enviadoA: parsed.data.email });
});

/** Anula los códigos vigentes y emite uno nuevo (si el anterior se filtró). */
householdRouter.post('/invite/rotate', requireHousehold, (req, res) => {
  const code = inviteCode();
  db.transaction(() => {
    db.prepare('UPDATE invites SET revoked = 1 WHERE household_id = ? AND used_by IS NULL').run(req.household!.id);
    db.prepare('INSERT INTO invites (code, household_id, created_by) VALUES (?, ?, ?)').run(
      code, req.household!.id, req.user!.id,
    );
  })();
  res.status(201).json({ code });
});

householdRouter.delete('/invite', requireHousehold, (req, res) => {
  db.prepare('UPDATE invites SET revoked = 1 WHERE household_id = ? AND used_by IS NULL').run(req.household!.id);
  res.json({ ok: true });
});

/**
 * Suma un usuario a un hogar usando un código de invitación.
 * Vive fuera del handler porque el registro también la usa: quien llega por un
 * link de invitación crea su cuenta y entra al hogar en un solo paso.
 */
export function joinByCode(
  userId: string,
  rawCode: string,
): { ok: true; householdId: string } | { ok: false; status: number; error: string } {
  const invite = db
    .prepare(
      'SELECT code, household_id AS householdId FROM invites WHERE code = ? AND used_by IS NULL AND revoked = 0',
    )
    .get(rawCode.toUpperCase().trim()) as { code: string; householdId: string } | undefined;
  if (!invite) return { ok: false, status: 404, error: 'El código no existe o ya fue usado' };

  const already = db.prepare('SELECT 1 FROM household_members WHERE user_id = ?').get(userId);
  if (already) return { ok: false, status: 409, error: 'Ya perteneces a un hogar' };

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?')
    .get(invite.householdId) as { n: number };
  if (count.n >= MAX_MEMBERS) return { ok: false, status: 409, error: 'Ese hogar ya tiene sus dos integrantes' };

  db.transaction(() => {
    db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)').run(
      invite.householdId, userId, 'member',
    );
    db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(userId, invite.code);
  })();

  return { ok: true, householdId: invite.householdId };
}

householdRouter.post('/join', (req, res) => {
  const parsed = z.object({ code: z.string().min(4).max(12) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Código inválido' });
    return;
  }

  const result = joinByCode(req.user!.id, parsed.data.code);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ id: result.householdId });
});

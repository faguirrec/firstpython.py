import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { clearToken, issueToken, requireAuth } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { rateLimit } from '../lib/rateLimit.js';
import { joinByCode } from './household.js';

export const authRouter = Router();

const credentials = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  name: z.string().min(1).max(60).optional(),
});

const registration = credentials.extend({
  /** Si viene, la cuenta queda creada y dentro del hogar en un solo paso. */
  inviteCode: z.string().min(4).max(12).optional(),
});

/**
 * Cupos separados y generosos: para un hogar de dos personas lo que importa es
 * frenar la fuerza bruta, no castigar a quien se equivoca de contraseña.
 */
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: 'Demasiados intentos fallidos.',
  refundOnSuccess: true,
});

const registerLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: 'Demasiados registros desde esta conexión.',
});

authRouter.post('/register', registerLimit, (req, res) => {
  const parsed = registration.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { email, password, inviteCode } = parsed.data;

  // En un servidor público conviene cerrar el registro una vez que ambos entraron.
  if (env.signupMode === 'closed') {
    res.status(403).json({ error: 'El registro está cerrado en este servidor.' });
    return;
  }
  if (env.signupMode === 'invite' && !inviteCode) {
    // Excepción de arranque: en una instalación recién desplegada no existe
    // ningún código todavía, así que la primera cuenta se permite sin él.
    const empty = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (!empty) {
      res.status(403).json({ error: 'Este servidor sólo acepta registros con un código de invitación.' });
      return;
    }
  }
  const name = parsed.data.name?.trim() || email.split('@')[0];
  const normalized = email.toLowerCase().trim();

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized);
  if (exists) {
    res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
    return;
  }

  // Con código de invitación se valida antes de crear nada: si está vencido,
  // es mejor decirlo ahora que dejar una cuenta suelta sin hogar.
  if (inviteCode) {
    const preview = db
      .prepare('SELECT 1 FROM invites WHERE code = ? AND used_by IS NULL AND revoked = 0')
      .get(inviteCode.toUpperCase().trim());
    if (!preview) {
      res.status(404).json({ error: 'El código de invitación no existe o ya fue usado' });
      return;
    }
  }

  const user = { id: uid(), email: normalized, name };
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(
    user.id,
    user.email,
    bcrypt.hashSync(password, 10),
    user.name,
  );

  let joined = false;
  if (inviteCode) {
    const result = joinByCode(user.id, inviteCode);
    joined = result.ok;
  }

  issueToken(res, user);
  res.status(201).json({ user, joined });
});

authRouter.post('/login', loginLimit, (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const row = db
    .prepare('SELECT id, email, name, password_hash AS hash FROM users WHERE email = ?')
    .get(parsed.data.email.toLowerCase().trim()) as
    | { id: string; email: string; name: string; hash: string }
    | undefined;

  if (!row || !bcrypt.compareSync(parsed.data.password, row.hash)) {
    res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    return;
  }

  const user = { id: row.id, email: row.email, name: row.name };
  issueToken(res, user);
  res.json({ user });
});

authRouter.post('/logout', (_req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const household = db
    .prepare(
      `SELECT h.id, h.name, h.currency, h.official_account AS officialAccount,
              h.contingency_pct AS contingencyPct
         FROM households h JOIN household_members m ON m.household_id = h.id
        WHERE m.user_id = ? LIMIT 1`,
    )
    .get(req.user!.id) ?? null;

  res.json({ user: req.user, household });
});

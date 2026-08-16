import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { authUrl, exchangeCode, getMessageText, searchMessages, syncHousehold } from '../services/gmail.js';

export const gmailRouter = Router();

type OAuthState = { userId: string; householdId: string };

/** El callback de Google no lleva cookies de sesión, así que el estado va firmado. */
function signState(payload: OAuthState): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '15m' });
}

gmailRouter.get('/status', requireAuth, requireHousehold, (req, res) => {
  const accounts = db
    .prepare('SELECT id, email, last_sync_at AS lastSyncAt FROM gmail_accounts WHERE household_id = ?')
    .all(req.household!.id);
  const pending = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE household_id = ? AND reviewed = 0')
    .get(req.household!.id) as { n: number };
  res.json({ configured: env.gmailEnabled, accounts, pendingReview: pending.n });
});

gmailRouter.get('/auth-url', requireAuth, requireHousehold, (req, res) => {
  if (!env.gmailEnabled) {
    res.status(503).json({ error: 'El servidor no tiene credenciales de Google configuradas' });
    return;
  }
  const state = signState({ userId: req.user!.id, householdId: req.household!.id });
  res.json({ url: authUrl(state) });
});

gmailRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  if (!code || !state) {
    res.status(400).send('Falta el código de autorización');
    return;
  }

  try {
    const payload = jwt.verify(state, env.jwtSecret) as OAuthState;
    const { email, refreshToken } = await exchangeCode(code);

    db.prepare(
      `INSERT INTO gmail_accounts (id, household_id, user_id, email, refresh_token)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (household_id, email) DO UPDATE SET refresh_token = excluded.refresh_token`,
    ).run(uid(), payload.householdId, payload.userId, email, refreshToken);

    res.redirect(`${env.webOrigin}/ajustes/gmail?conectado=${encodeURIComponent(email)}`);
  } catch (err) {
    res.status(400).send(`No se pudo conectar la cuenta: ${(err as Error).message}`);
  }
});

gmailRouter.post('/sync', requireAuth, requireHousehold, async (req, res) => {
  const parsed = z
    .object({
      maxPerRule: z.number().int().min(1).max(200).default(100),
      /** Simulación: muestra qué se importaría sin escribir nada. */
      dryRun: z.boolean().default(false),
    })
    .safeParse(req.body ?? {});
  const options = parsed.success ? parsed.data : { maxPerRule: 100, dryRun: false };
  try {
    res.json(await syncHousehold(req.household!.id, options.maxPerRule, options.dryRun));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Busca correos reales para descubrir remitentes y asuntos antes de escribir una regla. */
gmailRouter.get('/messages', requireAuth, requireHousehold, async (req, res) => {
  const parsed = z
    .object({ q: z.string().min(1).max(300), limit: z.coerce.number().int().min(1).max(25).default(10) })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Búsqueda inválida' });
    return;
  }
  try {
    res.json(await searchMessages(req.household!.id, parsed.data.q, parsed.data.limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Texto plano de un correo, para cargarlo directo en el probador de reglas. */
gmailRouter.get('/messages/:id', requireAuth, requireHousehold, async (req, res) => {
  try {
    res.json(await getMessageText(req.household!.id, req.params.id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gmailRouter.delete('/accounts/:id', requireAuth, requireHousehold, (req, res) => {
  db.prepare('DELETE FROM gmail_accounts WHERE id = ? AND household_id = ?').run(req.params.id, req.household!.id);
  res.json({ ok: true });
});

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { env } from './env.js';

export type SessionUser = { id: string; email: string; name: string };
export type HouseholdContext = { id: string; currency: string; officialAccount: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      household?: HouseholdContext;
    }
  }
}

const COOKIE = 'hogar_token';

export function issueToken(res: Response, user: SessionUser): void {
  const token = jwt.sign(user, env.jwtSecret, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearToken(res: Response): void {
  res.clearCookie(COOKIE);
}

function readToken(req: Request): string | null {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  if (!token) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret) as SessionUser & { iat: number; exp: number };
    req.user = { id: payload.id, email: payload.email, name: payload.name };
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

/** Carga el hogar del usuario. Todas las rutas de datos lo exigen. */
export function requireHousehold(req: Request, res: Response, next: NextFunction): void {
  const row = db
    .prepare(
      `SELECT h.id, h.currency, h.official_account AS officialAccount
         FROM households h
         JOIN household_members m ON m.household_id = h.id
        WHERE m.user_id = ?
        LIMIT 1`,
    )
    .get(req.user!.id) as HouseholdContext | undefined;

  if (!row) {
    res.status(409).json({ error: 'Todavía no perteneces a un hogar', code: 'NO_HOUSEHOLD' });
    return;
  }
  req.household = row;
  next();
}

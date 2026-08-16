import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { db, uid } from '../lib/db.js';
import { env } from '../lib/env.js';
import { applyRule, htmlToText, type EmailRule, type ParsedEmail } from './parser.js';
import { categorize } from './categorizer.js';

/** Sólo lectura: la app nunca necesita enviar ni modificar correos. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function oauthClient(): OAuth2Client {
  if (!env.gmailEnabled) {
    throw new Error('Gmail no está configurado: falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }
  return new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, env.google.redirectUri);
}

export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // necesario para recibir refresh_token en re-autorizaciones
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function exchangeCode(code: string): Promise<{ email: string; refreshToken: string }> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google no devolvió refresh_token. Revoca el acceso en tu cuenta y vuelve a conectar.');
  }
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
  return { email: info.data.email ?? 'desconocido', refreshToken: tokens.refresh_token };
}

function gmailFor(refreshToken: string): gmail_v1.Gmail {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: client });
}

function decode(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Recorre el árbol MIME priorizando text/plain y cayendo a text/html. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart): void => {
    if (part.mimeType === 'text/plain') plain.push(decode(part.body?.data));
    else if (part.mimeType === 'text/html') html.push(decode(part.body?.data));
    part.parts?.forEach(walk);
  };
  walk(payload);

  const plainText = plain.join('\n').trim();
  if (plainText) return plainText;
  return htmlToText(html.join('\n'));
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const found = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

export type SyncResult = {
  imported: number;
  skipped: number;
  scanned: number;
  errors: string[];
  byRule: Record<string, number>;
};

/**
 * Recorre las reglas activas del hogar, busca en cada cuenta de Gmail conectada
 * y crea las transacciones que falten. La deduplicación es por id de mensaje de
 * Gmail (índice único household_id + source_msg_id), así que re-sincronizar es seguro.
 */
export async function syncHousehold(householdId: string, maxPerRule = 100): Promise<SyncResult> {
  const result: SyncResult = { imported: 0, skipped: 0, scanned: 0, errors: [], byRule: {} };

  const accounts = db
    .prepare('SELECT id, email, refresh_token AS refreshToken FROM gmail_accounts WHERE household_id = ?')
    .all(householdId) as { id: string; email: string; refreshToken: string }[];

  if (accounts.length === 0) {
    result.errors.push('No hay ninguna cuenta de Gmail conectada.');
    return result;
  }

  const rules = db
    .prepare('SELECT * FROM email_rules WHERE household_id = ? AND enabled = 1 ORDER BY priority')
    .all(householdId) as (EmailRule & { gmail_query: string })[];

  if (rules.length === 0) {
    result.errors.push('No hay reglas de correo activas.');
    return result;
  }

  const seen = db.prepare('SELECT 1 FROM transactions WHERE household_id = ? AND source_msg_id = ?');
  const insert = db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, account_label, installments, source, source_msg_id, raw_snippet, reviewed)
     VALUES (@id, @household_id, @occurred_on, @amount, @type, @scope, 'oficial', NULL, @category_id,
        @merchant, @description, @account_label, @installments, 'gmail', @source_msg_id, @raw_snippet, 0)`,
  );

  for (const account of accounts) {
    const gmail = gmailFor(account.refreshToken);

    for (const rule of rules) {
      try {
        const list = await gmail.users.messages.list({
          userId: 'me',
          q: rule.gmail_query,
          maxResults: maxPerRule,
        });
        const messages = list.data.messages ?? [];
        result.scanned += messages.length;

        for (const ref of messages) {
          if (!ref.id) continue;
          if (seen.get(householdId, ref.id)) {
            result.skipped += 1;
            continue;
          }

          const full = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
          const msg = full.data;
          const email: ParsedEmail = {
            from: header(msg, 'From'),
            subject: header(msg, 'Subject'),
            body: extractBody(msg.payload ?? undefined),
            internalDate: Number(msg.internalDate ?? Date.now()),
          };

          const movement = applyRule(email, rule);
          if (!movement) {
            result.skipped += 1;
            continue;
          }

          insert.run({
            id: uid(),
            household_id: householdId,
            occurred_on: movement.occurredOn,
            amount: movement.amount,
            type: rule.type,
            scope: rule.scope,
            category_id: categorize(householdId, movement.merchant ?? email.subject),
            merchant: movement.merchant,
            description: email.subject.slice(0, 200),
            account_label: movement.account,
            installments: movement.installments,
            source_msg_id: ref.id,
            raw_snippet: (msg.snippet ?? email.body).slice(0, 500),
          });

          result.imported += 1;
          result.byRule[rule.name] = (result.byRule[rule.name] ?? 0) + 1;
        }
      } catch (err) {
        result.errors.push(`${account.email} · ${rule.name}: ${(err as Error).message}`);
      }
    }

    db.prepare("UPDATE gmail_accounts SET last_sync_at = datetime('now') WHERE id = ?").run(account.id);
  }

  return result;
}

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { env } from '../lib/env.js';
import {
  buscarMensajesImap,
  explicarErrorImap,
  guardarCuenta,
  probarCredencial,
  sincronizarImap,
  textoDeMensajeImap,
} from '../services/imap.js';
import { cuentasEscuchando, vigilarCorreo } from '../services/vigilanteCorreo.js';

export const imapRouter = Router();

/** Gmail sobre IMAP; sirve de valor por defecto porque es el caso de siempre. */
const POR_DEFECTO = { host: 'imap.gmail.com', port: 993, carpeta: 'INBOX' };

const cuentaSchema = z.object({
  // No se exige formato de correo: en Gmail el usuario es la dirección, pero
  // otros servidores usan un nombre de usuario a secas. Abajo se comprueba que
  // sea un correo cuando el servidor es el de Google, que es donde equivocarse
  // tiene un mensaje claro que dar.
  email: z.string().min(3).max(320),
  // La contraseña de aplicación de Google viene en grupos de cuatro; se acepta
  // con o sin espacios porque se copia y pega tal como Google la muestra.
  secreto: z.string().min(8).max(200),
  host: z.string().min(3).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  carpeta: z.string().min(1).max(200).optional(),
});

imapRouter.get('/status', requireAuth, requireHousehold, (req, res) => {
  const accounts = db
    .prepare(
      `SELECT id, email, host, port, carpeta, last_sync_at AS lastSyncAt
       FROM imap_accounts WHERE household_id = ?`,
    )
    .all(req.household!.id) as { email: string }[];

  const escuchando = cuentasEscuchando();
  res.json({
    accounts: accounts.map((a) => ({ ...a, escuchando: escuchando.includes(a.email) })),
    tiempoReal: env.correo.tiempoReal,
    sondeoMinutos: env.correo.sondeoMinutos,
    porDefecto: POR_DEFECTO,
  });
});

/**
 * Conectar una cuenta.
 *
 * La credencial se prueba contra el servidor antes de guardarla: si está mal,
 * el usuario se entera acá y no cuando los gastos dejen de aparecer.
 */
imapRouter.post('/accounts', requireAuth, requireHousehold, async (req, res) => {
  const parsed = cuentaSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Revisa el correo y la contraseña de aplicación.' });
    return;
  }

  const esGmail = (parsed.data.host?.trim() || POR_DEFECTO.host).includes('gmail.com');
  if (esGmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parsed.data.email.trim())) {
    res.status(400).json({ error: 'En Gmail el usuario es tu dirección de correo completa.' });
    return;
  }

  const datos = {
    email: parsed.data.email.trim(),
    // Google muestra la contraseña separada en grupos; los espacios no son parte.
    secreto: parsed.data.secreto.replace(/\s+/g, ''),
    host: parsed.data.host?.trim() || POR_DEFECTO.host,
    port: parsed.data.port ?? POR_DEFECTO.port,
    carpeta: parsed.data.carpeta?.trim() || POR_DEFECTO.carpeta,
  };

  try {
    const buzon = await probarCredencial(datos);
    guardarCuenta({ ...datos, householdId: req.household!.id, userId: req.user!.id });
    // La conexión en vivo se ajusta al toque: si no, habría que reiniciar el
    // servidor para que empiece a escuchar la cuenta recién agregada.
    if (env.correo.tiempoReal) vigilarCorreo(env.correo.sondeoMinutos);
    res.json({ ok: true, carpeta: buzon.carpeta, mensajes: buzon.mensajes });
  } catch (err) {
    res.status(400).json({ error: explicarErrorImap(err) });
  }
});

imapRouter.delete('/accounts/:id', requireAuth, requireHousehold, (req, res) => {
  db.prepare('DELETE FROM imap_accounts WHERE id = ? AND household_id = ?').run(
    req.params.id,
    req.household!.id,
  );
  if (env.correo.tiempoReal) vigilarCorreo(env.correo.sondeoMinutos);
  res.json({ ok: true });
});

imapRouter.post('/sync', requireAuth, requireHousehold, async (req, res) => {
  const dryRun = req.body?.dryRun === true;
  try {
    res.json(await sincronizarImap(req.household!.id, 100, dryRun));
  } catch (err) {
    res.status(500).json({ error: explicarErrorImap(err) });
  }
});

imapRouter.get('/messages', requireAuth, requireHousehold, async (req, res) => {
  const consulta = typeof req.query.q === 'string' ? req.query.q : '';
  if (!consulta.trim()) {
    res.status(400).json({ error: 'Falta la búsqueda.' });
    return;
  }
  try {
    res.json(await buscarMensajesImap(req.household!.id, consulta, 10));
  } catch (err) {
    res.status(500).json({ error: explicarErrorImap(err) });
  }
});

/**
 * El identificador va como parámetro de consulta y no en la ruta: un Message-ID
 * es texto libre entre ángulos y puede traer barras, que partirían la ruta en
 * dos.
 */
imapRouter.get('/message', requireAuth, requireHousehold, async (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) {
    res.status(400).json({ error: 'Falta el identificador del correo.' });
    return;
  }
  try {
    res.json(await textoDeMensajeImap(req.household!.id, id));
  } catch (err) {
    res.status(404).json({ error: explicarErrorImap(err) });
  }
});

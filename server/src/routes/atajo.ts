import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../lib/db.js';
import { requireAuth, requireHousehold } from '../lib/auth.js';
import { categorize } from '../services/categorizer.js';
import {
  crearClave,
  duenoDeLaClave,
  leerComercio,
  leerMonto,
  listarClaves,
  revocarClave,
} from '../services/atajo.js';

/**
 * La puerta por la que entra una compra desde el iPhone.
 *
 * Banco Falabella no manda correo por las compras con tarjeta —sólo por
 * transferencias—, así que el camino por IMAP, que resuelve todo lo demás, no
 * las ve. Lo único que las ve en el momento es el teléfono: al pagar con una
 * tarjeta de Apple Wallet, iOS puede disparar una automatización de Atajos que
 * entrega el monto y el comercio. Esta ruta es lo que esa automatización llama.
 *
 * Todo lo que entra por acá queda **sin revisar** a propósito. El disparador de
 * iOS tiene fama ganada de perder eventos en silencio, y además sólo ve lo que
 * se paga acercando el teléfono: una compra por internet con el número de la
 * tarjeta no pasa por acá. Así que esto es un adelanto, no la verdad; la verdad
 * sigue siendo la cartola, y lo que entró por acá se confirma contra ella.
 */
export const atajoRouter = Router();

/* --------------------- Lo que llama el Atajo del iPhone -------------------- */

const compraEntrante = z.object({
  /** Como lo manda iOS: "38.450", "38450", "$38.450" o ya un número. */
  monto: z.union([z.string(), z.number()]),
  comercio: z.string().max(200).optional(),
  /** Para distinguir dos tarjetas del mismo hogar en la lista. */
  tarjeta: z.string().max(80).optional(),
  /** ISO. Sin esto, hoy: el Atajo se dispara en el momento de la compra. */
  fecha: z.string().optional(),
});

/**
 * Autenticación por llave, no por sesión.
 *
 * Va en un middleware propio y no en `requireAuth` porque esta llave puede
 * mucho menos que una sesión: sólo crear un movimiento. Mezclarlas haría que un
 * día alguien, sin querer, le diera a una llave de Atajo el poder de cerrar un
 * mes.
 */
atajoRouter.post('/movimiento', (req, res) => {
  const cabecera = req.headers.authorization;
  const clave = cabecera?.startsWith('Bearer ') ? cabecera.slice(7).trim() : null;
  if (!clave) {
    res.status(401).json({ error: 'Falta la llave del atajo' });
    return;
  }
  const dueno = duenoDeLaClave(clave);
  if (!dueno) {
    res.status(401).json({ error: 'Llave inválida o revocada' });
    return;
  }

  const parsed = compraEntrante.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const monto = leerMonto(parsed.data.monto);
  if (monto == null) {
    // El mensaje nombra lo que llegó: si el Atajo manda el monto con un formato
    // raro, esto es lo único que va a tener el usuario para darse cuenta.
    res.status(400).json({ error: `No pude leer el monto "${String(parsed.data.monto).slice(0, 40)}"` });
    return;
  }

  const comercio = leerComercio(parsed.data.comercio);
  const fecha = (() => {
    const cruda = parsed.data.fecha;
    if (cruda && /^\d{4}-\d{2}-\d{2}/.test(cruda)) return cruda.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  })();

  /*
   * El mismo pago no puede entrar dos veces.
   *
   * La automatización de iOS a veces se ejecuta más de una vez, y con una app
   * de plata eso significa un gasto duplicado que alguien tiene que cazar a
   * mano. Dos compras idénticas —mismo monto, mismo comercio, mismo día, misma
   * llave— en menos de dos minutos son casi con certeza la misma: se responde
   * que ya estaba, sin crear nada y sin tratarlo como error.
   */
  const yaEstaba = db
    .prepare(
      `SELECT id FROM transactions
        WHERE household_id = ? AND source = 'atajo'
          AND amount = ? AND occurred_on = ?
          AND IFNULL(merchant, '') = IFNULL(?, '')
          AND created_at > datetime('now', '-2 minutes')
        LIMIT 1`,
    )
    .get(dueno.householdId, monto, fecha, comercio) as { id: string } | undefined;
  if (yaEstaba) {
    res.status(200).json({ ok: true, id: yaEstaba.id, duplicado: true });
    return;
  }

  const id = uid();
  db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, period, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, account_label, source, reviewed)
     VALUES (?, ?, ?, ?, ?, 'gasto', 'comun', 'oficial', NULL, ?, ?, ?, ?, 'atajo', 0)`,
  ).run(
    id,
    dueno.householdId,
    fecha,
    fecha.slice(0, 7),
    monto,
    categorize(dueno.householdId, comercio),
    comercio,
    // Queda dicho de dónde vino: al revisarlo, saber que lo trajo el teléfono y
    // no una persona explica por qué puede estar incompleto.
    'Entró desde Apple Pay',
    parsed.data.tarjeta?.slice(0, 80) ?? null,
  );

  res.status(201).json({ ok: true, id, monto, comercio });
});

/* ------------------------ La administración de llaves ---------------------- */

atajoRouter.use(requireAuth, requireHousehold);

atajoRouter.get('/claves', (req, res) => {
  res.json({ claves: listarClaves(req.household!.id, req.user!.id) });
});

atajoRouter.post('/claves', (req, res) => {
  const parsed = z.object({ nombre: z.string().max(60).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nombre inválido' });
    return;
  }
  const { clave, id } = crearClave(req.household!.id, req.user!.id, parsed.data.nombre ?? '');
  // La llave completa viaja una sola vez, acá. Después ya no existe en ninguna
  // parte más que en el teléfono de quien la copió.
  res.status(201).json({ id, clave });
});

atajoRouter.delete('/claves/:id', (req, res) => {
  const ok = revocarClave(req.params.id, req.household!.id, req.user!.id);
  if (!ok) {
    res.status(404).json({ error: 'Esa llave no existe o ya estaba revocada' });
    return;
  }
  res.json({ ok: true });
});

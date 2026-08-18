import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, uid } from '../lib/db.js';
import { cifrar, descifrar } from '../lib/cripto.js';
import { applyRule, htmlToText, type EmailRule, type ParsedEmail } from './parser.js';
import { categorize } from './categorizer.js';
import { calza, calzaEncabezado, criteriosImap, interpretarConsulta } from './consultaCorreo.js';
import type { MessagePreview, SyncResult } from './gmail.js';

/**
 * Lectura del correo por IMAP con contraseña de aplicación.
 *
 * Es el mismo trabajo que hace services/gmail.ts —buscar, parsear con las
 * reglas del hogar, categorizar y guardar sin repetir— por otra puerta. La
 * diferencia está en la credencial: OAuth en modo prueba caduca cada siete días
 * y obliga a reconectar; una contraseña de aplicación no caduca hasta que la
 * revoquen. Para dos personas que sólo quieren que los gastos entren solos, eso
 * es la diferencia entre que funcione y que no.
 *
 * La deduplicación es por `Message-ID`, la cabecera que identifica al correo, y
 * no por el identificador que asigna el servidor: el UID de IMAP cambia si la
 * carpeta se recrea, y entonces todo entraría de nuevo.
 */

export type CuentaImap = {
  id: string;
  email: string;
  host: string;
  port: number;
  carpeta: string;
};

/** Prefijo del identificador, para no confundirlo con uno de la API de Gmail. */
const PREFIJO = 'imap:';

function cuentas(householdId: string): CuentaImap[] {
  return db
    .prepare('SELECT id, email, host, port, carpeta FROM imap_accounts WHERE household_id = ?')
    .all(householdId) as CuentaImap[];
}

function secretoDe(cuentaId: string): string {
  const fila = db.prepare('SELECT secreto FROM imap_accounts WHERE id = ?').get(cuentaId) as
    | { secreto: string }
    | undefined;
  if (!fila) throw new Error('La cuenta de correo ya no existe.');
  return descifrar(fila.secreto);
}

async function conectar(cuenta: CuentaImap, secreto: string): Promise<ImapFlow> {
  const cliente = new ImapFlow({
    host: cuenta.host,
    port: cuenta.port,
    secure: true,
    auth: { user: cuenta.email, pass: secreto },
    // La librería registra cada comando IMAP; en producción sólo ensucia.
    logger: false,
  });
  await cliente.connect();
  return cliente;
}

/** Traduce los errores del servidor de correo a algo accionable. */
export function explicarErrorImap(err: unknown): string {
  const mensaje = (err as Error).message ?? String(err);
  const texto = mensaje.toLowerCase();

  // imapflow marca el fallo de autenticación en el error; el texto lo pone cada
  // servidor a su manera y no sirve para reconocerlo.
  const fallóAutenticación =
    (err as { authenticationFailed?: boolean }).authenticationFailed === true ||
    texto.includes('invalid credentials') ||
    texto.includes('authentication');

  if (fallóAutenticación) {
    return (
      'El servidor rechazó la contraseña. En Gmail tiene que ser una contraseña de aplicación ' +
      '(16 caracteres, generada en la cuenta de Google con la verificación en dos pasos activada), ' +
      'no la contraseña normal.'
    );
  }
  if (texto.includes('enotfound') || texto.includes('eai_again')) {
    return `No se encontró el servidor de correo. Revisa la dirección del servidor IMAP.`;
  }
  if (texto.includes('econnrefused') || texto.includes('etimedout') || texto.includes('timeout')) {
    return 'No se pudo conectar al servidor de correo. Revisa el puerto (993 para Gmail) o intenta de nuevo.';
  }
  if (texto.includes('certificate')) {
    return 'El certificado del servidor de correo no es válido.';
  }
  if (texto.includes('nonexistent') || texto.includes('does not exist')) {
    return 'La carpeta indicada no existe en el buzón.';
  }
  return mensaje;
}

/**
 * Prueba una credencial antes de guardarla.
 *
 * Guardar primero y descubrir después que la contraseña estaba mal deja una
 * cuenta rota en la lista y al usuario sin saber qué falló.
 */
export async function probarCredencial(datos: {
  email: string;
  secreto: string;
  host: string;
  port: number;
  carpeta: string;
}): Promise<{ carpeta: string; mensajes: number }> {
  const cliente = await conectar(
    { id: 'prueba', email: datos.email, host: datos.host, port: datos.port, carpeta: datos.carpeta },
    datos.secreto,
  );
  try {
    const buzon = await cliente.mailboxOpen(datos.carpeta, { readOnly: true });
    return { carpeta: buzon.path, mensajes: buzon.exists };
  } finally {
    await cliente.logout().catch(() => undefined);
  }
}

export function guardarCuenta(datos: {
  householdId: string;
  userId: string;
  email: string;
  secreto: string;
  host: string;
  port: number;
  carpeta: string;
}): void {
  db.prepare(
    `INSERT INTO imap_accounts (id, household_id, user_id, email, secreto, host, port, carpeta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (household_id, email) DO UPDATE SET
       secreto = excluded.secreto, host = excluded.host,
       port = excluded.port, carpeta = excluded.carpeta`,
  ).run(
    uid(),
    datos.householdId,
    datos.userId,
    datos.email,
    cifrar(datos.secreto),
    datos.host,
    datos.port,
    datos.carpeta,
  );
}

type CorreoBajado = {
  messageId: string;
  from: string;
  subject: string;
  body: string;
  fecha: Date;
};

/** Baja y normaliza los correos de una carpeta que calcen con la consulta. */
async function bajarCorreos(
  cliente: ImapFlow,
  cuenta: CuentaImap,
  consulta: ReturnType<typeof interpretarConsulta>,
  maximo: number,
): Promise<CorreoBajado[]> {
  const cerrojo = await cliente.getMailboxLock(cuenta.carpeta);
  try {
    const criterios = criteriosImap(consulta);
    const uids = (await cliente.search(criterios, { uid: true })) || [];
    // Los más nuevos primero: si el buzón tiene años de correos, interesan los
    // últimos, no los primeros que devuelva el servidor.
    const recientes = uids.slice(-maximo);
    if (recientes.length === 0) return [];

    // Primera pasada por encabezados: descartar sin bajar el cuerpo, que es lo
    // que pesa. Sólo sirve si la consulta no exige palabras en el texto.
    const candidatos: number[] = [];
    for await (const mensaje of cliente.fetch(recientes, { uid: true, envelope: true }, { uid: true })) {
      const de = (mensaje.envelope?.from ?? [])
        .map((d) => `${d.name ?? ''} <${d.address ?? ''}>`)
        .join(', ');
      const asunto = mensaje.envelope?.subject ?? '';
      if (consulta.texto.length > 0 || calzaEncabezado(consulta, { from: de, subject: asunto })) {
        candidatos.push(mensaje.uid);
      }
    }
    if (candidatos.length === 0) return [];

    const correos: CorreoBajado[] = [];
    for await (const mensaje of cliente.fetch(candidatos, { uid: true, source: true }, { uid: true })) {
      if (!mensaje.source) continue;
      const parseado = await simpleParser(mensaje.source);
      const cuerpo = parseado.text?.trim() || htmlToText(parseado.html || '');
      correos.push({
        // Sin Message-ID —raro, pero pasa— se cae al UID, que al menos no
        // duplica dentro de la misma carpeta.
        messageId: parseado.messageId ?? `uid-${cuenta.email}-${mensaje.uid}`,
        from: parseado.from?.text ?? '',
        subject: parseado.subject ?? '',
        body: cuerpo,
        fecha: parseado.date ?? new Date(),
      });
    }
    return correos;
  } finally {
    cerrojo.release();
  }
}

/**
 * Recorre las reglas activas del hogar contra cada cuenta IMAP y crea los
 * movimientos que falten. Como la deduplicación es por Message-ID, volver a
 * sincronizar no duplica nada.
 */
export async function sincronizarImap(
  householdId: string,
  maxPorRegla = 100,
  dryRun = false,
): Promise<SyncResult> {
  const resultado: SyncResult = {
    imported: 0, skipped: 0, scanned: 0, errors: [], byRule: {}, preview: [], dryRun,
  };

  const lista = cuentas(householdId);
  if (lista.length === 0) {
    resultado.errors.push('No hay ninguna cuenta de correo conectada por IMAP.');
    return resultado;
  }

  const reglas = db
    .prepare('SELECT * FROM email_rules WHERE household_id = ? AND enabled = 1 ORDER BY priority')
    .all(householdId) as (EmailRule & { gmail_query: string })[];

  if (reglas.length === 0) {
    resultado.errors.push('No hay reglas de correo activas.');
    return resultado;
  }

  const visto = db.prepare('SELECT 1 FROM transactions WHERE household_id = ? AND source_msg_id = ?');
  /**
   * Message-ID ya procesados en esta misma pasada.
   *
   * Un buzón puede tener dos copias del mismo correo —un aviso reenviado, una
   * carpeta duplicada al migrar de proveedor—, y la consulta a la base no las
   * detecta entre sí porque ninguna se guardó todavía. Sin esto, la segunda
   * copia reventaría contra el índice único y se cortaría el resto de la regla.
   */
  const enEstaPasada = new Set<string>();
  const insertar = db.prepare(
    `INSERT INTO transactions
       (id, household_id, occurred_on, amount, type, scope, funded_by, user_id, category_id,
        merchant, description, account_label, installments, source, source_msg_id, raw_snippet, reviewed)
     VALUES (@id, @household_id, @occurred_on, @amount, @type, @scope, 'oficial', @user_id, @category_id,
        @merchant, @description, @account_label, @installments, 'imap', @source_msg_id, @raw_snippet, 0)`,
  );

  for (const cuenta of lista) {
    let cliente: ImapFlow | null = null;
    try {
      cliente = await conectar(cuenta, secretoDe(cuenta.id));

      for (const regla of reglas) {
        try {
          const consulta = interpretarConsulta(regla.gmail_query);
          const correos = await bajarCorreos(cliente, cuenta, consulta, maxPorRegla);
          resultado.scanned += correos.length;

          for (const correo of correos) {
            if (!calza(consulta, correo)) continue;

            const idFuente = PREFIJO + correo.messageId;
            const repetido = Boolean(visto.get(householdId, idFuente)) || enEstaPasada.has(idFuente);
            if (repetido && !dryRun) {
              resultado.skipped += 1;
              continue;
            }
            enEstaPasada.add(idFuente);

            const email: ParsedEmail = {
              from: correo.from,
              subject: correo.subject,
              body: correo.body,
              internalDate: correo.fecha.getTime(),
            };

            const movimiento = applyRule(email, regla);
            if (!movimiento) {
              resultado.skipped += 1;
              continue;
            }

            if (dryRun) {
              resultado.preview.push({
                rule: regla.name,
                amount: movimiento.amount,
                merchant: movimiento.merchant,
                occurredOn: movimiento.occurredOn,
                account: movimiento.account,
                subject: correo.subject.slice(0, 120),
                duplicate: repetido,
              });
              if (repetido) resultado.skipped += 1;
              else {
                resultado.imported += 1;
                resultado.byRule[regla.name] = (resultado.byRule[regla.name] ?? 0) + 1;
              }
              continue;
            }

            insertar.run({
              id: uid(),
              household_id: householdId,
              // A quién se le atribuye. En un aporte esto no es cosmético: la
              // liquidación suma lo que puso cada uno por su user_id, y un
              // aporte sin dueño no le cuenta a nadie.
              user_id: regla.user_id,
              occurred_on: movimiento.occurredOn,
              amount: movimiento.amount,
              type: regla.type,
              scope: regla.scope,
              category_id: categorize(householdId, movimiento.merchant ?? correo.subject),
              merchant: movimiento.merchant,
              description: correo.subject.slice(0, 200),
              account_label: movimiento.account,
              installments: movimiento.installments,
              source_msg_id: idFuente,
              raw_snippet: correo.body.slice(0, 500),
            });

            resultado.imported += 1;
            resultado.byRule[regla.name] = (resultado.byRule[regla.name] ?? 0) + 1;
          }
        } catch (err) {
          resultado.errors.push(`${cuenta.email} · ${regla.name}: ${explicarErrorImap(err)}`);
        }
      }

      if (!dryRun) {
        db.prepare("UPDATE imap_accounts SET last_sync_at = datetime('now') WHERE id = ?").run(cuenta.id);
      }
    } catch (err) {
      resultado.errors.push(`${cuenta.email}: ${explicarErrorImap(err)}`);
    } finally {
      await cliente?.logout().catch(() => undefined);
    }
  }

  return resultado;
}

/** Lista correos que calzan con una búsqueda, sin parsear ni guardar nada. */
export async function buscarMensajesImap(
  householdId: string,
  consultaTexto: string,
  limite = 10,
): Promise<{ messages: MessagePreview[]; errors: string[] }> {
  const messages: MessagePreview[] = [];
  const errors: string[] = [];
  const visto = db.prepare('SELECT 1 FROM transactions WHERE household_id = ? AND source_msg_id = ?');
  /**
   * Message-ID ya procesados en esta misma pasada.
   *
   * Un buzón puede tener dos copias del mismo correo —un aviso reenviado, una
   * carpeta duplicada al migrar de proveedor—, y la consulta a la base no las
   * detecta entre sí porque ninguna se guardó todavía. Sin esto, la segunda
   * copia reventaría contra el índice único y se cortaría el resto de la regla.
   */
  const enEstaPasada = new Set<string>();

  for (const cuenta of cuentas(householdId)) {
    let cliente: ImapFlow | null = null;
    try {
      cliente = await conectar(cuenta, secretoDe(cuenta.id));
      const consulta = interpretarConsulta(consultaTexto);
      const correos = await bajarCorreos(cliente, cuenta, consulta, limite);

      for (const correo of correos) {
        if (!calza(consulta, correo)) continue;
        messages.push({
          id: PREFIJO + correo.messageId,
          from: correo.from,
          subject: correo.subject,
          date: correo.fecha.toISOString(),
          snippet: correo.body.replace(/\s+/g, ' ').slice(0, 200),
          alreadyImported: Boolean(visto.get(householdId, PREFIJO + correo.messageId)),
        });
      }
    } catch (err) {
      errors.push(`${cuenta.email}: ${explicarErrorImap(err)}`);
    } finally {
      await cliente?.logout().catch(() => undefined);
    }
  }

  return { messages: messages.slice(0, limite), errors };
}

/** Texto de un correo puntual, para cargarlo en el probador de reglas. */
export async function textoDeMensajeImap(
  householdId: string,
  messageId: string,
): Promise<{ subject: string; from: string; body: string }> {
  const buscado = messageId.startsWith(PREFIJO) ? messageId.slice(PREFIJO.length) : messageId;
  let ultimoError: unknown = new Error('No hay cuentas de correo conectadas por IMAP.');

  for (const cuenta of cuentas(householdId)) {
    let cliente: ImapFlow | null = null;
    try {
      cliente = await conectar(cuenta, secretoDe(cuenta.id));
      const cerrojo = await cliente.getMailboxLock(cuenta.carpeta);
      try {
        const uids = (await cliente.search({ header: { 'message-id': buscado } }, { uid: true })) || [];
        if (uids.length === 0) continue;
        for await (const mensaje of cliente.fetch(uids.slice(-1), { uid: true, source: true }, { uid: true })) {
          if (!mensaje.source) continue;
          const parseado = await simpleParser(mensaje.source);
          return {
            subject: parseado.subject ?? '',
            from: parseado.from?.text ?? '',
            body: parseado.text?.trim() || htmlToText(parseado.html || ''),
          };
        }
      } finally {
        cerrojo.release();
      }
    } catch (err) {
      ultimoError = err;
    } finally {
      await cliente?.logout().catch(() => undefined);
    }
  }

  throw new Error(explicarErrorImap(ultimoError));
}

/** ¿Hay al menos una cuenta IMAP en algún hogar? Lo usa el vigilante al arrancar. */
export function hayCuentasImap(): boolean {
  const fila = db.prepare('SELECT COUNT(*) AS n FROM imap_accounts').get() as { n: number };
  return fila.n > 0;
}

export function cuentasDeTodosLosHogares(): (CuentaImap & { householdId: string })[] {
  return db
    .prepare('SELECT id, household_id AS householdId, email, host, port, carpeta FROM imap_accounts')
    .all() as (CuentaImap & { householdId: string })[];
}

export { conectar, secretoDe };

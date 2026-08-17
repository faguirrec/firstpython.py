import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../lib/env.js';

/**
 * Envío de correo por SMTP.
 *
 * Funciona con cualquier proveedor (Gmail con contraseña de aplicación, Resend,
 * Brevo, el servidor de tu hosting). Si no está configurado, no rompe nada: las
 * funciones avisan que el correo está apagado y la app sigue igual, mostrando
 * el link de invitación en pantalla.
 */

let transporte: Transporter | null = null;

function obtenerTransporte(): Transporter | null {
  if (!env.smtp.host) return null;
  if (transporte) return transporte;

  transporte = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    // 465 usa TLS directo; el resto (587, 25) negocia con STARTTLS.
    secure: env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return transporte;
}

export function correoConfigurado(): boolean {
  return Boolean(env.smtp.host);
}

export type ResultadoEnvio = { ok: true } | { ok: false; error: string };

export async function enviarCorreo(opciones: {
  para: string;
  asunto: string;
  html: string;
  texto: string;
}): Promise<ResultadoEnvio> {
  const t = obtenerTransporte();
  if (!t) {
    return { ok: false, error: 'El envío de correo no está configurado en el servidor.' };
  }

  try {
    await t.sendMail({
      from: env.smtp.from,
      to: opciones.para,
      subject: opciones.asunto,
      text: opciones.texto,
      html: opciones.html,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explicarError(err) };
  }
}

/** Verifica la conexión sin enviar nada, para el botón de prueba en Ajustes. */
export async function probarConexion(): Promise<ResultadoEnvio> {
  const t = obtenerTransporte();
  if (!t) return { ok: false, error: 'El envío de correo no está configurado en el servidor.' };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explicarError(err) };
  }
}

function explicarError(err: unknown): string {
  const mensaje = (err as Error).message ?? String(err);
  if (/invalid login|username and password not accepted|535/i.test(mensaje)) {
    return 'El usuario o la contraseña SMTP no son correctos. Con Gmail hay que usar una contraseña de aplicación, no la del correo.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(mensaje)) {
    return 'No se pudo conectar al servidor SMTP. Revisa SMTP_HOST y SMTP_PORT.';
  }
  if (/self signed|certificate/i.test(mensaje)) {
    return 'Problema con el certificado del servidor SMTP.';
  }
  return mensaje;
}

/* ------------------------------ Plantillas ------------------------------- */

const ESTILO_BASE = `
  font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
  color: #0b0b0b; line-height: 1.5;
`;

/**
 * Estructura común de los correos. Se usan estilos en línea y tablas porque los
 * clientes de correo ignoran hojas de estilo y buena parte del CSS moderno.
 */
export function envoltorio(titulo: string, contenido: string): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f4f1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f1;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e1e0d9;">
        <tr><td style="background:#2a78d6;padding:18px 22px;">
          <span style="color:#fff;font-size:17px;font-weight:600;${ESTILO_BASE}">Cuentas del Hogar</span>
        </td></tr>
        <tr><td style="padding:22px;${ESTILO_BASE}">
          <h1 style="margin:0 0 14px;font-size:19px;">${titulo}</h1>
          ${contenido}
        </td></tr>
        <tr><td style="padding:14px 22px;background:#f9f9f7;border-top:1px solid #e1e0d9;">
          <span style="font-size:12px;color:#898781;${ESTILO_BASE}">
            Enviado por la app de cuentas de tu hogar.
          </span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function boton(texto: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">
    <tr><td style="background:#2a78d6;border-radius:10px;">
      <a href="${url}" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font-weight:600;font-size:15px;${ESTILO_BASE}">${texto}</a>
    </td></tr></table>`;
}

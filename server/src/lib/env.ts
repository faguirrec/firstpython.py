import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Falta la variable de entorno ${name} (revisa server/.env)`);
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Quién puede crear una cuenta:
 *   open   — cualquiera (por defecto; sirve en local)
 *   invite — sólo con un código de invitación válido
 *   closed — nadie más (lo indicado una vez que ambos ya entraron)
 */
const SIGNUP_MODES = ['open', 'invite', 'closed'] as const;
type SignupMode = (typeof SIGNUP_MODES)[number];

function signupMode(): SignupMode {
  const value = (process.env.ALLOW_SIGNUP ?? 'open') as SignupMode;
  if (!SIGNUP_MODES.includes(value)) {
    throw new Error(`ALLOW_SIGNUP debe ser uno de: ${SIGNUP_MODES.join(', ')}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required('JWT_SECRET', isProduction ? undefined : 'dev-secret-cambiar'),
  /**
   * Origen público de la app. Render entrega la URL del servicio en
   * RENDER_EXTERNAL_URL, así que en ese caso no hay que configurar nada a mano.
   */
  webOrigin: process.env.WEB_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173',
  isProduction,
  signupMode: signupMode(),
  /**
   * Detrás de un proxy (Fly.io, Render, un túnel) el protocolo y la IP reales
   * vienen en cabeceras; sin esto las cookies seguras y el límite de intentos
   * por IP funcionan mal.
   */
  trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : isProduction,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    /**
     * A dónde vuelve Google tras autorizar. Si no se define, se deduce de la
     * dirección pública de la app: es una variable menos que configurar, y una
     * menos donde equivocarse — un carácter distinto y Google responde
     * redirect_uri_mismatch.
     */
    get redirectUri(): string {
      if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
      const base = process.env.WEB_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000';
      return `${base.replace(/\/$/, '')}/api/gmail/callback`;
    },
  },

  /** SMTP para invitaciones y reportes. Sin SMTP_HOST, el correo queda apagado. */
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'Cuentas del Hogar <no-reply@localhost>',
  },

  /**
   * Clave para disparar tareas programadas desde fuera (un cron de GitHub).
   * Sin ella, ese acceso queda cerrado.
   */
  cronSecret: process.env.CRON_SECRET ?? '',

  /**
   * Identificador de la versión desplegada. Render expone el commit en
   * RENDER_GIT_COMMIT; Fly, en FLY_MACHINE_VERSION. Sin ninguno, es local.
   */
  version:
    process.env.RENDER_GIT_COMMIT?.slice(0, 7) ??
    process.env.FLY_MACHINE_VERSION?.slice(0, 7) ??
    'local',
  get gmailEnabled() {
    return Boolean(this.google.clientId && this.google.clientSecret);
  },
};

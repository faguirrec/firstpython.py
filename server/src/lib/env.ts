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
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
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
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/api/gmail/callback',
  },
  get gmailEnabled() {
    return Boolean(this.google.clientId && this.google.clientSecret);
  },
};

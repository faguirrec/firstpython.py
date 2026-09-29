import crypto from 'node:crypto';
import { env } from './env.js';

/**
 * Cifrado de credenciales en reposo.
 *
 * La contraseña de aplicación de una cuenta de correo no es como el token de
 * OAuth: no caduca, no se puede limitar a sólo lectura y sirve tanto para leer
 * por IMAP como para enviar por SMTP. Si alguien se lleva una copia de la base,
 * eso es acceso permanente al buzón. Por eso no se guarda en claro.
 *
 * AES-256-GCM, con clave derivada del secreto del servidor. GCM además autentica
 * el texto cifrado: si la fila se altera, el descifrado falla en vez de devolver
 * basura silenciosamente.
 */

/** Etiqueta del formato, por si algún día hay que cambiar de algoritmo. */
const VERSION = 'v1';

/**
 * La derivación es cara a propósito, así que se hace una vez. Es perezosa —no al
 * importar el módulo— para que un servidor sin credenciales de correo arranque
 * igual de rápido.
 */
let claveCache: Buffer | null = null;

function clave(): Buffer {
  if (claveCache) return claveCache;
  const secreto = process.env.ENCRYPTION_KEY ?? env.jwtSecret;
  // La sal es fija: no hay dónde guardar una por instalación, y el secreto ya es
  // de alta entropía. Lo que aporta scrypt acá es el costo, no la sal.
  claveCache = crypto.scryptSync(secreto, 'myhaus-credenciales', 32);
  return claveCache;
}

export function cifrar(texto: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), cifrado.toString('base64')].join(':');
}

export function descifrar(guardado: string): string {
  const partes = guardado.split(':');
  if (partes.length !== 4 || partes[0] !== VERSION) {
    throw new Error('La credencial guardada no tiene el formato esperado.');
  }
  const [, iv, tag, cifrado] = partes;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(cifrado, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Pasa si cambió JWT_SECRET (o ENCRYPTION_KEY) después de guardar. No hay
    // forma de recuperarla: hay que volver a ingresar la contraseña.
    throw new Error(
      'No se pudo descifrar la credencial guardada. Suele pasar si cambió el secreto del servidor: ' +
        'desconecta la cuenta y vuelve a conectarla.',
    );
  }
}

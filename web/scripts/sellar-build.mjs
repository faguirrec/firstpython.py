/**
 * Sella la compilación con un identificador único.
 *   node scripts/sellar-build.mjs   (se ejecuta solo al final de `npm run build`)
 *
 * Hace dos cosas:
 *
 *  1. Reemplaza __BUILD__ en dist/sw.js. Como el archivo queda distinto en cada
 *     compilación, el navegador detecta que hay un service worker nuevo, lo
 *     instala y borra la caché anterior. Sin esto el archivo era idéntico
 *     siempre, y una app ya instalada se quedaba con la versión vieja.
 *
 *  2. Escribe dist/build.json, que el servidor lee para informar qué versión
 *     está realmente publicada. Va dentro de la imagen, así que refleja el
 *     código que corre y no el commit que disparó el despliegue.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

// El identificador sale del contenido compilado: si nada cambió, no cambia.
const archivos = fs
  .readdirSync(path.join(DIST, 'assets'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .sort();

const build = createHash('sha256').update(archivos.join('|')).digest('hex').slice(0, 10);

const rutaSw = path.join(DIST, 'sw.js');
const sw = fs.readFileSync(rutaSw, 'utf8');
if (!sw.includes('__BUILD__')) {
  console.error('sellar-build: no se encontró __BUILD__ en dist/sw.js. ¿Cambió la plantilla?');
  process.exit(1);
}
fs.writeFileSync(rutaSw, sw.replace('__BUILD__', build));

fs.writeFileSync(
  path.join(DIST, 'build.json'),
  `${JSON.stringify({ build, compiladoEn: new Date().toISOString() }, null, 2)}\n`,
);

console.log(`build ${build} · ${archivos.length} archivos`);

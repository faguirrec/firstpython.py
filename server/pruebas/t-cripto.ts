/** Cifrado de credenciales en reposo. */
import { cifrar, descifrar } from '../src/lib/cripto.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

const clave = 'abcd efgh ijkl mnop';
const a = cifrar(clave);
const b = cifrar(clave);

ok('el formato lleva versión y cuatro partes', a.startsWith('v1:') && a.split(':').length === 4, a);
ok('dos cifrados del mismo texto son distintos', a !== b);
ok('ida y vuelta', descifrar(a) === clave && descifrar(b) === clave);
ok('el texto claro no aparece en lo guardado', !a.includes(clave) && !a.includes('abcd'));

// Alterar un byte tiene que romper el descifrado, no devolver basura.
const partes = a.split(':');
const cuerpo = Buffer.from(partes[3], 'base64');
cuerpo[0] ^= 1;
partes[3] = cuerpo.toString('base64');
let detectado = false;
try { descifrar(partes.join(':')); } catch { detectado = true; }
ok('detecta que la fila fue alterada', detectado);

let formatoMalo = false;
try { descifrar('cualquier cosa'); } catch { formatoMalo = true; }
ok('rechaza un formato desconocido', formatoMalo);

const raro = '🔐 ñ á Ü ' + 'x'.repeat(500);
ok('aguanta unicode y texto largo', descifrar(cifrar(raro)) === raro);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

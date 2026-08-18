import { interpretarConsulta, criteriosImap, calza } from '../src/services/consultaCorreo.js';

const AHORA = new Date('2026-08-18T12:00:00Z');
let fallas = 0;
function ok(nombre: string, condicion: boolean) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) fallas += 1;
}

// --- Las consultas reales de las plantillas de bancos ---
const chile = interpretarConsulta(
  'from:(enviodigital@bancochile.cl OR notificaciones@bancochile.cl) newer_than:60d', AHORA);
ok('Banco de Chile: dos remitentes', chile.remitentes.length === 2 &&
   chile.remitentes[0] === 'enviodigital@bancochile.cl' &&
   chile.remitentes[1] === 'notificaciones@bancochile.cl');
ok('Banco de Chile: 60 días atrás',
   chile.desde?.toISOString().slice(0, 10) === '2026-06-19');
ok('Banco de Chile: sin texto suelto', chile.texto.length === 0);

const santander = interpretarConsulta(
  'from:(santander.cl) subject:(compra OR transacción OR cargo) newer_than:60d', AHORA);
ok('Santander: un remitente', santander.remitentes.length === 1);
ok('Santander: tres asuntos', santander.asuntos.join('|') === 'compra|transacción|cargo');

const generica = interpretarConsulta('subject:(compra OR cargo OR transacción) newer_than:30d', AHORA);
ok('Genérica: sin remitente', generica.remitentes.length === 0);
ok('Genérica: 30 días', generica.desde?.toISOString().slice(0, 10) === '2026-07-19');

// --- Unidades de tiempo ---
ok('newer_than en semanas', interpretarConsulta('newer_than:2w', AHORA).desde
   ?.toISOString().slice(0, 10) === '2026-08-04');
ok('newer_than en meses', interpretarConsulta('newer_than:1m', AHORA).desde
   ?.toISOString().slice(0, 10) === '2026-07-19');
ok('newer_than en años', interpretarConsulta('newer_than:1y', AHORA).desde
   ?.toISOString().slice(0, 10) === '2025-08-18');

// --- Criterios que se le mandan al servidor ---
ok('un solo remitente se delega al servidor', criteriosImap(santander).from === 'santander.cl');
ok('varios remitentes NO se delegan', criteriosImap(chile).from === undefined);
ok('sin fecha, igual se acota a 30 días',
   (criteriosImap(interpretarConsulta('subject:compra', AHORA)).since as Date) > new Date('2026-07-18'));

// --- El filtro fino ---
const correoChile = {
  from: 'Banco de Chile <enviodigital@bancochile.cl>',
  subject: 'Compra con Tarjeta de Crédito',
  body: 'Compra por $45.990 en JUMBO el 14/08/2026',
};
ok('calza con el remitente correcto', calza(chile, correoChile));
ok('no calza otro banco', !calza(chile, { ...correoChile, from: 'alertas@bci.cl' }));
ok('el remitente calza aunque venga con nombre', calza(santander,
   { ...correoChile, from: 'Santander <alertas@santander.cl>' }) === false ||
   calza(interpretarConsulta('from:(santander.cl)', AHORA),
         { ...correoChile, from: 'Santander <alertas@santander.cl>' }));
ok('el asunto tiene que calzar', !calza(santander,
   { from: 'x@santander.cl', subject: 'Estado de cuenta', body: '' }));
ok('basta uno de los asuntos en OR', calza(santander,
   { from: 'x@santander.cl', subject: 'Aviso de cargo en tu cuenta', body: '' }));

// --- Palabras sueltas, en AND y sobre todo el correo ---
const libre = interpretarConsulta('compra jumbo', AHORA);
ok('palabras sueltas quedan como texto', libre.texto.join('|') === 'compra|jumbo');
ok('todas las palabras deben aparecer', calza(libre, correoChile));
ok('si falta una, no calza', !calza(libre, { ...correoChile, body: 'Compra en LIDER' }));

// --- Casos que no deberían romperlo ---
ok('consulta vacía calza con todo', calza(interpretarConsulta('', AHORA), correoChile));
ok('operador desconocido no ensucia el texto',
   interpretarConsulta('has:attachment compra', AHORA).texto.includes('compra'));
ok('comillas se limpian',
   interpretarConsulta('subject:"estado de cuenta"', AHORA).asuntos[0] === 'estado de cuenta');
ok('to: se reconoce y no queda como texto',
   !interpretarConsulta('to:yo@gmail.com compra', AHORA).texto.includes('to:yo@gmail.com'));
ok('mayúsculas en el operador', interpretarConsulta('FROM:banco.cl', AHORA).remitentes[0] === 'banco.cl');
ok('el filtro no distingue mayúsculas',
   calza(interpretarConsulta('from:BANCOCHILE.CL', AHORA), correoChile));

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

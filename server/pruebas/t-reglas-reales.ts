/**
 * Las plantillas contra los formatos reales de correo que usa el hogar.
 *
 * Los HTML de abajo son reconstrucciones de dos avisos verdaderos: una
 * transferencia enviada desde Mercado Pago y el comprobante que emite Banco de
 * Chile cuando alguien transfiere a esa cuenta. El segundo importa más de lo que
 * parece: Mercado Pago no avisa lo que entra, así que ese comprobante es la
 * única evidencia de que hubo un aporte.
 */
import { applyRule, htmlToText, parsePeriod, type EmailRule } from '../src/services/parser.js';
import { BANK_TEMPLATES } from '../src/services/bankTemplates.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

function regla(key: string, extra: Partial<EmailRule> = {}): EmailRule {
  const t = BANK_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`No existe la plantilla ${key}`);
  return {
    id: key, name: t.name,
    amount_regex: t.amount_regex, merchant_regex: t.merchant_regex,
    date_regex: t.date_regex, account_regex: t.account_regex,
    period_regex: t.period_regex ?? null,
    card_filter: null, must_contain: t.must_contain ?? null,
    must_not_contain: t.must_not_contain ?? null,
    type: t.type, scope: t.scope, account_label: t.account_label,
    user_id: null,
    ...extra,
  };
}

const FECHA_CORREO = new Date('2026-08-14T13:40:00-04:00').getTime();

// ---------------------------------------------------------------- enviada ---
const mercadoPago = {
  from: 'Mercado Pago <info@mercadopago.com>',
  subject: 'Tu transferencia fue enviada',
  internalDate: FECHA_CORREO,
  body: htmlToText(`
    <table><tr><td><h1>Ya enviamos tu transferencia de<br>$ 9.000</h1></td></tr>
    <tr><td><p><b>Datos del beneficiario</b></p>
    <p>Nombre y apellido: <b>Diego Farcuh</b></p>
    <p>Entidad: <b>Mercado Pago</b></p>
    <p>N&uacute;mero de cuenta: </p></td></tr></table>`),
};

const enviada = applyRule(mercadoPago, regla('mercadopago_enviada'));
ok('Mercado Pago: reconoce el correo', enviada !== null);
ok('Mercado Pago: monto $ 9.000 (con espacio y salto de línea)', enviada?.amount === 9000, enviada?.amount);
ok('Mercado Pago: saca el beneficiario', /Diego Farcuh/.test(enviada?.merchant ?? ''), enviada?.merchant);
ok('Mercado Pago: sin fecha en el cuerpo, usa la del correo',
   enviada?.occurredOn === '2026-08-14', enviada?.occurredOn);
ok('Mercado Pago: es un gasto común', regla('mercadopago_enviada').type === 'gasto');

// --------------------------------------------------------------- recibida ---
function comprobanteChile(banco: string, monto: string, quien: string, asunto = '') {
  return {
    from: 'Banco de Chile <enviodigital@bancochile.cl>',
    subject: 'Comprobante de transferencia electrónica de fondos',
    internalDate: new Date('2026-08-18T09:00:00-04:00').getTime(),
    body: htmlToText(`
      <h2>Comprobante de transferencia electr&oacute;nica de fondos</h2>
      <p>Estimado(a): <b>Francisco Aguirre</b></p>
      <p>Te informamos que nuestro(a) cliente <b>${quien}</b> ha efectuado una
      transferencia de fondos a tu cuenta con el siguiente detalle:</p>
      <table>
        <tr><td>Fecha</td><td>18/08/2026</td></tr>
        <tr><td>Asunto</td><td>${asunto}</td></tr>
      </table>
      <table>
        <tr><td>Nombre y Apellido</td><td>Francisco Aguirre</td></tr>
        <tr><td>Rut</td><td>17685592-4</td></tr>
        <tr><td>Banco</td><td>${banco}</td></tr>
        <tr><td>Cuenta destino</td><td>Cuenta Vista<br>00-105-05465-00</td></tr>
      </table>
      <table><tr><td>Monto</td><td>${monto}</td></tr></table>`),
  };
}

const aporte = applyRule(
  comprobanteChile('Banco Falabella', '$14.000', 'Francisco Javier Aguirre'),
  regla('bancochile_transferencia_recibida'),
);
ok('Banco de Chile: reconoce el comprobante', aporte !== null);
ok('Banco de Chile: monto $14.000', aporte?.amount === 14000, aporte?.amount);
ok('Banco de Chile: fecha del comprobante, no del correo',
   aporte?.occurredOn === '2026-08-18', aporte?.occurredOn);
ok('Banco de Chile: saca quién transfirió',
   /Francisco Javier Aguirre/.test(aporte?.merchant ?? ''), aporte?.merchant);
ok('Banco de Chile: saca la cuenta de destino',
   (aporte?.account ?? '').includes('00-105-05465-00'), aporte?.account);
ok('Banco de Chile: es un aporte', regla('bancochile_transferencia_recibida').type === 'aporte');

// Lo que NO debe entrar: plata recibida en una cuenta personal, no en la del hogar.
const aCuentaPersonal = applyRule(
  comprobanteChile('Banco de Chile', '$300.000', 'La Empresa SpA'),
  regla('bancochile_transferencia_recibida'),
);
ok('una transferencia a la cuenta personal NO entra como aporte del hogar',
   aCuentaPersonal === null, aCuentaPersonal);

// Separar por persona: dos copias de la regla, una por cada uno.
const soloFrancisco = regla('bancochile_transferencia_recibida', {
  must_contain: 'Banco Falabella; Francisco Javier Aguirre',
  user_id: 'usuario-francisco',
});
ok('la regla de Francisco toma su transferencia',
   applyRule(comprobanteChile('Banco Falabella', '$14.000', 'Francisco Javier Aguirre'), soloFrancisco) !== null);
ok('la regla de Francisco NO toma la de otra persona',
   applyRule(comprobanteChile('Banco Falabella', '$50.000', 'Carolina Perez'), soloFrancisco) === null);

// ------------------- el mes al que cuenta la transferencia -------------------
/**
 * El caso que motivó todo esto: el sueldo se transfiere el 25 de agosto con el
 * comentario "Mensualidad septiembre", y esa plata es de septiembre. Si el mes
 * saliera de la fecha, el aporte quedaría en agosto y septiembre se vería sin
 * un peso puesto.
 */
const mensualidad = applyRule(
  comprobanteChile('Banco Falabella', '$450.000', 'Sofia Ignacia Zuniga', 'Mensualidad septiembre'),
  regla('bancochile_transferencia_recibida'),
);
ok('la transferencia de la mensualidad entra', mensualidad !== null);
ok('la fecha sigue siendo la del comprobante',
   mensualidad?.occurredOn === '2026-08-18', mensualidad?.occurredOn);
ok('pero cuenta en septiembre, no en agosto',
   mensualidad?.period === '2026-09', mensualidad?.period);

// Sin comentario no se inventa nada: el mes queda en manos de la fecha.
const sinAsunto = applyRule(
  comprobanteChile('Banco Falabella', '$450.000', 'Sofia Ignacia Zuniga'),
  regla('bancochile_transferencia_recibida'),
);
ok('sin comentario, el mes lo decide la fecha',
   sinAsunto?.period === null, sinAsunto?.period);

// Un comentario cualquiera tampoco puede mover el mes a ninguna parte.
const otroAsunto = applyRule(
  comprobanteChile('Banco Falabella', '$30.000', 'Sofia Ignacia Zuniga', 'Regalo'),
  regla('bancochile_transferencia_recibida'),
);
ok('un comentario sin mes no cambia nada', otroAsunto?.period === null, otroAsunto?.period);

// El RUT que viene abajo en el mismo correo no puede colarse como año.
ok('el RUT de más abajo no se lee como año',
   mensualidad?.period === '2026-09', mensualidad?.period);

// --- parsePeriod, los formatos que puede escribir una persona ---
ok('"septiembre" en agosto es el septiembre que viene',
   parsePeriod('septiembre', '2026-08') === '2026-09', parsePeriod('septiembre', '2026-08'));
ok('"diciembre" en enero es el diciembre que pasó',
   parsePeriod('diciembre', '2027-01') === '2026-12', parsePeriod('diciembre', '2027-01'));
ok('con año escrito manda el año escrito',
   parsePeriod('marzo 2028', '2026-08') === '2028-03', parsePeriod('marzo 2028', '2026-08'));
ok('entiende 2026-09', parsePeriod('2026-09', '2026-08') === '2026-09');
ok('entiende 09/2026', parsePeriod('09/2026', '2026-08') === '2026-09');
ok('acepta la abreviatura', parsePeriod('sept.', '2026-08') === '2026-09', parsePeriod('sept.', '2026-08'));
ok('encuentra el mes aunque venga con más palabras',
   parsePeriod('Mensualidad septiembre', '2026-08') === '2026-09');
ok('un texto sin mes no devuelve nada', parsePeriod('pago de arriendo', '2026-08') === null);
ok('un mes inexistente no devuelve nada', parsePeriod('13/2026', '2026-08') === null,
   parsePeriod('13/2026', '2026-08'));

// ----------------------------- el correo espejo -----------------------------
/**
 * El banco avisa la misma transferencia dos veces. Estos son los dos correos
 * que llegan cuando uno se transfiere a su propia cuenta del hogar: si las dos
 * reglas los tomaran, la misma plata entraría como gasto y como aporte.
 */
function comprobanteEnviado(destinatario: string, banco: string, cuenta: string, monto: string) {
  return {
    from: 'Banco de Chile <enviodigital@bancochile.cl>',
    subject: 'Comprobante de Transferencia a terceros',
    internalDate: new Date('2026-08-18T10:00:00-04:00').getTime(),
    body: htmlToText(`
      <h2>Comprobante de Transferencia a terceros</h2>
      <p>Estimado(a): <b>Francisco Javier Aguirre</b></p>
      <p>Te informamos que has realizado una Transferencia a terceros en forma
      exitosa con el siguiente detalle:</p>
      <table>
        <tr><td>Origen</td><td></td></tr>
        <tr><td>Tipo de Cuenta</td><td>Cuenta Corriente</td></tr>
        <tr><td>N&ordm; de Cuenta</td><td>00-000-00000-00</td></tr>
      </table>
      <table>
        <tr><td>Destino</td><td></td></tr>
        <tr><td>Nombre y Apellido</td><td>${destinatario}</td></tr>
        <tr><td>Tipo de Cuenta</td><td>Cuenta Corriente</td></tr>
        <tr><td>N&ordm; de Cuenta</td><td>${cuenta}</td></tr>
        <tr><td>Banco</td><td>${banco}</td></tr>
      </table>
      <table><tr><td>Monto</td><td>${monto}</td></tr></table>`),
  };
}

const reglaEnviada = regla('bancochile_transferencia_enviada');

// A un tercero: es un gasto de verdad.
const aTercero = applyRule(
  comprobanteEnviado('Carolina Perez', 'Banco Chile/Edwards', '00-111-11111-11', '$50.000'),
  reglaEnviada,
);
ok('una transferencia a un tercero entra como gasto', aTercero !== null);
ok('con el monto correcto', aTercero?.amount === 50000, aTercero?.amount);
ok('y con el destinatario', /Carolina Perez/.test(aTercero?.merchant ?? ''), aTercero?.merchant);

// A la cuenta del hogar: NO, porque esa plata entra como aporte por la regla
// de aportes. El filtro es el banco donde vive la cuenta común.
const aLaCasa = comprobanteEnviado('Sofia Zuniga', 'Banco Falabella', '01-983-40661-77', '$14.000');
ok('depositar a la cuenta del hogar NO entra como gasto',
   applyRule(aLaCasa, reglaEnviada) === null, applyRule(aLaCasa, reglaEnviada));

// Y el correo espejo del mismo movimiento sí entra, una sola vez, como aporte.
const espejo = comprobanteChile('Banco Falabella', '$14.000', 'Francisco Javier Aguirre');
ok('el correo espejo entra como aporte',
   applyRule(espejo, regla('bancochile_transferencia_recibida')) !== null);
ok('y ese mismo correo no entra como transferencia enviada',
   applyRule(espejo, reglaEnviada) === null);

// La plata recibida en una cuenta personal tampoco es un gasto enviado.
ok('un abono recibido no se confunde con una transferencia enviada',
   applyRule(comprobanteChile('Banco Chile/Edwards', '$21.450', 'Nicolas Esteban Calderon'),
             reglaEnviada) === null);

// ------------------------- Banco Falabella, la cuenta del hogar -------------
/**
 * Reconstrucciones de los avisos reales de la cuenta común. Los números de
 * cuenta y los RUT son inventados: los verdaderos viven en la base del hogar,
 * no en el repositorio.
 */
const CUENTA_HOGAR_BDC = '01-983-40661-77';   // como la escribe Banco de Chile
const CUENTA_HOGAR_BF = '19834066177';        // como la escribe Falabella

function depositoDesdeChile(banco: string, cuenta: string, monto: string) {
  return {
    from: 'Banco de Chile <serviciodetransferencias@bancochile.cl>',
    subject: 'Transferencia a Terceros',
    internalDate: new Date('2026-08-24T16:58:00-04:00').getTime(),
    body: htmlToText(`
      <h2>Comprobante de Transferencia a terceros</h2>
      <p>Estimado(a): <b>Francisco Javier Aguirre</b></p>
      <p>Te informamos que has realizado una Transferencia a terceros en forma
      exitosa con el siguiente detalle:</p>
      <table>
        <tr><td>Origen</td><td></td></tr>
        <tr><td>Tipo de Cuenta</td><td>Cuenta Corriente</td></tr>
        <tr><td>N&ordm; de Cuenta</td><td>00-000-00000-00</td></tr>
      </table>
      <table>
        <tr><td>Destino</td><td></td></tr>
        <tr><td>Nombre y Apellido</td><td>Sofia Zuniga</td></tr>
        <tr><td>Tipo de Cuenta</td><td>Cuenta Corriente</td></tr>
        <tr><td>N&ordm; de Cuenta</td><td>${cuenta}</td></tr>
        <tr><td>Banco</td><td>${banco}</td></tr>
      </table>
      <table><tr><td>Monto</td><td>${monto}</td></tr></table>`),
  };
}

function salidaDeFalabella(destinatario: string, banco: string, monto: string) {
  return {
    from: 'Banco Falabella <notificaciones@cl.bancofalabella.com>',
    subject: 'Transferencia de fondos realizada',
    internalDate: new Date('2026-08-24T17:00:00-04:00').getTime(),
    body: htmlToText(`
      <p>SOFIA IGNACIA, tu transferencia est&aacute; lista</p>
      <h3>Detalle</h3>
      <table>
        <tr><td>Nombre destinatario</td><td>${destinatario}</td></tr>
        <tr><td>Rut</td><td>000000000</td></tr>
        <tr><td>Banco</td><td>${banco}</td></tr>
        <tr><td>Producto</td><td>Cuenta Corriente</td></tr>
        <tr><td>N&uacute;mero de cuenta</td><td>000000000000</td></tr>
        <tr><td>Asunto</td><td>Transferencia</td></tr>
        <tr><td>Monto transferencia</td><td>${monto}</td></tr>
      </table>
      <table><tr><td>Cuenta de origen</td><td>Cuenta ${CUENTA_HOGAR_BF}</td></tr></table>
      <table>
        <tr><td>Fecha</td><td>24-08-2026</td></tr>
        <tr><td>Hora</td><td>17:00</td></tr>
        <tr><td>N&uacute;mero de operaci&oacute;n</td><td>697672114930</td></tr>
      </table>`),
  };
}

/** La copia que le llega al destinatario del mismo movimiento de arriba. */
function copiaDelDestinatario(monto: string) {
  return {
    from: 'Banco Falabella <notificaciones@cl.bancofalabella.com>',
    subject: 'Transferencia de fondos recibida',
    internalDate: new Date('2026-08-24T17:02:00-04:00').getTime(),
    body: htmlToText(`
      <p>Francisco aguirre</p>
      <p>Le informamos que hoy, 24-08-2026, nuestro(a) cliente SOFIA IGNACIA ZUNIGA
      ha instruido una transferencia de fondos a su cuenta con el siguiente detalle:</p>
      <h3>Detalle</h3>
      <table>
        <tr><td>Nombre destinatario</td><td>Francisco aguirre</td></tr>
        <tr><td>Monto transferencia</td><td>${monto}</td></tr>
      </table>
      <table><tr><td>Cuenta de origen</td><td>Cuenta ${CUENTA_HOGAR_BF}</td></tr></table>`),
  };
}

const reglaAporte = regla('bancochile_aporte_al_hogar');
const reglaSalida = regla('falabella_transferencia_enviada');
const reglaGastoChile = regla('bancochile_transferencia_enviada');

// --- Depositar a la cuenta del hogar es un aporte, no un gasto ---
const deposito = depositoDesdeChile('Banco Falabella', CUENTA_HOGAR_BDC, '$1.000');
const comoAporte = applyRule(deposito, reglaAporte);
ok('depositar a la cuenta del hogar entra como aporte', comoAporte !== null);
ok('con el monto correcto', comoAporte?.amount === 1000, comoAporte?.amount);
ok('y saca la cuenta de destino',
   (comoAporte?.account ?? '').includes('40661'), comoAporte?.account);
ok('el mismo correo NO entra además como gasto',
   applyRule(deposito, reglaGastoChile) === null);

// --- Transferir a un tercero desde el Banco de Chile sigue siendo gasto ---
const haciaOtroBanco = depositoDesdeChile('Banco Estado', '00-111-11111-11', '$50.000');
ok('una transferencia a un tercero sigue siendo gasto',
   applyRule(haciaOtroBanco, reglaGastoChile) !== null);
ok('y no se cuela como aporte al hogar', applyRule(haciaOtroBanco, reglaAporte) === null);

// --- Salidas de la cuenta del hogar ---
const pagoAlJardinero = salidaDeFalabella('Juan Perez', 'Banco Estado', '$80.000');
const salida = applyRule(pagoAlJardinero, reglaSalida);
ok('lo que sale de la cuenta del hogar entra como gasto', salida !== null);
ok('con el monto', salida?.amount === 80000, salida?.amount);
ok('con el destinatario', /Juan Perez/.test(salida?.merchant ?? ''), salida?.merchant);
ok('y con la fecha del correo en formato 24-08-2026',
   salida?.occurredOn === '2026-08-24', salida?.occurredOn);
ok('y reconoce la cuenta de origen',
   (salida?.account ?? '').includes(CUENTA_HOGAR_BF), salida?.account);

// --- Devolverse plata a una cuenta propia también es un gasto ---
/**
 * Si sale del pozo común, sale. Quién la recibió es asunto aparte: no contarlo
 * dejaría el fondo de reserva mostrando plata que ya no está.
 */
const aMiCuenta = applyRule(
  salidaDeFalabella('Francisco Aguirre', 'Banco de Chile', '$120.000'),
  reglaSalida,
);
ok('sacar plata del hogar a una cuenta propia entra como gasto', aMiCuenta !== null);
ok('por el monto completo', aMiCuenta?.amount === 120000, aMiCuenta?.amount);
ok('y es un gasto común, no personal',
   reglaSalida.type === 'gasto' && reglaSalida.scope === 'comun');

// --- Y la copia del destinatario no lo duplica ---
ok('la copia que avisa al destinatario no entra otra vez',
   applyRule(copiaDelDestinatario('$80.000'), reglaSalida) === null);

// --- Dos reglas de aporte para la misma persona: no pueden calzar las dos ---
/**
 * El banco manda dos correos por la misma transferencia. Si los dos calzaran,
 * el aporte de Sofía entraría dos veces y el mes cuadraría de más sin que nada
 * lo avise.
 */
const copiaDelQueEnvia = depositoDesdeChile('Banco Falabella', CUENTA_HOGAR_BDC, '$450.000');
ok('la copia del que envía no calza con la regla de recibida',
   applyRule(copiaDelQueEnvia, regla('bancochile_transferencia_recibida')) === null);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

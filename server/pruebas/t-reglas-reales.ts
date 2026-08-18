/**
 * Las plantillas contra los formatos reales de correo que usa el hogar.
 *
 * Los HTML de abajo son reconstrucciones de dos avisos verdaderos: una
 * transferencia enviada desde Mercado Pago y el comprobante que emite Banco de
 * Chile cuando alguien transfiere a esa cuenta. El segundo importa más de lo que
 * parece: Mercado Pago no avisa lo que entra, así que ese comprobante es la
 * única evidencia de que hubo un aporte.
 */
import { applyRule, htmlToText, type EmailRule } from '../src/services/parser.js';
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
    card_filter: null, must_contain: t.must_contain ?? null,
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
function comprobanteChile(banco: string, monto: string, quien: string) {
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
        <tr><td>Asunto</td><td></td></tr>
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
  comprobanteChile('Mercado Pago', '$14.000', 'Francisco Javier Aguirre'),
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
  must_contain: 'Mercado Pago; Francisco Javier Aguirre',
  user_id: 'usuario-francisco',
});
ok('la regla de Francisco toma su transferencia',
   applyRule(comprobanteChile('Mercado Pago', '$14.000', 'Francisco Javier Aguirre'), soloFrancisco) !== null);
ok('la regla de Francisco NO toma la de otra persona',
   applyRule(comprobanteChile('Mercado Pago', '$50.000', 'Carolina Perez'), soloFrancisco) === null);

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
process.exit(fallas === 0 ? 0 : 1);

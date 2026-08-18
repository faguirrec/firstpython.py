/**
 * Servidor IMAP de mentira para las pruebas: sirve unos correos de banco
 * chilenos sobre TLS, igual que Gmail, y no escribe nada en disco.
 */
const fs = require('fs');
const path = require('path');
const hoodiecrow = require('hoodiecrow-imap');

function correo({ de, asunto, fecha, cuerpo, id }) {
  return [
    `Message-Id: <${id}>`,
    `From: ${de}`,
    `To: yo@gmail.com`,
    `Subject: ${asunto}`,
    `Date: ${fecha}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    cuerpo,
  ].join('\r\n');
}

const AHORA = new Date();
const haceDias = (d) => new Date(AHORA.getTime() - d * 86400000).toUTCString();

const mensajes = [
  {
    raw: correo({
      id: 'chile-1@bancochile.cl',
      de: 'Banco de Chile <enviodigital@bancochile.cl>',
      asunto: 'Compra con Tarjeta de Credito',
      fecha: haceDias(2),
      cuerpo: 'Te informamos que se ha realizado una compra por $45.990 en JUMBO MAIPU el 16/08/2026 con la tarjeta terminada en 4321.',
    }),
  },
  {
    raw: correo({
      id: 'chile-2@bancochile.cl',
      de: 'Banco de Chile <enviodigital@bancochile.cl>',
      asunto: 'Compra con Tarjeta de Credito',
      fecha: haceDias(1),
      cuerpo: 'Te informamos que se ha realizado una compra por $12.500 en COPEC LAS CONDES el 17/08/2026 con la tarjeta terminada en 4321.',
    }),
  },
  {
    // Otro banco: no debe entrar con la regla de Banco de Chile.
    raw: correo({
      id: 'bci-1@bci.cl',
      de: 'BCI <alertas@bci.cl>',
      asunto: 'Notificacion de compra',
      fecha: haceDias(1),
      cuerpo: 'Compra por $9.990 en SPOTIFY.',
    }),
  },
  {
    // Del mismo banco pero sin monto: la regla no debe poder armar un movimiento.
    raw: correo({
      id: 'chile-3@bancochile.cl',
      de: 'Banco de Chile <enviodigital@bancochile.cl>',
      asunto: 'Tu estado de cuenta esta disponible',
      fecha: haceDias(3),
      cuerpo: 'Ingresa a la app para revisar tu estado de cuenta.',
    }),
  },
  {
    // Comprobante de Banco de Chile por plata que ENTRA a la cuenta del hogar.
    // Mercado Pago no avisa los abonos, así que éste es el único rastro.
    raw: correo({
      id: 'chile-abono@bancochile.cl',
      de: 'Banco de Chile <enviodigital@bancochile.cl>',
      asunto: 'Comprobante de transferencia electronica de fondos',
      fecha: haceDias(1),
      cuerpo: [
        'Te informamos que nuestro(a) cliente Francisco Javier Aguirre ha efectuado una',
        'transferencia de fondos a tu cuenta con el siguiente detalle:',
        'Fecha',
        '18/08/2026',
        'Banco',
        'Mercado Pago',
        'Cuenta destino',
        'Cuenta Vista',
        '00-105-05465-00',
        'Monto',
        '$14.000',
      ].join('\n'),
    }),
  },
  {
    // Viejo: fuera del rango de newer_than.
    raw: correo({
      id: 'chile-viejo@bancochile.cl',
      de: 'Banco de Chile <enviodigital@bancochile.cl>',
      asunto: 'Compra con Tarjeta de Credito',
      fecha: haceDias(200),
      cuerpo: 'Te informamos que se ha realizado una compra por $99.999 en TIENDA VIEJA el 01/02/2026 con la tarjeta terminada en 4321.',
    }),
  },
];

const servidor = hoodiecrow({
  plugins: ['IDLE', 'ID', 'UNSELECT', 'SPECIAL-USE', 'NAMESPACE'],
  secureConnection: true,
  credentials: {
    key: fs.readFileSync(path.join(__dirname, 'tls/llave.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
  },
  storage: { INBOX: { messages: mensajes } },
  debug: false,
});

const PUERTO = Number(process.env.PUERTO_IMAP || 9993);
servidor.listen(PUERTO, () => console.log(`IMAP de prueba en ${PUERTO}`));

module.exports = { servidor, mensajes };

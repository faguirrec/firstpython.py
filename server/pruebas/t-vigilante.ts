/**
 * ¿Llega solo? Se deja el vigilante escuchando, se deposita un correo nuevo en
 * el buzón y se comprueba que el movimiento aparece sin que nadie sincronice a
 * mano.
 */
import { ImapFlow } from 'imapflow';
import { db, uid } from '../src/lib/db.js';
import { BANK_TEMPLATES } from '../src/services/bankTemplates.js';
import { seedHousehold } from '../src/routes/household.js';
import { cifrar } from '../src/lib/cripto.js';
import { vigilarCorreo, detenerVigilancia, cuentasEscuchando } from '../src/services/vigilanteCorreo.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const usuario = uid();
db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
  .run(usuario, `t${usuario}@ejemplo.cl`, 'x', 'Prueba');
const hogar = uid();
db.prepare('INSERT INTO households (id, name, currency, official_account) VALUES (?, ?, ?, ?)')
  .run(hogar, 'Hogar', 'CLP', 'Cuenta');
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
  .run(hogar, usuario, 'owner');
seedHousehold(hogar);
db.prepare('UPDATE email_rules SET enabled = 1 WHERE household_id = ? AND name = ?')
  .run(hogar, BANK_TEMPLATES.find((t) => t.key === 'bancochile_compra')!.name);
db.prepare(
  `INSERT INTO imap_accounts (id, household_id, user_id, email, secreto, host, port, carpeta)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(uid(), hogar, usuario, 'testuser', cifrar('testpass'), 'localhost', 9993, 'INBOX');

const cuantos = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE household_id = ?').get(hogar) as any).n;

async function depositar(asunto: string, cuerpo: string, id: string) {
  const cliente = new ImapFlow({
    host: 'localhost', port: 9993, secure: true,
    auth: { user: 'testuser', pass: 'testpass' }, logger: false,
  });
  await cliente.connect();
  const crudo = [
    `Message-Id: <${id}>`,
    'From: Banco de Chile <enviodigital@bancochile.cl>',
    'To: yo@gmail.com',
    `Subject: ${asunto}`,
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '', cuerpo,
  ].join('\r\n');
  await cliente.append('INBOX', Buffer.from(crudo));
  await cliente.logout();
}

async function main() {
  // Espera corta para que la prueba no dure un minuto.
  vigilarCorreo(60, 500);
  await esperar(2500);
  ok('la cuenta queda escuchando', cuentasEscuchando().includes('testuser'), cuentasEscuchando());

  // Los correos que ya estaban se importan en la primera pasada del vigilante,
  // así que primero se deja que se estabilice.
  await esperar(1500);
  const antes = cuantos();

  await depositar(
    'Compra con Tarjeta de Credito',
    'Te informamos que se ha realizado una compra por $7.490 en STARBUCKS PROVIDENCIA el 18/08/2026 con la tarjeta terminada en 4321.',
    'nuevo-1@bancochile.cl',
  );

  // Aviso del servidor + espera de agrupación + la sincronización misma.
  let esperado = false;
  for (let i = 0; i < 30 && !esperado; i += 1) {
    await esperar(500);
    esperado = cuantos() > antes;
  }

  ok('el correo nuevo entró solo, sin sincronizar a mano', esperado, { antes, ahora: cuantos() });

  const nuevo = db
    .prepare("SELECT * FROM transactions WHERE household_id = ? AND merchant LIKE '%STARBUCKS%'")
    .get(hogar) as any;
  ok('con el monto correcto', nuevo?.amount === 7490, nuevo?.amount);
  ok('y categorizado', Boolean(nuevo?.category_id));

  // Un segundo aviso del mismo correo no debe duplicarlo.
  const total = cuantos();
  await depositar(
    'Compra con Tarjeta de Credito',
    'Te informamos que se ha realizado una compra por $7.490 en STARBUCKS PROVIDENCIA el 18/08/2026 con la tarjeta terminada en 4321.',
    'nuevo-1@bancochile.cl',
  );
  await esperar(4000);
  ok('el mismo Message-ID no se duplica', cuantos() === total, { total, ahora: cuantos() });

  await detenerVigilancia();
  ok('al detener, no queda nada escuchando', cuentasEscuchando().length === 0);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('La prueba se cayó:', err.message);
  process.exit(1);
});

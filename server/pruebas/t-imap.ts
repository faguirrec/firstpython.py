/**
 * Prueba de punta a punta de la lectura por IMAP contra un servidor de mentira
 * con correos de banco chilenos.
 */
import { db, uid } from '../src/lib/db.js';
import { BANK_TEMPLATES } from '../src/services/bankTemplates.js';
import { seedHousehold } from '../src/routes/household.js';
import { cifrar } from '../src/lib/cripto.js';
import { sincronizarImap, buscarMensajesImap, textoDeMensajeImap } from '../src/services/imap.js';

let fallas = 0;
function ok(nombre: string, condicion: boolean, detalle?: unknown) {
  console.log(`${condicion ? '  ok' : 'FALLA'}  ${nombre}`);
  if (!condicion) { fallas += 1; if (detalle !== undefined) console.log('        ', detalle); }
}

// --- Hogar de prueba ---
const usuario = uid();
db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
  .run(usuario, `t${usuario}@ejemplo.cl`, 'x', 'Prueba');
const hogar = uid();
db.prepare('INSERT INTO households (id, name, currency, official_account) VALUES (?, ?, ?, ?)')
  .run(hogar, 'Hogar de prueba', 'CLP', 'Cuenta');
db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
  .run(hogar, usuario, 'owner');

// El mismo camino que sigue un hogar creado desde la app: categorías, reglas de
// comercio y plantillas de banco desactivadas.
seedHousehold(hogar);

const plantilla = BANK_TEMPLATES.find((t) => t.key === 'bancochile_compra')!;
// Se activa sólo la del banco que corresponde, como haría el usuario.
db.prepare('UPDATE email_rules SET enabled = 1 WHERE household_id = ? AND name = ?')
  .run(hogar, plantilla.name);

// --- La cuenta apunta al servidor de mentira ---
db.prepare(
  `INSERT INTO imap_accounts (id, household_id, user_id, email, secreto, host, port, carpeta)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(uid(), hogar, usuario, 'testuser', cifrar('testpass'), 'localhost', 9993, 'INBOX');

const movimientos = () =>
  db.prepare('SELECT * FROM transactions WHERE household_id = ? ORDER BY amount DESC').all(hogar) as any[];

async function main() {
  // --- 1. Simulación: no debe escribir nada ---
  const simulacion = await sincronizarImap(hogar, 100, true);
  ok('la simulación no reporta errores', simulacion.errors.length === 0, simulacion.errors);
  ok('la simulación encuentra los 2 avisos de compra', simulacion.imported === 2, simulacion.preview);
  ok('la simulación no guardó nada', movimientos().length === 0);

  const montos = simulacion.preview.map((p) => p.amount).sort((a, b) => b - a);
  ok('montos chilenos bien leídos ($45.990 y $12.500)',
     montos[0] === 45990 && montos[1] === 12500, montos);
  const comercios = simulacion.preview.map((p) => p.merchant);
  ok('saca el comercio', comercios.some((c) => /JUMBO/.test(c ?? '')) &&
     comercios.some((c) => /COPEC/.test(c ?? '')), comercios);
  ok('saca la fecha del texto, no la del correo',
     simulacion.preview.some((p) => p.occurredOn === '2026-08-16'), simulacion.preview.map(p => p.occurredOn));

  // --- 2. Lo que NO debe entrar ---
  const asuntos = simulacion.preview.map((p) => p.subject).join(' | ');
  ok('el correo de otro banco no entra', !/Notificacion de compra/.test(asuntos), asuntos);
  ok('el correo sin monto no entra', !/estado de cuenta/i.test(asuntos), asuntos);
  ok('el correo de hace 200 días queda fuera del rango', !/TIENDA VIEJA/.test(asuntos), asuntos);
  ok('el comprobante de transferencia NO entra como compra',
     !/Comprobante de transferencia/i.test(asuntos), asuntos);

  // --- 3. Sincronización de verdad ---
  const real = await sincronizarImap(hogar, 100, false);
  ok('importa 2 movimientos', real.imported === 2, real);
  const guardados = movimientos();
  ok('quedaron 2 en la base', guardados.length === 2);
  ok('quedan pendientes de revisión', guardados.every((m) => m.reviewed === 0));
  ok('quedan marcados como comunes y gasto',
     guardados.every((m) => m.scope === 'comun' && m.type === 'gasto'));
  ok('el origen queda registrado como imap', guardados.every((m) => m.source === 'imap'));
  ok('se guarda el Message-ID como identificador',
     guardados.every((m) => String(m.source_msg_id).startsWith('imap:')), guardados.map(m => m.source_msg_id));
  ok('categoriza sola: JUMBO → Supermercado', (() => {
    const jumbo = guardados.find((m) => /JUMBO/.test(m.merchant ?? ''));
    const cat = db.prepare('SELECT name FROM categories WHERE id = ?').get(jumbo?.category_id) as any;
    return cat?.name === 'Supermercado';
  })());
  ok('saca los últimos 4 dígitos de la tarjeta',
     guardados.every((m) => m.account_label === '4321'), guardados.map(m => m.account_label));

  // --- 4. Volver a sincronizar no duplica ---
  const segunda = await sincronizarImap(hogar, 100, false);
  ok('la segunda pasada no importa nada', segunda.imported === 0, segunda);
  ok('y los marca como repetidos', segunda.skipped >= 2, segunda.skipped);
  ok('siguen siendo 2 en la base', movimientos().length === 2);

  // --- 5. Explorador de correos ---
  const buscados = await buscarMensajesImap(hogar, 'from:(enviodigital@bancochile.cl) newer_than:60d', 10);
  ok('el explorador encuentra correos', buscados.messages.length >= 3, buscados);
  // El explorador busca por la consulta, no aplica las reglas: el comprobante
  // aparece igual, y eso está bien.
  ok('marca los ya importados', buscados.messages.filter((m) => m.alreadyImported).length === 2,
     buscados.messages.map((m) => [m.subject, m.alreadyImported]));

  // --- 6. Traer un correo puntual para el probador de reglas ---
  const texto = await textoDeMensajeImap(hogar, buscados.messages[0].id);
  ok('trae el cuerpo del correo', texto.body.includes('compra'), texto);
  ok('trae el remitente', texto.from.includes('bancochile.cl'), texto.from);

  // --- 7. Credenciales malas: error entendible, no un volcado técnico ---
  db.prepare('UPDATE imap_accounts SET secreto = ? WHERE household_id = ?').run(cifrar('malaclave'), hogar);
  const conError = await sincronizarImap(hogar, 100, true);
  ok('avisa que la contraseña fue rechazada',
     conError.errors.some((e) => /contraseña de aplicación/.test(e)), conError.errors);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} fallas.`);
  process.exit(fallas === 0 ? 0 : 1);
}

void main();

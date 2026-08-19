/**
 * Plantillas de reglas para correos de notificación de bancos chilenos.
 *
 * Son un punto de partida: los bancos ajustan el texto de sus avisos con cierta
 * frecuencia, así que la app permite editar `gmail_query` y las expresiones
 * regulares desde Ajustes → Reglas de correo sin volver a desplegar nada.
 * La pantalla "Probar regla" pega un correo real y muestra qué extrae.
 */

export type BankTemplate = {
  key: string;
  name: string;
  gmail_query: string;
  amount_regex: string;
  merchant_regex: string | null;
  date_regex: string | null;
  account_regex: string | null;
  /** Textos que el correo debe contener, todos. Separados por punto y coma. */
  must_contain?: string | null;
  must_not_contain?: string | null;
  type: 'gasto' | 'aporte';
  scope: 'comun' | 'personal';
  account_label: string | null;
};

export const BANK_TEMPLATES: BankTemplate[] = [
  {
    key: 'bancochile_compra',
    name: 'Banco de Chile — compra con tarjeta',
    gmail_query: 'from:(enviodigital@bancochile.cl OR notificaciones@bancochile.cl) newer_than:60d',
    amount_regex: '\\$\\s?([\\d.,]+)',
    merchant_regex: 'en\\s+([A-ZÁÉÍÓÚÑ0-9][^\\n.]{2,60}?)\\s+(?:el|por|con)\\b',
    date_regex: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
    account_regex: '(?:terminada|final)\\s*(?:en)?\\s*\\*{0,4}(\\d{4})',
    // Sin esto, el comprobante de una transferencia recibida —mismo remitente,
    // mismo formato de monto— entraría como si fuera una compra.
    must_contain: 'compra',
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
  {
    // Mercado Pago avisa lo que sale, no lo que entra. Lo que entra se captura
    // con la plantilla del banco que lo envía (más abajo).
    key: 'mercadopago_enviada',
    name: 'Mercado Pago — transferencia enviada',
    gmail_query: 'from:(mercadopago.com) subject:(transferencia) newer_than:60d',
    amount_regex: 'transferencia de\\s*\\$\\s?([\\d.,]+)',
    merchant_regex: 'Nombre y apellido:?\\s*([^\\n]{2,60})',
    // El correo no trae la fecha del movimiento; se usa la del correo.
    date_regex: null,
    account_regex: null,
    type: 'gasto',
    scope: 'comun',
    account_label: 'Mercado Pago',
  },
  {
    /**
     * Plata que entra a la cuenta del hogar.
     *
     * Cuando la cuenta del hogar es de una billetera que no avisa los abonos
     * —Mercado Pago es el caso—, el único correo que existe es el comprobante
     * que emite el banco de quien envía. Por eso esta regla mira el correo del
     * banco de origen y se queda sólo con los que llegaron a la cuenta del
     * hogar, mediante `must_contain`.
     *
     * Al activarla hay que elegir **de quién** es el aporte: la liquidación
     * suma lo que puso cada uno por su usuario, y un aporte sin dueño no le
     * cuenta a nadie. Si los dos transfieren desde el mismo banco, van dos
     * copias de esta regla, cada una con el nombre de una persona en
     * `must_contain`.
     */
    key: 'bancochile_transferencia_recibida',
    name: 'Banco de Chile — transferencia recibida (aporte)',
    gmail_query: 'from:(bancochile.cl) subject:(transferencia OR comprobante) newer_than:60d',
    amount_regex: 'Monto[\\s\\S]{0,40}?\\$\\s?([\\d.,]+)',
    merchant_regex: 'cliente\\s+([^\\n]{2,60}?)\\s+ha efectuado',
    date_regex: 'Fecha[\\s\\S]{0,40}?(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
    account_regex: 'Cuenta destino[\\s\\S]{0,60}?([\\d-]{8,})',
    // El banco de la cuenta del hogar, tal como aparece en el comprobante.
    // Sin este filtro, la regla también tomaría como aporte la plata que llegue
    // a tus cuentas personales, que el mismo correo informa igual.
    must_contain: 'Mercado Pago',
    type: 'aporte',
    scope: 'comun',
    account_label: 'Mercado Pago',
  },
  {
    /**
     * Plata que sale por transferencia.
     *
     * Un banco avisa la misma transferencia dos veces: una a quien la envía
     * ("Transferencia a terceros") y otra a quien la recibe ("transferencia
     * electrónica de fondos"). Cuando uno se transfiere a su propia cuenta del
     * hogar recibe los dos correos, y sin `must_not_contain` esa plata entraría
     * dos veces —como gasto y como aporte— y el mes no cuadraría.
     *
     * Por eso esta regla descarta lo que va a la cuenta del hogar: de eso ya se
     * encarga la regla de aportes.
     */
    key: 'bancochile_transferencia_enviada',
    name: 'Banco de Chile — transferencia enviada a terceros',
    gmail_query: 'from:(bancochile.cl) subject:(transferencia OR comprobante) newer_than:60d',
    amount_regex: 'Monto[\\s\\S]{0,40}?\\$\\s?([\\d.,]+)',
    merchant_regex: 'Nombre y Apellido\\s*([^\\n]{2,60})',
    date_regex: null,
    account_regex: 'Destino[\\s\\S]{0,200}?N[°º] de Cuenta\\s*([\\d-]{8,})',
    must_contain: 'Transferencia a terceros',
    must_not_contain: 'Mercado Pago',
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
  {
    key: 'santander_compra',
    name: 'Santander — compra con tarjeta',
    gmail_query: 'from:(santander.cl) subject:(compra OR transacción OR cargo) newer_than:60d',
    amount_regex: '(?:por|monto de)\\s*\\$\\s?([\\d.,]+)',
    merchant_regex: 'en\\s+([^\\n,]{2,60}?)\\s*(?:,|\\.|el\\b)',
    date_regex: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
    account_regex: '\\*{2,}(\\d{4})',
    // Sin esto, el comprobante de una transferencia recibida —mismo remitente,
    // mismo formato de monto— entraría como si fuera una compra.
    must_contain: 'compra',
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
  {
    key: 'bci_compra',
    name: 'BCI — compra con tarjeta',
    gmail_query: 'from:(bci.cl) subject:(compra OR cargo OR notificación) newer_than:60d',
    amount_regex: '\\$\\s?([\\d.,]+)',
    merchant_regex: 'comercio\\s*:?\\s*([^\\n]{2,60})',
    date_regex: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
    account_regex: '(?:tarjeta|cuenta)[^\\d]{0,20}(\\d{4})',
    // Sin esto, el comprobante de una transferencia recibida —mismo remitente,
    // mismo formato de monto— entraría como si fuera una compra.
    must_contain: 'compra',
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
  {
    key: 'bancoestado_compra',
    name: 'BancoEstado — compra o giro',
    gmail_query: 'from:(bancoestado.cl) newer_than:60d',
    amount_regex: '\\$\\s?([\\d.,]+)',
    merchant_regex: 'en\\s+([^\\n,]{2,60}?)\\s*(?:,|\\.|\\n)',
    date_regex: '(\\d{1,2}\\s+de\\s+[a-zá-ú]+(?:\\s+de\\s+\\d{4})?)',
    account_regex: '(?:tarjeta|cuenta)[^\\d]{0,20}(\\d{4})',
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
  {
    key: 'transferencia_recibida',
    name: 'Transferencia recibida en la cuenta del hogar (aporte)',
    gmail_query: 'subject:(transferencia OR abono) newer_than:60d',
    amount_regex: '\\$\\s?([\\d.,]+)',
    merchant_regex: '(?:de|desde)\\s+([A-ZÁÉÍÓÚÑ][^\\n,]{2,60})',
    date_regex: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
    account_regex: null,
    type: 'aporte',
    scope: 'comun',
    account_label: null,
  },
  {
    key: 'generico',
    name: 'Genérico — cualquier correo con un monto en pesos',
    gmail_query: 'subject:(compra OR cargo OR transacción) newer_than:30d',
    amount_regex: '\\$\\s?([\\d.,]+)',
    merchant_regex: 'en\\s+([^\\n,]{2,60})',
    date_regex: null,
    account_regex: null,
    type: 'gasto',
    scope: 'comun',
    account_label: null,
  },
];

/**
 * El emoji hace que una lista de categorías se lea de un vistazo, sin tener que
 * leer cada nombre. Es la misma idea de las apps de gastos conocidas, y sale
 * gratis: no son imágenes que haya que cargar.
 */
export const DEFAULT_CATEGORIES: { name: string; kind: string; color: string; emoji: string }[] = [
  { name: 'Arriendo / Dividendo', kind: 'necesidad', color: '#4f46e5', emoji: '🏠' },
  { name: 'Cuentas (luz, agua, gas)', kind: 'necesidad', color: '#0891b2', emoji: '💡' },
  { name: 'Internet y telefonía', kind: 'necesidad', color: '#0d9488', emoji: '📶' },
  { name: 'Supermercado', kind: 'necesidad', color: '#16a34a', emoji: '🛒' },
  { name: 'Transporte y bencina', kind: 'necesidad', color: '#ca8a04', emoji: '⛽' },
  { name: 'Salud y farmacia', kind: 'necesidad', color: '#dc2626', emoji: '💊' },
  { name: 'Restaurantes y delivery', kind: 'gusto', color: '#ea580c', emoji: '🍔' },
  { name: 'Entretención', kind: 'gusto', color: '#db2777', emoji: '🎬' },
  { name: 'Hogar y mantención', kind: 'necesidad', color: '#7c3aed', emoji: '🔧' },
  { name: 'Mascotas', kind: 'necesidad', color: '#65a30d', emoji: '🐾' },
  { name: 'Ahorro e inversión', kind: 'ahorro', color: '#0369a1', emoji: '🐷' },
  { name: 'Otros', kind: 'gusto', color: '#6b7280', emoji: '📦' },
];

/** Reglas de categorización automática por nombre de comercio. */
export const DEFAULT_CATEGORY_RULES: { pattern: string; category: string }[] = [
  { pattern: 'jumbo|lider|santa isabel|unimarc|tottus|acuenta|mayorista', category: 'Supermercado' },
  { pattern: 'copec|shell|petrobras|aramco|autopista|metro|uber|cabify|didi', category: 'Transporte y bencina' },
  { pattern: 'cruz verde|salcobrand|ahumada|clinica|integramedica|farmacia', category: 'Salud y farmacia' },
  { pattern: 'netflix|spotify|disney|hbo|max|prime video|cine|steam', category: 'Entretención' },
  { pattern: 'pedidosya|rappi|justo|doordash|mcdonald|starbucks|restaur', category: 'Restaurantes y delivery' },
  { pattern: 'enel|cge|aguas andinas|essbio|metrogas|lipigas|abastible', category: 'Cuentas (luz, agua, gas)' },
  { pattern: 'vtr|movistar|entel|wom|claro|gtd|mundo', category: 'Internet y telefonía' },
  { pattern: 'sodimac|easy|construmart|homecenter|ikea|paris|falabella|ripley', category: 'Hogar y mantención' },
  { pattern: 'veterinar|pet|mascota', category: 'Mascotas' },
];

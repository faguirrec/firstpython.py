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

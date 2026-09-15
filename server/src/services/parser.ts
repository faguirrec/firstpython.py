/**
 * Extracción de movimientos desde correos de notificación bancaria.
 *
 * El parseo es a base de reglas guardadas en la tabla `email_rules`, editables
 * desde la app: los bancos cambian el formato de sus correos cada cierto tiempo
 * y la idea es que ajustar una expresión regular no requiera tocar el código.
 */

export type ParsedEmail = {
  from: string;
  subject: string;
  body: string;
  internalDate: number;
};

export type EmailRule = {
  id: string;
  name: string;
  amount_regex: string;
  merchant_regex: string | null;
  date_regex: string | null;
  account_regex: string | null;
  /** De dónde sacar el mes contable, cuando el correo lo dice. Ver `parsePeriod`. */
  period_regex: string | null;
  card_filter: string | null;
  /**
   * Textos que el correo tiene que contener, todos. Separados por punto y coma
   * o por salto de línea.
   */
  must_contain: string | null;
  /** Textos que, si aparecen, descartan el correo. Mismo separador. */
  must_not_contain: string | null;
  type: string;
  scope: string;
  account_label: string | null;
  /** A quién se le atribuye el movimiento. Null = a nadie en particular. */
  user_id: string | null;
};

export type ParsedMovement = {
  amount: number;
  merchant: string | null;
  occurredOn: string;
  /**
   * Mes al que se le carga el movimiento (YYYY-MM), cuando el correo lo dice.
   * Null = el del día en que ocurrió.
   */
  period: string | null;
  account: string | null;
  installments: number | null;
};

/**
 * Normaliza montos escritos a la chilena/europea ("$ 45.990", "1.234,56")
 * y a la inglesa ("1,234.56").
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let normalized = cleaned;

  if (hasDot && hasComma) {
    // El separador decimal es el que aparece más a la derecha.
    normalized =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    const decimals = cleaned.length - cleaned.lastIndexOf(',') - 1;
    normalized = decimals === 3 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  } else if (hasDot) {
    const groups = cleaned.split('.');
    const looksLikeThousands = groups.length > 2 || groups[groups.length - 1].length === 3;
    normalized = looksLikeThousands ? cleaned.replace(/\./g, '') : cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const MONTHS: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12',
};

/** Acepta 14/03/2026, 14-03-26, 2026-03-14 y "14 de marzo de 2026". */
export function parseDate(raw: string, fallback: Date): string {
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = raw.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const textual = raw.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s*(?:de\s*)?(\d{4})?/i);
  if (textual) {
    const month = MONTHS[textual[2].slice(0, 3).toLowerCase()];
    if (month) {
      const year = textual[3] ?? String(fallback.getFullYear());
      return `${year}-${month}-${textual[1].padStart(2, '0')}`;
    }
  }
  return fallback.toISOString().slice(0, 10);
}

/**
 * Mes contable escrito en el correo, normalizado a YYYY-MM.
 *
 * Quien transfiere escribe un comentario a mano —"Mensualidad septiembre",
 * "Gastos de agosto"— y ese texto dice a qué mes pertenece la plata mucho mejor
 * que el día en que se apretó el botón: el sueldo del 25 de agosto paga el
 * septiembre. Acepta "2026-09", "09/2026" y el nombre del mes, con o sin año.
 *
 * Sin año hay que elegirlo, y el criterio es el mes más cercano a la fecha del
 * movimiento: en enero, "diciembre" es el diciembre que acaba de pasar, no el
 * que viene. Empatados, gana el futuro, porque una mensualidad se adelanta más
 * seguido de lo que se atrasa.
 */
export function parsePeriod(raw: string, referencia: string): string | null {
  /*
   * Un año tiene que parecer un año.
   *
   * Sin `(?<!\d)` y sin el rango, un RUT chileno calzaba: de "19831102-2" salía
   * "1102-02", que se guardaba tal cual como período y dejaba el movimiento en
   * un mes al que la app nunca llega. Los correos del banco traen el RUT justo
   * al lado del comentario, así que no es un caso rebuscado.
   */
  const anioPlausible = (anio: string) => Number(anio) >= 2000 && Number(anio) <= 2100;

  const iso = raw.match(/(?<!\d)(\d{4})[-/](\d{1,2})(?!\d)/);
  if (iso && anioPlausible(iso[1])) {
    const mes = Number(iso[2]);
    if (mes >= 1 && mes <= 12) return `${iso[1]}-${String(mes).padStart(2, '0')}`;
  }

  const my = raw.match(/(?<!\d)(\d{1,2})[-/](\d{4})(?!\d)/);
  if (my && anioPlausible(my[2])) {
    const mes = Number(my[1]);
    if (mes >= 1 && mes <= 12) return `${my[2]}-${String(mes).padStart(2, '0')}`;
  }

  // Se busca el nombre de mes entre las palabras, no en la primera: si la regla
  // captura "Mensualidad septiembre" de una, quedarse con "Mensualidad" sería
  // rendirse por un espacio de más.
  let mes: string | null = null;
  let anioEscrito: string | null = null;
  for (const palabra of raw.matchAll(/([a-záéíóúñ]{3,})\.?\s*(?:del?\s*)?(\d{4})?/gi)) {
    const encontrado = MONTHS[palabra[1].slice(0, 3).toLowerCase()];
    if (!encontrado) continue;
    mes = encontrado;
    anioEscrito = palabra[2] ?? null;
    break;
  }
  if (!mes) return null;
  if (anioEscrito) return `${anioEscrito}-${mes}`;

  const [anioRef, mesRef] = referencia.split('-').map(Number);
  if (!anioRef || !mesRef) return null;
  const desdeRef = anioRef * 12 + (mesRef - 1);
  let elegido: number | null = null;
  for (const anio of [anioRef - 1, anioRef, anioRef + 1]) {
    const candidato = anio * 12 + (Number(mes) - 1);
    if (elegido == null) {
      elegido = candidato;
      continue;
    }
    const distancia = Math.abs(candidato - desdeRef);
    const mejor = Math.abs(elegido - desdeRef);
    // Empate: se queda el que está más adelante en el tiempo.
    if (distancia < mejor || (distancia === mejor && candidato > elegido)) elegido = candidato;
  }
  if (elegido == null) return null;
  return `${Math.floor(elegido / 12)}-${String((elegido % 12) + 1).padStart(2, '0')}`;
}

function firstGroup(text: string, pattern: string | null): string | null {
  if (!pattern) return null;
  try {
    const match = new RegExp(pattern, 'i').exec(text);
    if (!match) return null;
    return (match[1] ?? match[0]).trim().replace(/\s+/g, ' ') || null;
  } catch {
    return null; // Regex inválida guardada por el usuario: se ignora en vez de romper la sync.
  }
}

/**
 * El resultado de pasar una regla por un correo, con el motivo cuando no calza.
 *
 * Que `applyRule` devolviera `null` a secas era cómodo para el código y pésimo
 * para quien configura: la pantalla decía "no calzó" y había cinco razones
 * posibles —el filtro de tarjeta, los dos filtros de texto, la regex del monto—
 * sin forma de distinguirlas. Con el motivo, arreglar una regla deja de ser
 * adivinar.
 */
export type Evaluacion =
  | { calza: true; movimiento: ParsedMovement }
  | { calza: false; motivo: string };

export function evaluarRegla(email: ParsedEmail, rule: EmailRule): Evaluacion {
  const haystack = `${email.subject}\n${email.body}`;

  if (rule.card_filter) {
    const digits = rule.card_filter
      .split(/[,\s]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    if (digits.length > 0 && !digits.some((d) => haystack.includes(d))) {
      return { calza: false, motivo: `El correo no menciona ninguna de las tarjetas ${digits.join(', ')}.` };
    }
  }

  const enMinuscula = haystack.toLowerCase();

  if (rule.must_contain) {
    const exigidos = rule.must_contain
      .split(/[;\n]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const faltantes = exigidos.filter((t) => !enMinuscula.includes(t));
    if (faltantes.length > 0) {
      return {
        calza: false,
        motivo: `El correo no dice ${faltantes.map((t) => `«${t}»`).join(' ni ')}, y la regla lo exige.`,
      };
    }
  }

  if (rule.must_not_contain) {
    const prohibidos = rule.must_not_contain
      .split(/[;\n]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const encontrado = prohibidos.find((t) => enMinuscula.includes(t));
    if (encontrado) {
      return { calza: false, motivo: `El correo dice «${encontrado}», y la regla descarta los que lo digan.` };
    }
  }

  const amountRaw = firstGroup(haystack, rule.amount_regex);
  if (!amountRaw) {
    return { calza: false, motivo: 'La expresión del monto no encontró nada en el texto del correo.' };
  }
  const amount = parseAmount(amountRaw);
  if (amount == null) {
    return { calza: false, motivo: `La expresión del monto capturó «${amountRaw}», que no es una cantidad.` };
  }

  const dateRaw = firstGroup(haystack, rule.date_regex);
  const fallback = new Date(email.internalDate || Date.now());
  const occurredOn = dateRaw ? parseDate(dateRaw, fallback) : fallback.toISOString().slice(0, 10);

  const merchantRaw = firstGroup(haystack, rule.merchant_regex);
  const merchant = merchantRaw ? merchantRaw.replace(/\s*[.,;]\s*$/, '').slice(0, 120) : null;

  const installments = /(\d{1,2})\s*cuotas/i.exec(haystack);

  const periodRaw = firstGroup(haystack, rule.period_regex);

  return {
    calza: true,
    movimiento: {
      amount,
      merchant,
      occurredOn,
      period: periodRaw ? parsePeriod(periodRaw, occurredOn.slice(0, 7)) : null,
      account: firstGroup(haystack, rule.account_regex) ?? rule.account_label,
      installments: installments ? Number(installments[1]) : null,
    },
  };
}

/** El movimiento a secas, para el código al que el motivo no le sirve de nada. */
export function applyRule(email: ParsedEmail, rule: EmailRule): ParsedMovement | null {
  const resultado = evaluarRegla(email, rule);
  return resultado.calza ? resultado.movimiento : null;
}

/**
 * Entidades HTML con nombre que aparecen en los correos de los bancos chilenos.
 * No pretende ser la lista completa: lo que no esté acá se deja como viene, que
 * es preferible a adivinar.
 */
const NOMBRADAS: Record<string, string> = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Uuml: 'Ü', Ntilde: 'Ñ',
  ordm: 'º', ordf: 'ª', deg: '°', middot: '·', bull: '·',
  iquest: '¿', iexcl: '¡', laquo: '«', raquo: '»', hellip: '…',
  mdash: '—', ndash: '–', quot: '"', apos: "'", euro: '€', pound: '£', yen: '¥', cent: '¢',
};

/** Convierte el HTML del correo en texto plano razonable para aplicar regex. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Las entidades con nombre importan más de lo que parece: los bancos
    // escriben "N&ordm; de Cuenta" y "Monto de la operaci&oacute;n", y si
    // sobreviven al texto plano, una regla escrita contra lo que uno ve en el
    // correo no calza nunca —y el síntoma es que no importa nada, sin error—.
    .replace(/&([a-z]+);/gi, (entera, nombre: string) => NOMBRADAS[nombre] ?? entera)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

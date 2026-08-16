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
  card_filter: string | null;
  type: string;
  scope: string;
  account_label: string | null;
};

export type ParsedMovement = {
  amount: number;
  merchant: string | null;
  occurredOn: string;
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

export function applyRule(email: ParsedEmail, rule: EmailRule): ParsedMovement | null {
  const haystack = `${email.subject}\n${email.body}`;

  if (rule.card_filter) {
    const digits = rule.card_filter
      .split(/[,\s]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    if (digits.length > 0 && !digits.some((d) => haystack.includes(d))) return null;
  }

  const amountRaw = firstGroup(haystack, rule.amount_regex);
  if (!amountRaw) return null;
  const amount = parseAmount(amountRaw);
  if (amount == null) return null;

  const dateRaw = firstGroup(haystack, rule.date_regex);
  const fallback = new Date(email.internalDate || Date.now());
  const occurredOn = dateRaw ? parseDate(dateRaw, fallback) : fallback.toISOString().slice(0, 10);

  const merchantRaw = firstGroup(haystack, rule.merchant_regex);
  const merchant = merchantRaw ? merchantRaw.replace(/\s*[.,;]\s*$/, '').slice(0, 120) : null;

  const installments = /(\d{1,2})\s*cuotas/i.exec(haystack);

  return {
    amount,
    merchant,
    occurredOn,
    account: firstGroup(haystack, rule.account_regex) ?? rule.account_label,
    installments: installments ? Number(installments[1]) : null,
  };
}

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
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

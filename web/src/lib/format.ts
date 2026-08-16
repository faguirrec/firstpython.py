/** Monedas sin decimales de uso corriente (el peso chileno es la que importa acá). */
const ZERO_DECIMAL = new Set(['CLP', 'JPY', 'KRW', 'PYG', 'ISK', 'COP']);

export function money(amount: number, currency = 'CLP'): string {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const formatted = new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(amount));
  // Intl deja el signo después del símbolo ("$-364"); acá se antepone.
  return amount < 0 ? `-${formatted}` : formatted;
}

/** Versión compacta para ejes de gráficos: $1,4M / $320k */
export function moneyShort(amount: number, currency = 'CLP'): string {
  const abs = Math.abs(amount);
  const symbol = currency === 'CLP' || currency === 'USD' ? '$' : '';
  if (abs >= 1_000_000) return `${symbol}${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace('.', ',')}M`;
  if (abs >= 1_000) return `${symbol}${Math.round(amount / 1000)}k`;
  return `${symbol}${Math.round(amount)}`;
}

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1).replace('.', ',')}%`;
}

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function monthLabel(month: string, short = false): string {
  const [year, m] = month.split('-');
  const name = MONTH_NAMES[Number(m) - 1] ?? month;
  if (short) return `${name.slice(0, 3)} ${year.slice(2)}`;
  return `${name} ${year}`;
}

export function dayLabel(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(year, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

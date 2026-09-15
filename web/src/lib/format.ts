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

/**
 * Porcentaje en número entero.
 *
 * Antes llevaba un decimal, y la barra del reparto redondeaba a entero: la
 * misma pantalla decía 60% arriba y 59,7% más abajo. El decimal no cambia
 * ninguna decisión y sí hacía dudar de la cifra.
 */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Reparte porcentajes enteros que suman exactamente 100.
 *
 * Redondear cada parte por su cuenta puede dar 101 —50,5 y 49,5 se van los dos
 * para arriba—, y una barra que suma 101% se nota.
 */
export function percentParts(fractions: number[]): number[] {
  const enteros = fractions.map((f) => Math.round(f * 100));
  const total = enteros.reduce((a, b) => a + b, 0);
  if (total !== 100 && enteros.length > 0) {
    // La diferencia se le carga a la parte más grande, donde menos se nota.
    const mayor = enteros.indexOf(Math.max(...enteros));
    enteros[mayor] += 100 - total;
  }
  return enteros;
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

/**
 * El día como encabezado de un grupo de movimientos: "Hoy", "Ayer" o
 * "Miércoles, 26 de agosto".
 *
 * Hoy y ayer llevan nombre propio porque es donde está casi todo lo que uno
 * viene a revisar, y leer la fecha para reconocerlos es trabajo de más.
 */
export function diaLargo(fecha: string): string {
  const hoy = today();
  if (fecha === hoy) return 'Hoy';

  const ayer = new Date(`${hoy}T12:00:00`);
  ayer.setDate(ayer.getDate() - 1);
  if (fecha === ayer.toISOString().slice(0, 10)) return 'Ayer';

  // Mediodía a propósito: con T00:00 el huso horario puede correr el día.
  const largo = new Date(`${fecha}T12:00:00`).toLocaleDateString('es-CL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  // Sólo la primera letra. En CSS, `capitalize` habría dejado "Miércoles 26 De
  // Agosto", que en español está mal.
  return largo.charAt(0).toUpperCase() + largo.slice(1);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * ¿Es un mes que todavía no empieza?
 *
 * Importa para el tono de las pantallas: en un mes que ya pasó, faltar plata es
 * una deuda; en uno que no ha empezado, es un plan.
 */
export function esMesFuturo(month: string): boolean {
  return month > currentMonth();
}

/**
 * ¿Es un mes que ya terminó?
 *
 * Decide cuándo la app se pone en rojo. Un mes a medio andar no es una
 * emergencia: si el día 10 ya está todo rojo porque falta poner lo del 25, el
 * rojo deja de significar algo, y cuando pase algo de verdad nadie lo va a
 * mirar. Mientras el mes corre, lo que falta es una tarea; una vez cerrado,
 * recién ahí es una deuda.
 */
export function esMesCerrado(month: string): boolean {
  return month < currentMonth();
}

/**
 * Hasta dónde se puede mirar hacia adelante.
 *
 * Los sueldos no llegan todos el mismo día —a uno le pagan el 23 y al otro el
 * último hábil—, así que a fin de mes ya hay plata del mes siguiente que
 * ordenar. Un año alcanza de sobra para eso y evita que el selector se vaya a
 * meses vacíos sin sentido.
 */
export const MESES_HACIA_ADELANTE = 12;

export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(year, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

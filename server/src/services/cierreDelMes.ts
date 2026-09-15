import { db } from '../lib/db.js';
import { HOGAR } from '../lib/visibilidad.js';
import { compareMonths, shiftMonth } from './planning.js';
import { computeSettlement, round2 } from './split.js';
import { estadoDelMes } from './gastosFijos.js';

/**
 * El mes, contado para leerlo de a dos.
 *
 * Cerrar el mes era un trámite: un botón que congelaba el resultado. Pero el
 * momento en que dos personas se sientan a mirar la plata junta es el único de
 * todo el ciclo que la app no estaba aprovechando, y es exactamente donde las
 * apps de pareja que funcionan ponen su mejor carta —Zeta lo llama "money
 * date" y le pone hasta guía de conversación—.
 *
 * Esto arma lo que hay que leer: qué costó el mes, qué se movió respecto de lo
 * habitual, cuál fue el gasto que llamó la atención, cómo quedó cada uno y qué
 * se viene. Nada que la app no supiera; lo que faltaba era juntarlo en una sola
 * lectura en vez de repartirlo en cuatro pantallas de gráficos.
 *
 * Todo lo que sale de acá es descriptivo. Ninguna de estas frases juzga a nadie
 * ni recomienda apretarse el cinturón: la conversación es de ellos, la app pone
 * los datos sobre la mesa y se calla.
 */

export type MovimientoDestacado = {
  id: string;
  amount: number;
  merchant: string | null;
  description: string | null;
  occurredOn: string;
  categoryName: string | null;
  categoryEmoji: string | null;
};

export type CierreDelMes = {
  month: string;
  previousMonth: string;
  nextMonth: string;
  /** Total de gastos comunes del mes. */
  total: number;
  /** Promedio de los meses anteriores con movimiento, para comparar. */
  promedio: number;
  /** Diferencia contra ese promedio; negativa si se gastó menos. */
  contraPromedio: number;
  /** Cuántos meses de historia respaldan el promedio. 0 = no hay con qué comparar. */
  mesesDeHistoria: number;
  /** La categoría que más subió y la que más bajó contra el mes anterior.
      Llevan el id para poder entrar a sus movimientos desde la lectura. */
  subio: { categoryId: string | null; category: string; emoji: string; delta: number } | null;
  bajo: { categoryId: string | null; category: string; emoji: string; delta: number } | null;
  /**
   * El gasto único más grande que no es un gasto fijo.
   *
   * Los fijos ya se saben —el arriendo siempre es el más caro— y nombrarlos no
   * aporta. Lo que vale la pena mirar juntos es lo que pasó una sola vez.
   */
  elGrande: MovimientoDestacado | null;
  /** Cómo quedó cada uno: lo que puso contra lo que le tocaba. */
  personas: { userId: string; name: string; fairShare: number; contributed: number; deviation: number }[];
  /** Cuántos movimientos entraron solos por correo, de cuántos en total. */
  automaticos: { porCorreo: number; total: number };
  /** Lo que ya se sabe que viene el mes siguiente. */
  loQueViene: { fijos: number; total: number };
};

/** El promedio de los meses anteriores que tuvieron movimiento. */
function promedioAnterior(householdId: string, month: string): { promedio: number; meses: number } {
  const filas = db
    .prepare(
      `SELECT t.period AS mes, SUM(t.amount) AS total
         FROM transactions t
        WHERE t.household_id = ? AND t.type = 'gasto' AND t.scope = 'comun'
          AND t.period < ?
        GROUP BY t.period
        ORDER BY t.period DESC
        LIMIT 6`,
    )
    .all(householdId, month) as { mes: string; total: number }[];
  if (filas.length === 0) return { promedio: 0, meses: 0 };
  return {
    promedio: round2(filas.reduce((a, b) => a + b.total, 0) / filas.length),
    meses: filas.length,
  };
}

export function cierreDelMes(householdId: string, month: string, currency: string): CierreDelMes {
  const liquidacion = computeSettlement(householdId, month, currency);
  const { promedio, meses } = promedioAnterior(householdId, month);
  const comparacion = compareMonths(householdId, month, 3, HOGAR);

  /*
   * El que más subió y el que más bajó.
   *
   * Dos filtros, los dos para que esto se pueda leer en voz alta sin aburrir:
   *
   *  - El movimiento tiene que ser real. Una diferencia de mil pesos sobre un
   *    millón no es una noticia, y nombrarla convierte el resumen en ruido.
   *  - "Sin categoría" queda afuera aunque sea el que más se movió. No es un
   *    cambio de hábito, es información que falta: decir "sin categoría subió
   *    $180.000" no le dice a nadie en qué gastó. Eso tiene su propia tarjeta,
   *    con el botón para arreglarlo.
   */
  const relevante = Math.max(liquidacion.totalSharedExpenses * 0.02, 5000);
  const conNombre = (c: { categoryId: string | null }) => c.categoryId !== null;
  const subio = comparacion.biggestIncreases.find((c) => conNombre(c) && c.deltaPrevious >= relevante) ?? null;
  const bajo = comparacion.biggestDecreases.find((c) => conNombre(c) && -c.deltaPrevious >= relevante) ?? null;

  /*
   * El gasto único más grande, sin los fijos.
   *
   * Se excluyen los movimientos con los que se pagó un gasto fijo del mes: son
   * los más caros casi siempre y nombrarlos no dice nada que no se supiera al
   * empezar el mes.
   */
  const pagosDeFijos = estadoDelMes(householdId, month)
    .items.map((i) => i.paidWith?.id)
    .filter((id): id is string => Boolean(id));
  const marcas = pagosDeFijos.map((_, i) => `@f${i}`);
  const params: Record<string, unknown> = { hogar: householdId, mes: month };
  pagosDeFijos.forEach((id, i) => { params[`f${i}`] = id; });
  const elGrande = db
    .prepare(
      `SELECT t.id, t.amount, t.merchant, t.description, t.occurred_on AS occurredOn,
              c.name AS categoryName, c.emoji AS categoryEmoji
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = @hogar AND t.period = @mes
          AND t.type = 'gasto' AND t.scope = 'comun'
          ${marcas.length ? `AND t.id NOT IN (${marcas.join(', ')})` : ''}
        ORDER BY t.amount DESC
        LIMIT 1`,
    )
    .get(params) as MovimientoDestacado | undefined;

  const cuenta = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN t.source IN ('gmail', 'imap') THEN 1 ELSE 0 END) AS porCorreo
         FROM transactions t
        WHERE t.household_id = ? AND t.period = ? AND t.scope = 'comun'`,
    )
    .get(householdId, month) as { total: number; porCorreo: number | null };

  const siguiente = shiftMonth(month, 1);
  const fijosQueVienen = estadoDelMes(householdId, siguiente);

  return {
    month,
    previousMonth: comparacion.previousMonth,
    nextMonth: siguiente,
    total: liquidacion.totalSharedExpenses,
    promedio,
    contraPromedio: meses > 0 ? round2(liquidacion.totalSharedExpenses - promedio) : 0,
    mesesDeHistoria: meses,
    subio: subio
      ? { categoryId: subio.categoryId, category: subio.category, emoji: subio.emoji, delta: subio.deltaPrevious }
      : null,
    bajo: bajo
      ? { categoryId: bajo.categoryId, category: bajo.category, emoji: bajo.emoji, delta: bajo.deltaPrevious }
      : null,
    elGrande: elGrande ?? null,
    personas: liquidacion.members.map((m) => ({
      userId: m.userId,
      name: m.name,
      fairShare: m.fairShare,
      contributed: m.contributed,
      deviation: m.deviation,
    })),
    automaticos: { porCorreo: cuenta.porCorreo ?? 0, total: cuenta.total },
    loQueViene: {
      fijos: fijosQueVienen.items.length,
      total: round2(fijosQueVienen.items.reduce((a, b) => a + b.expected, 0)),
    },
  };
}

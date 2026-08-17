import { db, uid } from '../lib/db.js';
import { env } from '../lib/env.js';
import { computeReserve, computeSettlement } from './split.js';
import { compareMonths, computeBudgetStatus } from './planning.js';
import { boton, enviarCorreo, envoltorio } from './mailer.js';

/**
 * Reporte mensual por correo: cómo cerró el mes de la casa.
 *
 * Se manda una sola vez por hogar y por mes; el registro en `email_log` es lo
 * que lo garantiza, porque la tarea puede dispararse varias veces (por el
 * temporizador interno y por un cron externo).
 */

function nombreMes(mes: string): string {
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const [anio, m] = mes.split('-');
  return `${meses[Number(m) - 1]} de ${anio}`;
}

function plata(monto: number, moneda: string): string {
  const sinDecimales = ['CLP', 'JPY', 'KRW', 'PYG', 'ISK', 'COP'].includes(moneda);
  const texto = new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: moneda,
    minimumFractionDigits: sinDecimales ? 0 : 2,
    maximumFractionDigits: sinDecimales ? 0 : 2,
  }).format(Math.abs(monto));
  return monto < 0 ? `-${texto}` : texto;
}

/** Mes anterior al actual, que es el que se reporta. */
export function mesPasado(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type Miembro = { id: string; name: string; email: string };

export function construirReporte(householdId: string, mes: string): { asunto: string; html: string; texto: string } | null {
  const hogar = db
    .prepare('SELECT name, currency, official_account AS cuenta FROM households WHERE id = ?')
    .get(householdId) as { name: string; currency: string; cuenta: string } | undefined;
  if (!hogar) return null;

  const liquidacion = computeSettlement(householdId, mes, hogar.currency);
  // Un mes sin gastos no merece un correo.
  if (liquidacion.totalSharedExpenses === 0) return null;

  const presupuesto = computeBudgetStatus(householdId, mes);
  const comparacion = compareMonths(householdId, mes);
  const reserva = computeReserve(householdId);
  const moneda = hogar.currency;

  const filas = liquidacion.members
    .map((m) => {
      const color = m.deviation < -0.5 ? '#d03b3b' : '#006300';
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9;">${m.name}
          <div style="color:#898781;font-size:12px;">${(m.incomeShare * 100).toFixed(1)}% del ingreso</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9;text-align:right;">${plata(m.fairShare, moneda)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9;text-align:right;">${plata(m.contributed, moneda)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9;text-align:right;color:${color};">
          ${m.deviation >= 0 ? '+' : ''}${plata(m.deviation, moneda)}
        </td>
      </tr>`;
    })
    .join('');

  const cierre = liquidacion.transfer
    ? (() => {
        const de = liquidacion.members.find((m) => m.userId === liquidacion.transfer!.fromUserId);
        const a = liquidacion.members.find((m) => m.userId === liquidacion.transfer!.toUserId);
        return `<p style="margin:16px 0;padding:14px;background:#f0f6fd;border-radius:10px;font-size:16px;">
          <strong>${de?.name} le transfiere ${plata(liquidacion.transfer!.amount, moneda)} a ${a?.name}</strong>
          para quedar a mano.
        </p>`;
      })()
    : `<p style="margin:16px 0;padding:14px;background:#f0f6fd;border-radius:10px;">${liquidacion.note}</p>`;

  const excedidas = presupuesto.overBudget.length
    ? `<h2 style="font-size:15px;margin:22px 0 8px;">Presupuesto excedido</h2>
       <ul style="margin:0;padding-left:18px;color:#52514e;">
         ${presupuesto.overBudget
           .map(
             (c) =>
               `<li>${c.category}: ${plata(c.spent, moneda)} de ${plata(c.budget, moneda)}
                 (${plata(-c.remaining, moneda)} de más)</li>`,
           )
           .join('')}
       </ul>`
    : '';

  const subidas = comparacion.biggestIncreases.slice(0, 3);
  const cambios = subidas.length
    ? `<h2 style="font-size:15px;margin:22px 0 8px;">Dónde subió el gasto</h2>
       <ul style="margin:0;padding-left:18px;color:#52514e;">
         ${subidas
           .map(
             (c) =>
               `<li>${c.category}: ${plata(c.previous, moneda)} → ${plata(c.current, moneda)}
                 (+${plata(c.deltaPrevious, moneda)})</li>`,
           )
           .join('')}
       </ul>`
    : '';

  const contenido = `
    <p style="color:#52514e;margin:0 0 16px;">
      Así cerró <strong>${hogar.name}</strong> en ${nombreMes(mes)}.
    </p>

    <div style="padding:14px;background:#f9f9f7;border-radius:10px;margin-bottom:18px;">
      <div style="color:#52514e;font-size:13px;">Gastos comunes del mes</div>
      <div style="font-size:26px;font-weight:650;">${plata(liquidacion.totalSharedExpenses, moneda)}</div>
      ${
        comparacion.totalPrevious > 0
          ? `<div style="font-size:13px;color:${comparacion.totalCurrent > comparacion.totalPrevious ? '#d03b3b' : '#006300'};">
               ${comparacion.totalCurrent > comparacion.totalPrevious ? '▲' : '▼'}
               ${plata(Math.abs(comparacion.totalCurrent - comparacion.totalPrevious), moneda)}
               respecto del mes anterior
             </div>`
          : ''
      }
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      <tr style="color:#52514e;font-size:12px;text-align:left;">
        <th style="padding-bottom:6px;">Persona</th>
        <th style="padding-bottom:6px;text-align:right;">Le tocaba</th>
        <th style="padding-bottom:6px;text-align:right;">Puso</th>
        <th style="padding-bottom:6px;text-align:right;">Saldo</th>
      </tr>
      ${filas}
    </table>

    ${cierre}
    ${excedidas}
    ${cambios}

    <h2 style="font-size:15px;margin:22px 0 8px;">Fondo de reserva</h2>
    <p style="margin:0;color:#52514e;">
      ${plata(reserva.balance, moneda)} acumulados en ${hogar.cuenta}${
        reserva.monthsCovered > 0 ? `, equivalente a ${reserva.monthsCovered} meses de gastos` : ''
      }.
    </p>

    ${boton('Ver el detalle en la app', env.webOrigin)}
  `;

  const texto = [
    `${hogar.name} — ${nombreMes(mes)}`,
    '',
    `Gastos comunes: ${plata(liquidacion.totalSharedExpenses, moneda)}`,
    ...liquidacion.members.map(
      (m) =>
        `${m.name}: le tocaba ${plata(m.fairShare, moneda)}, puso ${plata(m.contributed, moneda)} ` +
        `(saldo ${m.deviation >= 0 ? '+' : ''}${plata(m.deviation, moneda)})`,
    ),
    '',
    liquidacion.note,
    '',
    `Fondo de reserva: ${plata(reserva.balance, moneda)}`,
    '',
    env.webOrigin,
  ].join('\n');

  return {
    asunto: `${hogar.name}: cómo cerró ${nombreMes(mes)}`,
    html: envoltorio(`Resumen de ${nombreMes(mes)}`, contenido),
    texto,
  };
}

export type ResultadoTarea = {
  mes: string;
  hogaresRevisados: number;
  enviados: number;
  omitidos: number;
  errores: string[];
};

/**
 * Envía el reporte a los hogares que lo tengan activado y que aún no lo hayan
 * recibido para ese mes.
 */
export async function enviarReportesMensuales(mes = mesPasado()): Promise<ResultadoTarea> {
  const resultado: ResultadoTarea = { mes, hogaresRevisados: 0, enviados: 0, omitidos: 0, errores: [] };

  const hogares = db
    .prepare('SELECT id, name FROM households WHERE send_monthly_report = 1')
    .all() as { id: string; name: string }[];

  const yaEnviado = db.prepare(
    "SELECT 1 FROM email_log WHERE household_id = ? AND kind = 'reporte-mensual' AND reference = ? AND recipient = ?",
  );
  const registrar = db.prepare(
    'INSERT INTO email_log (id, household_id, kind, reference, recipient) VALUES (?, ?, ?, ?, ?)',
  );

  for (const hogar of hogares) {
    resultado.hogaresRevisados += 1;

    const miembros = db
      .prepare(
        `SELECT u.id, u.name, u.email FROM household_members m
           JOIN users u ON u.id = m.user_id WHERE m.household_id = ?`,
      )
      .all(hogar.id) as Miembro[];

    const reporte = construirReporte(hogar.id, mes);
    if (!reporte) {
      resultado.omitidos += miembros.length;
      continue;
    }

    for (const miembro of miembros) {
      if (yaEnviado.get(hogar.id, mes, miembro.email)) {
        resultado.omitidos += 1;
        continue;
      }

      const envio = await enviarCorreo({
        para: miembro.email,
        asunto: reporte.asunto,
        html: reporte.html,
        texto: reporte.texto,
      });

      if (envio.ok) {
        // Se registra sólo tras un envío exitoso, para que un fallo se reintente.
        registrar.run(uid(), hogar.id, 'reporte-mensual', mes, miembro.email);
        resultado.enviados += 1;
      } else {
        resultado.errores.push(`${miembro.email}: ${envio.error}`);
      }
    }
  }

  return resultado;
}

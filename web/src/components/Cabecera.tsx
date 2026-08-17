import { Logo } from './Icons';
import { currentMonth, monthLabel, shiftMonth } from '../lib/format';

/**
 * Cabecera de la app: marca, nombre del hogar y selector de mes.
 *
 * Va fija arriba y con el fondo difuminado, así la identidad está presente en
 * todas las pantallas —antes el logo sólo aparecía al entrar— y el mes que se
 * está mirando nunca se pierde al bajar por una lista larga.
 */
export default function Cabecera({
  hogar,
  month,
  onMonthChange,
  accion,
}: {
  hogar: string;
  month?: string;
  onMonthChange?: (mes: string) => void;
  accion?: React.ReactNode;
}) {
  const esFuturo = month ? month >= currentMonth() : true;

  return (
    <header className="cabecera">
      <div className="cabecera-fila">
        <span className="cabecera-marca">
          <Logo size={32} />
          <span className="cabecera-nombre">
            <strong>{hogar}</strong>
            <span>Cuentas del Hogar</span>
          </span>
        </span>
        {accion}
      </div>

      {month && onMonthChange && (
        <div className="selector-mes" role="group" aria-label="Mes que se está viendo">
          <button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Mes anterior">
            ‹
          </button>
          <span className="selector-mes-actual">{monthLabel(month)}</span>
          <button onClick={() => onMonthChange(shiftMonth(month, 1))} disabled={esFuturo} aria-label="Mes siguiente">
            ›
          </button>
        </div>
      )}
    </header>
  );
}

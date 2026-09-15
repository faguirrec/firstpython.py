import { Logo } from './Icons';
import { MESES_HACIA_ADELANTE, currentMonth, esMesFuturo, monthLabel, shiftMonth } from '../lib/format';
import { MODO_PERSONAL_VISIBLE, cambiarModo, useModo } from '../lib/modo';
import { useSession } from '../lib/session';

/**
 * Cabecera de la app: marca, nombre del hogar y selector de mes.
 *
 * Va fija arriba y con el fondo difuminado, así la identidad está presente en
 * todas las pantallas —antes el logo sólo aparecía al entrar— y el mes que se
 * está mirando nunca se pierde al bajar por una lista larga.
 *
 * Acá vive también el cambio entre las cuentas del hogar y las propias. Va en
 * la cabecera y no en ajustes porque no es una configuración: es dónde uno está
 * parado, y cambia varias veces al día. Hoy no se dibuja: el modo personal está
 * escondido detrás de `MODO_PERSONAL_VISIBLE` (ver `lib/modo.ts`), así que la
 * cabecera muestra siempre el hogar.
 */
export default function Cabecera({
  hogar,
  month,
  onMonthChange,
  accion,
  /** Las pantallas que no distinguen bolsillo —Ajustes— esconden el cambio. */
  conModo = true,
}: {
  hogar: string;
  month?: string;
  onMonthChange?: (mes: string) => void;
  accion?: React.ReactNode;
  conModo?: boolean;
}) {
  // Se puede mirar hacia adelante, no indefinidamente: pasado el horizonte no
  // hay nada que planificar y el selector se vuelve un paseo por meses vacíos.
  const tope = shiftMonth(currentMonth(), MESES_HACIA_ADELANTE);
  const alTope = month ? month >= tope : true;
  const futuro = month ? esMesFuturo(month) : false;
  const modo = useModo();
  const { user } = useSession();
  // En modo personal la cabecera dice de quién son las cuentas que se ven: si
  // siguiera diciendo el nombre del hogar, los dos lados se verían iguales. La
  // marca se queda abajo en los dos casos —es la misma app—; de decir en cuál
  // de los dos lados estás se encargan los botones de acá abajo.
  const enPersonal = conModo && modo === 'personal';

  return (
    <header className="cabecera">
      <div className="cabecera-fila">
        <span className="cabecera-marca">
          <Logo size={32} />
          <span className="cabecera-nombre">
            <strong>{enPersonal ? (user?.name ?? 'Mis cuentas') : hogar}</strong>
            <span>MyHaus</span>
          </span>
        </span>
        {accion}
      </div>

      {/* El selector se dibuja sólo si hay entre qué elegir: con el modo
          personal escondido, un par de botones donde uno está siempre apagado
          no sería un control, sería un adorno que promete algo que no pasa. */}
      {MODO_PERSONAL_VISIBLE && conModo && (
        <div className="cambio-modo" role="group" aria-label="Qué cuentas se están viendo">
          <button
            className={modo === 'hogar' ? 'activo' : ''}
            aria-pressed={modo === 'hogar'}
            onClick={() => cambiarModo('hogar')}
          >
            Hogar
          </button>
          <button
            className={modo === 'personal' ? 'activo' : ''}
            aria-pressed={modo === 'personal'}
            onClick={() => cambiarModo('personal')}
          >
            Personal
          </button>
        </div>
      )}

      {month && onMonthChange && (
        <div className="selector-mes" role="group" aria-label="Mes que se está viendo">
          <button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Mes anterior">
            ‹
          </button>
          <span className="selector-mes-actual">
            {monthLabel(month)}
            {futuro && <span className="pill" style={{ marginLeft: 8 }}>por venir</span>}
          </span>
          <button onClick={() => onMonthChange(shiftMonth(month, 1))} disabled={alTope} aria-label="Mes siguiente">
            ›
          </button>
        </div>
      )}
    </header>
  );
}

import type { ReactNode } from 'react';
import { MESES_HACIA_ADELANTE, currentMonth, esMesFuturo, monthLabel, shiftMonth } from '../lib/format';
import { Logo } from './Icons';

/**
 * El bloque de marca: la cifra del mes vive adentro del color.
 *
 * Es lo único que tienen en común las cuatro apps de referencia que se miraron
 * —Copilot, Monarch, Empower y la chilena Kuanto—, y no es la paleta: es que el
 * color de marca ocupa el borde superior de la pantalla y el número principal
 * vive dentro de él, en blanco, con su tendencia y sus botones al lado.
 *
 * Antes acá había dos piezas apiladas que sumaban casi 500px: una cabecera de
 * 191px que no decía ninguna cifra —logo, nombre y selector de mes— y debajo
 * una tarjeta blanca con el número. Juntarlas no es decoración: recupera media
 * pantalla y, sobre todo, hace que lo primero que se ve sea la respuesta.
 *
 * El mes va adentro y centrado porque es contexto de la cifra, no una
 * preferencia de la app: "$3.181 de septiembre" es una sola idea.
 */
export default function BloqueDelMes({
  hogar,
  month,
  onMonthChange,
  etiqueta,
  cifra,
  apoyo,
  tendencia,
  detalle,
  acciones,
  encabezado,
}: {
  hogar: string;
  month: string;
  onMonthChange: (mes: string) => void;
  /** Qué es el número, en mayúsculas chicas sobre él. */
  etiqueta: string;
  /** El número ya formateado, o un texto cuando todavía no hay número. */
  cifra: ReactNode;
  apoyo?: ReactNode;
  /**
   * Los últimos meses de gasto común, para la línea de fondo.
   *
   * Es deliberadamente una silueta sin ejes ni etiquetas: dice "viene subiendo"
   * o "viene parejo" de un vistazo y nada más. Quien quiera el detalle tiene
   * Análisis, que es donde ese gráfico está bien hecho.
   */
  tendencia?: number[];
  /**
   * La consecuencia de la cifra, en una línea bajo ella.
   *
   * Va entre la cifra y la silueta a propósito: es lectura, no acción, y
   * ponerla debajo de los botones la convertiría en un pie de página que nadie
   * mira. Con el saldo arriba, esto es lo que cada uno puso de más o de menos.
   */
  detalle?: ReactNode;
  acciones?: ReactNode;
  /** Lo que va arriba a la derecha, al lado del nombre del hogar. */
  encabezado?: ReactNode;
}) {
  const alTope = shiftMonth(month, 1) > shiftMonth(currentMonth(), MESES_HACIA_ADELANTE);
  const futuro = esMesFuturo(month);

  return (
    <header className="bloque-mes">
      <div className="bloque-top">
        {/* El logotipo pinta su baldosa con `--marca`. Acá esa variable se
            redefine a un blanco translúcido —ver `.bloque-logo` en la hoja— y
            el mismo componente funciona sobre el verde sin una versión aparte. */}
        <span className="bloque-logo"><Logo size={34} /></span>
        <strong>{hogar}</strong>
        {encabezado}
      </div>

      <div className="bloque-selector" role="group" aria-label="Mes que se está viendo">
        <button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Mes anterior">‹</button>
        <span className="bloque-mes-actual">
          {monthLabel(month)}
          {futuro && <span className="bloque-porvenir">por venir</span>}
        </span>
        <button onClick={() => onMonthChange(shiftMonth(month, 1))} disabled={alTope} aria-label="Mes siguiente">›</button>
      </div>

      <p className="bloque-etiqueta">{etiqueta}</p>
      <div className="bloque-cifra">{cifra}</div>
      {apoyo && <p className="bloque-apoyo">{apoyo}</p>}

      {detalle}

      {/* Con menos de tres meses no hay silueta que dibujar: dos puntos son una
          recta, y una recta acá se lee como "viene parejo" sin serlo. */}
      {tendencia && tendencia.length >= 3 && <Silueta valores={tendencia} />}

      {acciones && <div className="bloque-acciones">{acciones}</div>}
    </header>
  );
}

/**
 * La silueta de los últimos meses.
 *
 * Se dibuja a mano y no con la librería de gráficos porque acá no hay ejes que
 * respetar ni valores que leer: es una textura con forma de dato. El último
 * punto lleva un círculo para que se vea dónde estamos parados.
 */
function Silueta({ valores }: { valores: number[] }) {
  const ancho = 320;
  const alto = 44;
  /*
   * La escala va del menor al mayor de la serie, no desde cero.
   *
   * Anclada en cero, dos meses de $673.790 y $715.290 salían los dos pegados al
   * borde de arriba: una línea plana que decía "no pasa nada" cuando sí pasó.
   * Acá no hay eje ni etiquetas, así que la única información que la silueta
   * puede dar es la forma, y la forma tiene que ser la de verdad.
   */
  const max = Math.max(...valores);
  const min = Math.min(...valores);
  const rango = max - min || 1;
  // Se deja aire arriba y abajo para que ni el pico ni el valle toquen el borde.
  const y = (v: number) => alto - 6 - ((v - min) / rango) * (alto - 14);
  /*
   * El último punto no llega al borde: lleva un círculo de radio 3,5 y pegado
   * al canto quedaba cortado por la mitad. Se reserva ese margen a la derecha.
   */
  const margen = 5;
  const x = (i: number) => (i / (valores.length - 1)) * (ancho - margen);
  const puntos = valores.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
  const linea = `M ${puntos.join(' L ')}`;

  return (
    <svg
      className="bloque-silueta"
      viewBox={`0 0 ${ancho} ${alto}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="silueta-relleno" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${linea} L ${ancho - margen} ${alto} L 0 ${alto} Z`} fill="url(#silueta-relleno)" />
      <path d={linea} fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={ancho - margen} cy={y(valores[valores.length - 1])} r="3.5" fill="#fff" />
    </svg>
  );
}

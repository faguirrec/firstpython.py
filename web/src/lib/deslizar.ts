import { useEffect, useRef } from 'react';
import { MESES_HACIA_ADELANTE, currentMonth, shiftMonth } from './format';
import { cambiarMes } from './mes';

/**
 * Deslizar de lado para cambiar de mes.
 *
 * El selector ‹ › vive en el tercio superior de la pantalla, que es justo la
 * zona a la que el pulgar no llega sin cambiar el agarre del teléfono —y el mes
 * es de los controles que más se tocan—. Las flechas se quedan donde están para
 * quien las busque; esto les agrega un camino que no obliga a soltar el
 * teléfono.
 *
 * Reglas del gesto, todas pensadas para no disparar por accidente:
 *
 *  - Horizontal de verdad: el movimiento lateral tiene que más que doblar al
 *    vertical, o cada scroll con el dedo torcido cambiaría de mes.
 *  - Con recorrido: 64px. Un umbral corto se activa apoyando el dedo.
 *  - Rápido: si tarda más de 800ms no es un gesto, es alguien arrastrando.
 *  - Un solo dedo: pellizcar para hacer zoom no es deslizar.
 *  - Nada que se deslice por dentro —las tiras de fichas, las tablas anchas—
 *    se lo lleva primero; ahí el gesto ya significa otra cosa.
 */

const UMBRAL = 64;
const MAX_MS = 800;
/*
 * La franja del borde izquierdo es del sistema, no nuestra.
 *
 * En iOS y en Android, arrastrar desde ahí significa "volver atrás" desde antes
 * de que esta app existiera. Quitárselo al usuario para cambiar de mes sería
 * cambiarle un gesto que ya sabe por uno que tiene que aprender.
 */
const BORDE_DEL_SISTEMA = 28;

export function useDeslizarMes(mes: string, activo = true): void {
  // En una ref y no en estado: esto cambia sesenta veces por segundo mientras
  // el dedo se mueve y nada de eso tiene que repintar la pantalla.
  const gesto = useRef<{ x: number; y: number; t: number } | null>(null);
  const mesRef = useRef(mes);
  mesRef.current = mes;
  // Hay vistas sin selector de mes —los pendientes de revisar, la tendencia de
  // todo el historial—: ahí cambiar el mes por debajo sería cambiar algo que no
  // se está mostrando.
  const activoRef = useRef(activo);
  activoRef.current = activo;

  useEffect(() => {
    function empieza(e: TouchEvent) {
      if (!activoRef.current || e.touches.length !== 1) { gesto.current = null; return; }
      const t = e.touches[0];
      // Si el dedo cae sobre algo que se desliza solo, el gesto es de eso.
      const dentro = (e.target as Element | null)?.closest?.('.chips-fila, .tabla-ancha, .sheet, .fila-deslizable, input, select, textarea');
      if (dentro) { gesto.current = null; return; }
      if (t.clientX < BORDE_DEL_SISTEMA) { gesto.current = null; return; }
      gesto.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    }

    function termina(e: TouchEvent) {
      const g = gesto.current;
      gesto.current = null;
      if (!g || e.changedTouches.length !== 1) return;

      const t = e.changedTouches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (Date.now() - g.t > MAX_MS) return;
      if (Math.abs(dx) < UMBRAL) return;
      if (Math.abs(dx) < Math.abs(dy) * 2) return;

      // Arrastrar hacia la izquierda avanza, como pasar la hoja de un cuaderno.
      const destino = shiftMonth(mesRef.current, dx < 0 ? 1 : -1);
      if (destino > shiftMonth(currentMonth(), MESES_HACIA_ADELANTE)) return;
      cambiarMes(destino);
    }

    window.addEventListener('touchstart', empieza, { passive: true });
    window.addEventListener('touchend', termina, { passive: true });
    return () => {
      window.removeEventListener('touchstart', empieza);
      window.removeEventListener('touchend', termina);
    };
  }, []);
}

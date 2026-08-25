import { useSyncExternalStore } from 'react';
import { currentMonth } from './format';

/**
 * El mes que la app está mirando, compartido entre las pantallas.
 *
 * Antes cada pantalla guardaba el suyo, así que uno se ponía a planificar
 * septiembre en el Resumen, tocaba Movimientos y aparecía agosto otra vez. El
 * mes es dónde uno está parado, no una preferencia de cada pantalla.
 *
 * Se guarda por pestaña y no por dispositivo: al volver a abrir la app al día
 * siguiente lo natural es partir en el mes de hoy, no donde se quedó la última
 * vez. `sessionStorage` hace justo eso.
 */

const CLAVE = 'hogar:mes';
const EVENTO = 'hogar:mes-cambiado';

/** Un mes con forma YYYY-MM y nada más: lo guardado no se cree sin mirar. */
function valido(valor: string | null): valor is string {
  return typeof valor === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(valor);
}

function leer(): string {
  try {
    const guardado = sessionStorage.getItem(CLAVE);
    return valido(guardado) ? guardado : currentMonth();
  } catch {
    // Safari en navegación privada puede bloquear el almacenamiento.
    return currentMonth();
  }
}

export function cambiarMes(mes: string): void {
  if (!valido(mes)) return;
  try {
    sessionStorage.setItem(CLAVE, mes);
  } catch {
    /* sin almacenamiento, el cambio dura lo que la pantalla */
  }
  window.dispatchEvent(new Event(EVENTO));
}

export function useMes(): string {
  return useSyncExternalStore(
    (avisar) => {
      window.addEventListener(EVENTO, avisar);
      return () => window.removeEventListener(EVENTO, avisar);
    },
    leer,
    currentMonth,
  );
}

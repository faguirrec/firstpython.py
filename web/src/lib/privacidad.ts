import { useSyncExternalStore } from 'react';

/**
 * Modo privado: oculta los montos de los sueldos.
 *
 * Pensado para cuando alguien mira la pantalla de reojo. Se guarda por
 * dispositivo, no en la cuenta: es una preferencia de cómo se ve la app en
 * *este* teléfono, y lo natural es tenerla activada en el del trabajo y no en
 * el de la casa.
 *
 * Los porcentajes del reparto siguen a la vista a propósito: son el sentido de
 * la app, y revelan la proporción entre sueldos pero no cuánto gana cada uno.
 */

const CLAVE = 'hogar:sueldos-ocultos';
const EVENTO = 'hogar:privacidad';

function leer(): boolean {
  try {
    return localStorage.getItem(CLAVE) === '1';
  } catch {
    // Safari en navegación privada puede bloquear el almacenamiento.
    return false;
  }
}

export function alternarPrivacidad(): void {
  try {
    localStorage.setItem(CLAVE, leer() ? '0' : '1');
  } catch {
    /* sin almacenamiento, el cambio dura lo que la pantalla */
  }
  window.dispatchEvent(new Event(EVENTO));
}

export function usePrivacidad(): boolean {
  return useSyncExternalStore(
    (avisar) => {
      window.addEventListener(EVENTO, avisar);
      // Si se activa en otra pestaña, esta también se entera.
      window.addEventListener('storage', avisar);
      return () => {
        window.removeEventListener(EVENTO, avisar);
        window.removeEventListener('storage', avisar);
      };
    },
    leer,
    () => false,
  );
}

/** Sustituye un monto por puntos cuando el modo privado está activo. */
export function ocultar(texto: string, oculto: boolean): string {
  return oculto ? '•'.repeat(Math.min(Math.max(texto.length - 2, 4), 9)) : texto;
}

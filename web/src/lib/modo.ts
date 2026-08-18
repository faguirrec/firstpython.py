import { useSyncExternalStore } from 'react';

/**
 * Qué bolsillo está mirando la app.
 *
 * `hogar` son las cuentas compartidas: lo que se reparte entre los dos.
 * `personal` son las de quien está usando la app, y sólo las ve esa persona.
 *
 * Es la misma app y los mismos datos; lo que cambia es qué movimientos se
 * cuentan. Se guarda por dispositivo, como el modo privado: uno se sienta a
 * revisar el mes del hogar, o el suyo, y quiere volver a lo mismo la próxima
 * vez que abra la app.
 */

export type Modo = 'hogar' | 'personal';

const CLAVE = 'hogar:modo';
const EVENTO = 'hogar:modo-cambiado';

function leer(): Modo {
  try {
    return localStorage.getItem(CLAVE) === 'personal' ? 'personal' : 'hogar';
  } catch {
    // Safari en navegación privada puede bloquear el almacenamiento.
    return 'hogar';
  }
}

export function cambiarModo(modo: Modo): void {
  try {
    localStorage.setItem(CLAVE, modo);
  } catch {
    /* sin almacenamiento, el cambio dura lo que la pantalla */
  }
  window.dispatchEvent(new Event(EVENTO));
}

export function useModo(): Modo {
  return useSyncExternalStore(
    (avisar) => {
      window.addEventListener(EVENTO, avisar);
      window.addEventListener('storage', avisar);
      return () => {
        window.removeEventListener(EVENTO, avisar);
        window.removeEventListener('storage', avisar);
      };
    },
    leer,
    () => 'hogar' as Modo,
  );
}

/** Sufijo para las consultas a la API. En modo hogar no se manda nada. */
export function paramModo(modo: Modo): string {
  return modo === 'personal' ? '&modo=personal' : '';
}

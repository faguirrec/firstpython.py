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
 *
 * Todo eso está escrito en presente porque el código sigue ahí, pero hoy no se
 * ve: el modo personal está escondido detrás de `MODO_PERSONAL_VISIBLE`, acá
 * abajo, donde también está explicado por qué y cómo se vuelve a prender.
 */

export type Modo = 'hogar' | 'personal';

/**
 * El interruptor del modo Personal. Hoy está apagado.
 *
 * Por qué: MyHaus volvió a ser una sola cosa —repartir los gastos del hogar
 * entre dos personas según lo que gana cada una— y el modo Personal tiraba
 * para el otro lado. Obligaba a preguntarse "¿en cuál de los dos lados estoy?"
 * antes de leer cualquier cifra, partía en dos cada pantalla (la mitad del
 * Resumen existe sólo para el bolsillo propio) y competía con apps de finanzas
 * personales que hacen eso mucho mejor. Escondiéndolo, todo lo que se ve en la
 * app responde siempre a la misma pregunta.
 *
 * Por qué escondido y no borrado: la decisión es de producto, no técnica, y se
 * puede revertir. Los datos siguen todos donde estaban —los movimientos con
 * `scope: 'personal'` que ya existen se guardan igual y se siguen dejando fuera
 * del reparto, que es justamente lo que los hace personales— y el servidor no
 * cambió en nada: las rutas, las tablas y los cálculos del modo personal están
 * intactos. Lo único que se apaga es la puerta de entrada.
 *
 * Cómo volver a prenderlo:
 *   1. Poner esta constante en `true`. Eso solo alcanza: vuelve el selector
 *      Hogar/Personal en la cabecera, `useModo()` vuelve a leer lo que el
 *      aparato tenía guardado, reaparecen la vista personal del Resumen, el
 *      filtro "Personales" de Movimientos, la columna del detalle mensual de
 *      Análisis y la elección común/personal al anotar un gasto.
 *   2. Revisar los textos que se reescribieron mientras estaba apagado: en la
 *      interfaz ya no se nombra "lo personal" sino "lo que no se reparte".
 *      Buscar `MODO_PERSONAL_VISIBLE` en `web/src` los deja a todos a la vista.
 *
 * Va anotada como `boolean` a propósito y no como el literal `false`: así el
 * compilador sigue revisando el código de la rama apagada en vez de darla por
 * muerta, y el día que se vuelva a prender no aparecen errores dormidos.
 */
export const MODO_PERSONAL_VISIBLE: boolean = false;

const CLAVE = 'hogar:modo';
const EVENTO = 'hogar:modo-cambiado';

function leer(): Modo {
  // Con el modo escondido no se mira lo guardado. Alguien pudo haber dejado su
  // teléfono en "personal" el día antes de que esto se apagara, y no tendría
  // cómo volver: sin selector, se quedaría mirando una app a medias.
  if (!MODO_PERSONAL_VISIBLE) return 'hogar';
  try {
    return localStorage.getItem(CLAVE) === 'personal' ? 'personal' : 'hogar';
  } catch {
    // Safari en navegación privada puede bloquear el almacenamiento.
    return 'hogar';
  }
}

export function cambiarModo(modo: Modo): void {
  // Nadie debería poder cambiar de bolsillo mientras el modo está escondido.
  // El único botón que llama acá ya no se dibuja, pero dejarlo sin candado
  // significaría que basta una llamada suelta para dejar la app en un estado
  // que la interfaz no sabe deshacer.
  if (!MODO_PERSONAL_VISIBLE) return;
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

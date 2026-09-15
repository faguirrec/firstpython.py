import { useSyncExternalStore } from 'react';

/**
 * Claro, oscuro, o lo que diga el teléfono.
 *
 * Hasta ahora la app seguía siempre al sistema y no había cómo decirle otra
 * cosa. Suena razonable hasta que alguien tiene el teléfono en oscuro por la
 * batería o por la noche, y prefiere esta app en claro: las cifras de plata se
 * leen distinto según el fondo y es una preferencia legítima, no un capricho.
 *
 * Tres estados y no dos. "Sistema" tiene que ser uno de ellos y ser el que
 * viene puesto: es lo que la app hacía antes, y quien nunca entre acá no debería
 * notar ningún cambio.
 *
 * La hoja de estilos ya sabe leer esto: `:root[data-theme="dark"]` y
 * `:root:not([data-theme="light"])` dentro del `@media` existen desde que se
 * definió la paleta, justamente para que un día se pudiera elegir.
 */

export type Tema = 'sistema' | 'claro' | 'oscuro';

const CLAVE = 'hogar:tema';
const EVENTO = 'hogar:tema-cambiado';

function valido(v: string | null): v is Tema {
  return v === 'sistema' || v === 'claro' || v === 'oscuro';
}

export function leerTema(): Tema {
  try {
    const guardado = localStorage.getItem(CLAVE);
    return valido(guardado) ? guardado : 'sistema';
  } catch {
    // Safari en navegación privada puede bloquear el almacenamiento.
    return 'sistema';
  }
}

/**
 * Estampa la elección en el `<html>`, que es lo que mira la hoja de estilos.
 *
 * Con "sistema" no se estampa nada: se borra el atributo y vuelve a mandar la
 * consulta `prefers-color-scheme`. Poner `data-theme="sistema"` habría sido un
 * tercer valor que el CSS no conoce y que rompería las dos reglas que sí.
 */
export function aplicarTema(tema: Tema): void {
  const raiz = document.documentElement;
  if (tema === 'sistema') raiz.removeAttribute('data-theme');
  else raiz.setAttribute('data-theme', tema === 'claro' ? 'light' : 'dark');

  /*
   * Y el color de la barra de estado del teléfono.
   *
   * Las dos etiquetas `theme-color` del HTML llevan `media` y el navegador
   * elige según el sistema, así que con el tema forzado quedarían al revés:
   * app en claro y barra oscura. Acá se pone una tercera sin `media`, que gana
   * cuando hay elección y se saca cuando se vuelve a "sistema".
   */
  const fondo = tema === 'claro' ? '#f4f5f2' : '#101410';
  let etiqueta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-forzado]');
  if (tema === 'sistema') {
    etiqueta?.remove();
    return;
  }
  if (!etiqueta) {
    etiqueta = document.createElement('meta');
    etiqueta.name = 'theme-color';
    etiqueta.dataset.forzado = '1';
    document.head.appendChild(etiqueta);
  }
  etiqueta.content = fondo;
}

export function cambiarTema(tema: Tema): void {
  try {
    localStorage.setItem(CLAVE, tema);
  } catch {
    /* sin almacenamiento, la elección dura lo que la pestaña */
  }
  aplicarTema(tema);
  window.dispatchEvent(new Event(EVENTO));
}

export function useTema(): Tema {
  return useSyncExternalStore(
    (avisar) => {
      window.addEventListener(EVENTO, avisar);
      return () => window.removeEventListener(EVENTO, avisar);
    },
    leerTema,
    () => 'sistema',
  );
}

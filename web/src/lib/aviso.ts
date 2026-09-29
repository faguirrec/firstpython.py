import { useSyncExternalStore } from 'react';

/**
 * El aviso breve que confirma lo que acaba de pasar.
 *
 * Hasta ahora guardar un gasto no decía nada: la hoja se cerraba y había que
 * buscar el movimiento en la lista para creerle a la app. Un aviso de dos
 * líneas cierra el gesto, y cuando la acción se puede revertir trae el botón
 * para hacerlo —que es mucho mejor que preguntar "¿estás seguro?" antes—.
 *
 * Hay uno solo a la vez. Apilarlos en una app de teléfono tapa la pantalla, y
 * el que importa es siempre el último.
 */

export type Aviso = {
  id: number;
  texto: string;
  tono: 'ok' | 'error';
  /** Si existe, el aviso ofrece deshacer y se queda un rato más. */
  deshacer?: () => unknown | Promise<unknown>;
};

let actual: Aviso | null = null;
let siguienteId = 1;
let temporizador: ReturnType<typeof setTimeout> | null = null;
const oyentes = new Set<() => void>();

function emitir(): void {
  for (const avisar of oyentes) avisar();
}

function programarCierre(ms: number): void {
  if (temporizador) clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    actual = null;
    emitir();
  }, ms);
}

export function avisar(texto: string, deshacer?: Aviso['deshacer']): void {
  actual = { id: siguienteId++, texto, tono: 'ok', deshacer };
  emitir();
  // Con deshacer conviene más tiempo: hay que leer, decidir y apuntar el dedo.
  programarCierre(deshacer ? 7000 : 3500);
}

export function avisarError(texto: string): void {
  actual = { id: siguienteId++, texto, tono: 'error' };
  emitir();
  programarCierre(6000);
}

export function cerrarAviso(): void {
  if (temporizador) clearTimeout(temporizador);
  actual = null;
  emitir();
}

export function useAviso(): Aviso | null {
  return useSyncExternalStore(
    (avisar) => {
      oyentes.add(avisar);
      return () => {
        oyentes.delete(avisar);
      };
    },
    () => actual,
    () => null,
  );
}

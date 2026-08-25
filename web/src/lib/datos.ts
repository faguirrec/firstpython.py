import { useSyncExternalStore } from 'react';

/**
 * Aviso de que los datos del hogar cambiaron.
 *
 * Existe porque el botón de anotar vive fuera de las pantallas —está fijo sobre
 * la barra, en todas—, así que al guardar un movimiento no tiene a quién
 * decírselo. Cada pantalla escucha este contador y vuelve a cargar.
 *
 * Es deliberadamente tonto: un número que sube. Quién tiene que recargar qué lo
 * decide cada pantalla con sus propias dependencias, y no hay caché que pueda
 * quedar a medio invalidar.
 */

let version = 0;
const oyentes = new Set<() => void>();

export function datosCambiaron(): void {
  version += 1;
  for (const avisar of oyentes) avisar();
}

export function useVersionDatos(): number {
  return useSyncExternalStore(
    (avisar) => {
      oyentes.add(avisar);
      return () => {
        oyentes.delete(avisar);
      };
    },
    () => version,
    () => 0,
  );
}

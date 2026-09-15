/**
 * El enlace para entrar a una categoría y ver sus movimientos.
 *
 * Vive acá y no en cada pantalla porque el recorte tiene que viajar completo.
 * Un gráfico nunca muestra "todos los gastos de supermercado": muestra los de
 * un mes, de un ámbito, y a veces sin los fijos. Si al entrar la lista mostrara
 * otra cosa, el total de la lista no calzaría con la barra que se tocó y el
 * usuario dejaría de creerle a los dos números.
 *
 * Por eso lo que se arma acá no es "la categoría", es "la categoría tal como se
 * estaba mirando".
 */

export type Recorte = {
  /** null = "Sin categoría", que no es una categoría sino su ausencia. */
  categoryId: string | null;
  /** Sin mes se ve todo el historial, que es lo que muestra Análisis. */
  month?: string;
  scope?: 'comun' | 'personal';
  /** Verdadero cuando el gráfico del que se viene dejaba los fijos afuera. */
  sinFijos?: boolean;
};

export function verCategoria({ categoryId, month, scope, sinFijos }: Recorte): string {
  const q = new URLSearchParams();
  q.set('categoria', categoryId ?? 'sin');
  // El mes de Movimientos es el compartido entre pantallas; sólo se manda
  // cuando hay que sacarlo de ahí, y "todos" es justamente ese caso.
  if (month) q.set('mes', month);
  else q.set('mes', 'todos');
  if (scope) q.set('ambito', scope);
  if (sinFijos) q.set('sinfijos', '1');
  return `/movimientos?${q.toString()}`;
}

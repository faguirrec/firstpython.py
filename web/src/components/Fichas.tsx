/**
 * Piezas de identidad visual: la categoría y la persona.
 *
 * Reemplazan al punto de color que había antes. Un emoji dentro de un círculo
 * teñido se reconoce sin leer, que es lo que hace que una lista de gastos se
 * escanee de un vistazo en vez de leerse línea por línea.
 */

export function FichaCategoria({
  emoji,
  color,
  size = 34,
}: {
  emoji: string | null;
  color: string | null;
  size?: number;
}) {
  return (
    <span
      className="ficha"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // El color de la categoría queda de fondo, muy diluido: identifica sin
        // competir con el emoji ni con el monto.
        background: `color-mix(in srgb, ${color ?? 'var(--text-muted)'} 16%, var(--surface-1))`,
        fontSize: size * 0.5,
      }}
    >
      {emoji ?? '❓'}
    </span>
  );
}

/** Iniciales de una persona, con el mismo color que usa en el reparto. */
export function Avatar({ nombre, indice = 0, size = 32 }: { nombre: string; indice?: number; size?: number }) {
  const iniciales = nombre
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      className="ficha avatar"
      title={nombre}
      style={{
        width: size,
        height: size,
        background: indice === 0 ? 'var(--series-1)' : 'var(--series-2)',
        fontSize: size * 0.4,
      }}
    >
      {iniciales}
    </span>
  );
}

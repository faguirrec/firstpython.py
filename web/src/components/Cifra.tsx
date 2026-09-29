import { useEffect, useRef, useState } from 'react';
import { money } from '../lib/format';

/**
 * Una cifra de plata que sube hasta su valor en vez de aparecer de golpe.
 *
 * No es adorno: el número grande del Resumen es la respuesta a la pregunta con
 * la que uno abre la app, y verlo contar hace que la vista se quede ahí. Al
 * cambiar de mes también deja claro que el número cambió, cosa que apareciendo
 * de golpe cuesta notar.
 */
function useCifraAnimada(valor: number, duracion = 550): number {
  const [mostrado, setMostrado] = useState(valor);
  /* Lo último que se pintó. La animación siempre parte de acá y no del valor
     anterior: si la cifra cambia a mitad de cuenta, seguir desde donde iba
     evita el salto hacia atrás antes de volver a subir. */
  const pintado = useRef(valor);
  const cuadro = useRef<number | null>(null);

  useEffect(() => {
    const inicial = pintado.current;
    if (inicial === valor) return;

    // Quien pidió menos movimiento no quiere ver contar un número.
    const quieto = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (quieto) {
      pintado.current = valor;
      setMostrado(valor);
      return;
    }

    const partida = performance.now();
    const paso = (ahora: number) => {
      const avance = Math.min(1, (ahora - partida) / duracion);
      // Rápido al principio y frenando: así se lee el orden de magnitud antes
      // de que termine, y el final se siente asentado y no cortado.
      const suave = 1 - (1 - avance) ** 3;
      pintado.current = inicial + (valor - inicial) * suave;
      setMostrado(pintado.current);
      if (avance < 1) cuadro.current = requestAnimationFrame(paso);
    };
    cuadro.current = requestAnimationFrame(paso);

    return () => {
      if (cuadro.current != null) cancelAnimationFrame(cuadro.current);
    };
  }, [valor, duracion]);

  return mostrado;
}

export default function Cifra({
  valor,
  moneda,
  className,
  style,
}: {
  valor: number;
  moneda: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const mostrado = useCifraAnimada(valor);
  return (
    <span className={className} style={style}>
      {money(Math.round(mostrado), moneda)}
    </span>
  );
}

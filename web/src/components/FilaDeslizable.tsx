import { useRef, useState, type ReactNode } from 'react';

/**
 * Una fila que se desliza para dejar ver dos acciones.
 *
 * Corregir la categoría de un movimiento que entró por correo es la tarea más
 * repetida de la app —los bancos mandan "COMPRA EN TIENDA 1234" y alguien tiene
 * que decir qué fue—, y hasta acá costaba tres toques: abrir la ficha, elegir,
 * cerrar. Deslizando son dos, y el pulgar no se mueve de donde ya está.
 *
 * Deliberadamente no hay acciones destructivas de un solo gesto salvo borrar,
 * que además pide confirmación: un deslizamiento accidental no puede perder
 * plata anotada.
 *
 * El gesto se maneja con eventos táctiles y no con arrastre del navegador: en
 * iOS el arrastre nativo pelea con el scroll de la página y con el gesto de
 * "volver atrás" del borde izquierdo.
 */

/** Cuánto hay que arrastrar para que el panel quede abierto. */
const APERTURA = 132;
/** Antes de esto, el dedo todavía puede estar haciendo scroll vertical. */
const DECIDE = 12;

export default function FilaDeslizable({
  children,
  acciones,
  onClick,
}: {
  children: ReactNode;
  /** Lo que aparece debajo al deslizar. Se cierra solo al tocar cualquiera. */
  acciones: ReactNode;
  onClick: () => void;
}) {
  const [x, setX] = useState(0);
  const [abierta, setAbierta] = useState(false);
  const gesto = useRef<{ x: number; y: number; desde: number; eje: 'sin-decidir' | 'x' | 'y' } | null>(null);

  function empieza(e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    gesto.current = { x: t.clientX, y: t.clientY, desde: x, eje: 'sin-decidir' };
  }

  function mueve(e: React.TouchEvent) {
    const g = gesto.current;
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;

    /*
     * El eje se decide una vez y no se vuelve a discutir.
     *
     * Sin esto, una fila que empieza a abrirse se traba a mitad de camino
     * cuando el dedo sube un poco, que es lo que hace cualquier pulgar al
     * recorrer una pantalla.
     */
    if (g.eje === 'sin-decidir') {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      g.eje = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (g.eje === 'y') return;

    // Sólo hacia la izquierda, y con resistencia pasado el tope: el rebote dice
    // "hasta acá llega" sin necesidad de un cartel.
    const bruto = g.desde + dx;
    const limitado = bruto > 0 ? 0 : bruto < -APERTURA ? -APERTURA - (APERTURA + bruto) * -0.25 : bruto;
    setX(Math.max(limitado, -APERTURA - 24));
  }

  function termina() {
    const g = gesto.current;
    gesto.current = null;
    if (!g || g.eje !== 'x') return;
    const quedaAbierta = x < -APERTURA / 2;
    setAbierta(quedaAbierta);
    setX(quedaAbierta ? -APERTURA : 0);
  }

  function cerrar() {
    setAbierta(false);
    setX(0);
  }

  return (
    <div className="fila-deslizable">
      <div className="fila-acciones" aria-hidden={!abierta} onClick={cerrar}>
        {acciones}
      </div>
      <div
        className="fila-frente"
        style={{ transform: `translateX(${x}px)`, transition: gesto.current ? 'none' : undefined }}
        onTouchStart={empieza}
        onTouchMove={mueve}
        onTouchEnd={termina}
        onTouchCancel={termina}
      >
        <button
          className="item ghost fila-movimiento"
          onClick={() => {
            // Con el panel afuera, el primer toque lo guarda: es lo que espera
            // quien acaba de abrirlo y cambió de opinión.
            if (abierta) { cerrar(); return; }
            onClick();
          }}
        >
          {children}
        </button>
      </div>
    </div>
  );
}

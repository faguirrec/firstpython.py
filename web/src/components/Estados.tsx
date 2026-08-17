import type { ReactNode } from 'react';

/**
 * Estados vacíos y de carga.
 *
 * Para quien recién entra, la pantalla vacía *es* la primera impresión de la
 * app: en vez de dejarla en blanco, cada una explica qué va a aparecer ahí y
 * ofrece la acción que corresponde.
 */

export function Vacio({
  icono,
  titulo,
  detalle,
  accion,
}: {
  icono: ReactNode;
  titulo: string;
  detalle: string;
  accion?: ReactNode;
}) {
  return (
    <div className="vacio">
      <span className="vacio-icono">{icono}</span>
      <strong>{titulo}</strong>
      <p>{detalle}</p>
      {accion}
    </div>
  );
}

/** Bloque gris que ocupa el lugar del contenido mientras carga. */
export function Hueso({ w = '100%', h = 14, radio = 6 }: { w?: number | string; h?: number; radio?: number }) {
  return <span className="hueso" style={{ width: w, height: h, borderRadius: radio }} />;
}

/**
 * Esqueleto de una tarjeta. Mantener la forma de lo que viene evita el salto
 * de contenido cuando llegan los datos.
 */
export function TarjetaCargando({ filas = 3, conCifra = false }: { filas?: number; conCifra?: boolean }) {
  return (
    <div className="card" aria-busy="true" aria-label="Cargando">
      {conCifra && (
        <>
          <Hueso w={130} h={11} />
          <div style={{ height: 10 }} />
          <Hueso w={190} h={30} radio={8} />
          <div style={{ height: 14 }} />
        </>
      )}
      <div className="stack" style={{ gap: 12 }}>
        {Array.from({ length: filas }).map((_, i) => (
          <div key={i} className="row" style={{ gap: 12 }}>
            <Hueso w={32} h={32} radio={10} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Hueso w={`${70 - i * 12}%`} h={12} />
              <Hueso w={`${45 - i * 8}%`} h={10} />
            </div>
            <Hueso w={64} h={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

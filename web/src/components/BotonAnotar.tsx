import { useState } from 'react';
import { IconoMas } from './Icons';
import NuevoMovimiento from './NuevoMovimiento';
import { api } from '../lib/api';
import { avisar } from '../lib/aviso';
import { datosCambiaron } from '../lib/datos';
import { useMes } from '../lib/mes';

/**
 * Anotar un gasto, desde donde sea.
 *
 * Es el gesto más frecuente de la app y era el más caro: había que ir a
 * Movimientos o al Resumen, encontrar el botón en la cabecera y recién ahí
 * abrir el formulario. Acá vive fijo sobre la barra de pestañas, al alcance del
 * pulgar en las cinco pantallas.
 *
 * El movimiento se anota en el mes que se está mirando, no en el de hoy: si uno
 * está planificando septiembre, lo que anote es de septiembre.
 */
export default function BotonAnotar() {
  const [abierto, setAbierto] = useState(false);
  const mes = useMes();

  return (
    <>
      <button
        className="boton-anotar"
        onClick={() => setAbierto(true)}
        aria-label="Anotar un movimiento"
      >
        <IconoMas size={26} />
      </button>

      {abierto && (
        <NuevoMovimiento
          month={mes}
          onClose={() => setAbierto(false)}
          onSaved={(creado) => {
            setAbierto(false);
            // Las pantallas cargan sus propios datos y no saben de este botón.
            datosCambiaron();
            // Deshacer en vez de confirmar antes: anotar de más es barato de
            // arreglar, y preguntar en cada gasto sería insoportable.
            avisar(
              creado?.type === 'aporte' ? 'Aporte anotado' : 'Gasto anotado',
              creado ? () => api.deleteTransaction(creado.id) : undefined,
            );
          }}
        />
      )}
    </>
  );
}

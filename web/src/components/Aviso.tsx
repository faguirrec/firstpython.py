import { cerrarAviso, useAviso } from '../lib/aviso';
import { datosCambiaron } from '../lib/datos';

/**
 * El aviso que confirma la última acción, sobre la barra de pestañas.
 *
 * `key` cambia con cada aviso a propósito: así React vuelve a montar el
 * elemento y la animación de entrada se repite aunque el aviso anterior siguiera
 * en pantalla. Sin eso, dos gastos seguidos mostrarían el segundo sin moverse y
 * parecería que no pasó nada.
 */
export default function Aviso() {
  const aviso = useAviso();
  if (!aviso) return null;

  return (
    <div key={aviso.id} className={`aviso ${aviso.tono}`} role="status" aria-live="polite">
      <span>{aviso.texto}</span>
      {aviso.deshacer && (
        <button
          className="ghost small"
          onClick={async () => {
            const revertir = aviso.deshacer!;
            cerrarAviso();
            await revertir();
            datosCambiaron();
          }}
        >
          Deshacer
        </button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useModo } from '../lib/modo';
import { useSession } from '../lib/session';
import { avisar, avisarError } from '../lib/aviso';
import { datosCambiaron, useVersionDatos } from '../lib/datos';
import { money } from '../lib/format';
import { verCategoria } from '../lib/verCategoria';

/**
 * Lo que está pendiente de arreglar, con el botón para arreglarlo.
 *
 * Análisis eran siete tarjetas seguidas sin un solo botón: contaba lo que pasó
 * y no ofrecía nada que hacer. La causa número uno por la que se abandona una
 * app de presupuesto no es que sea fea ni cara, es exactamente eso —muestra y
 * no propone—, y lo que hay que proponer acá es concreto: los movimientos que
 * entraron por correo sin categoría ensucian todos los gráficos de la pantalla
 * hasta que alguien los ordena.
 *
 * "Ordenarlos solo" usa las mismas reglas de comercio que ya categorizan lo que
 * entra por correo. No inventa: lo que no reconoce lo deja igual, y queda la
 * lista para hacerlo a mano.
 */
export default function PorArreglar({ month }: { month: string }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const modo = useModo();
  const version = useVersionDatos();
  const [sinCategoria, setSinCategoria] = useState<{ total: number; count: number } | null>(null);
  const [ordenando, setOrdenando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const r = await api.byCategory(month, modo === 'personal' ? 'personal' : 'comun');
      const fila = r.categories.find((c) => c.categoryId === null);
      setSinCategoria(fila ? { total: fila.total, count: fila.count } : null);
    } catch {
      // Si no se puede saber, no se ofrece arreglar nada: una tarjeta de tarea
      // que aparece por un error de red es peor que no tenerla.
      setSinCategoria(null);
    }
  }, [month, modo, version]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!sinCategoria || sinCategoria.count === 0) return null;

  const { count, total } = sinCategoria;

  async function ordenarSolo() {
    setOrdenando(true);
    try {
      const { updated } = await api.recategorize();
      avisar(
        updated > 0
          ? `${updated} ${updated === 1 ? 'movimiento ordenado' : 'movimientos ordenados'}.`
          : 'Ninguno se pudo reconocer. Quedan para ordenar a mano.',
      );
      datosCambiaron();
      await cargar();
    } catch (err) {
      avisarError((err as Error).message);
    } finally {
      setOrdenando(false);
    }
  }

  return (
    <div className="card por-arreglar">
      <div className="card-head">
        <h3>Hay algo que ordenar</h3>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {count === 1
          ? `Un movimiento de ${money(total, currency)} quedó sin categoría`
          : `${count} movimientos por ${money(total, currency)} quedaron sin categoría`}
        , así que no aparecen en ningún gráfico de esta pantalla.
      </p>
      <div className="hero-acciones">
        <button className="primary" onClick={ordenarSolo} disabled={ordenando}>
          {ordenando ? 'Ordenando…' : 'Ordenarlos solo'}
        </button>
        <Link to={verCategoria({ categoryId: null, month, scope: modo === 'personal' ? 'personal' : 'comun' })}>
          <button className="ghost">Verlos uno por uno</button>
        </Link>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, type FijoDetectado } from '../lib/api';
import { useSession } from '../lib/session';
import { money } from '../lib/format';
import { FichaCategoria } from './Fichas';

/**
 * Los gastos fijos que la app reconoce sola en los movimientos que ya hay.
 *
 * Escribir el arriendo, la luz, el agua, el internet y las suscripciones a mano
 * es media hora de trabajo para decirle a la app algo que ya está en sus datos:
 * son los mismos comercios cobrando todos los meses. Esto los busca y los deja
 * listos para aceptar de un toque.
 *
 * Se proponen y no se crean solos, y la diferencia importa: un gasto fijo dice
 * "esto se espera pagar". Si la app inventara expectativas, el mes mostraría
 * deudas que nadie contrajo y la proyección arrastraría ese error a la plata
 * que cada uno tiene que poner. Lo que se ahorra es el tecleo, no la decisión.
 */
export default function FijosDetectados({ onCreados }: { onCreados: () => void }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const [sugerencias, setSugerencias] = useState<FijoDetectado[] | null>(null);
  const [elegidas, setElegidas] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .fijosSugeridos()
      .then((d) => {
        setSugerencias(d.sugerencias);
        // Vienen marcadas: si la app está bastante segura como para
        // proponerlas, hacer marcar diez casillas es trabajo por el trabajo.
        setElegidas(new Set(d.sugerencias.map((s) => s.name)));
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!sugerencias || sugerencias.length === 0) return null;

  function alternar(nombre: string) {
    setElegidas((previas) => {
      const siguiente = new Set(previas);
      if (siguiente.has(nombre)) siguiente.delete(nombre);
      else siguiente.add(nombre);
      return siguiente;
    });
  }

  async function aceptar() {
    setGuardando(true);
    setError(null);
    try {
      await api.aceptarFijosSugeridos([...elegidas]);
      setSugerencias([]);
      onCreados();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Encontrados en tus movimientos</h2>
        <span className="muted num" style={{ whiteSpace: 'nowrap' }}>{sugerencias.length}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Comercios que aparecen mes a mes en lo que ya tienen anotado. Revisen la lista y quiten lo
        que no corresponda; nada se anota hasta que toquen el botón.
      </p>

      <div className="list">
        {sugerencias.map((s) => (
          <label className="item fijo-sugerido" key={s.name} style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 'auto', flex: 'none' }}
              checked={elegidas.has(s.name)}
              onChange={() => alternar(s.name)}
            />
            <FichaCategoria emoji={s.categoryEmoji ?? '📌'} color={s.categoryColor ?? 'var(--marca)'} size={34} />
            <div className="body">
              <div className="title">{s.name}</div>
              <div className="meta">
                {s.meses} de los últimos {s.mesesConDatos} meses
                {s.categoryName && ` · ${s.categoryName}`}
                {s.dueDay && ` · alrededor del ${s.dueDay}`}
              </div>
            </div>
            <div className="amount">
              {s.amount != null ? (
                money(s.amount, currency)
              ) : (
                // Sin cifra fija: el monto cambia demasiado mes a mes como para
                // decir uno. La app va a usar el promedio, y decir "varía" es
                // más honesto que inventar una cifra de aspecto seguro.
                <span className="muted" style={{ fontWeight: 400 }}>varía</span>
              )}
            </div>
          </label>
        ))}
      </div>

      <button
        className="primary"
        style={{ marginTop: 12 }}
        disabled={guardando || elegidas.size === 0}
        onClick={() => void aceptar()}
      >
        {guardando ? 'Anotando…' : `Anotar ${elegidas.size} como gastos fijos`}
      </button>
    </div>
  );
}

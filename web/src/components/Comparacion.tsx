import { useEffect, useState } from 'react';
import { api, type CategoryChange, type Comparison } from '../lib/api';
import { useVersionDatos } from '../lib/datos';
import { useModo } from '../lib/modo';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';
import { FichaCategoria } from './Fichas';
import { Link } from 'react-router-dom';
import { verCategoria } from '../lib/verCategoria';

function Delta({ value, pct, currency }: { value: number; pct: number | null; currency: string }) {
  if (Math.abs(value) < 0.005) return <span className="muted">sin cambio</span>;
  const subio = value > 0;
  // Subir respecto del mes pasado no es una falla: un mes con un cumpleaños
  // gasta más y no pasa nada. La flecha ya dice hacia dónde va; el rojo se
  // guarda para lo que de verdad salió mal.
  return (
    <span style={{ color: subio ? 'var(--text-primary)' : 'var(--good-text)', whiteSpace: 'nowrap' }}>
      {subio ? '▲' : '▼'} {money(Math.abs(value), currency)}
      {pct != null && <span className="muted"> ({Math.abs(pct * 100).toFixed(0)}%)</span>}
    </span>
  );
}

function Fila({ row, currency, destino }: { row: CategoryChange; currency: string; destino: string }) {
  return (
    <Link className="item" to={destino}>
      <FichaCategoria emoji={row.emoji} color={row.color} />
      <div className="body">
        <div className="title">{row.category}</div>
        <div className="meta">
          {money(row.previous, currency)} → {money(row.current, currency)}
        </div>
      </div>
      <Delta value={row.deltaPrevious} pct={row.changePct} currency={currency} />
    </Link>
  );
}

/**
 * Responde "¿en qué nos estamos pasando?": el gasto común de este mes contra el
 * anterior y contra el promedio, ordenado por cuánto movió la aguja.
 */
export default function Comparacion({ month }: { month: string }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modo = useModo();
  // Para que anotar desde el botón flotante también actualice esta pantalla.
  const version = useVersionDatos();

  useEffect(() => {
    void api
      .comparison(month, 3, modo)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [month, modo, version]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const total = data.totalCurrent - data.totalPrevious;
  const vsPromedio = data.totalCurrent - data.totalAverage;

  /* Esta pantalla compara el mes que se mira, en el ámbito del modo, con los
     fijos incluidos: el enlace tiene que decir exactamente eso. */
  const abrir = (row: CategoryChange) =>
    verCategoria({
      categoryId: row.categoryId,
      month: data.month,
      scope: modo === 'personal' ? 'personal' : 'comun',
    });

  return (
    <>
      <div className="card">
        <h2>Comparación con {monthLabel(data.previousMonth)}</h2>
        {/* Etiqueta a la izquierda y cifra a la derecha, una debajo de la otra.
            En dos columnas, la etiqueta más larga se partía en dos líneas y la
            otra no, así que las dos cifras quedaban a distinta altura. */}
        <div className="comparativas">
          <div>
            <span className="label">Contra el mes anterior</span>
            <span className="cifra-sm">
              <Delta value={total} pct={data.totalPrevious > 0 ? total / data.totalPrevious : null} currency={currency} />
            </span>
          </div>
          <div>
            <span className="label">Contra el promedio de los meses</span>
            <span className="cifra-sm">
              <Delta
                value={vsPromedio}
                pct={data.totalAverage > 0 ? vsPromedio / data.totalAverage : null}
                currency={currency}
              />
            </span>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          {/* Se dice qué queda afuera sin nombrar el modo personal, que está
              escondido: lo que importa acá es que la cifra compara lo que se
              reparte, no de qué bolsillo salió el resto. */}
          {monthLabel(data.month)}: {money(data.totalCurrent, currency)} en gastos comunes. Lo que cada uno gasta por
          su cuenta no entra en esta comparación.
        </p>
      </div>

      {data.biggestIncreases.length > 0 && (
        <div className="card">
          <h3>Donde más subió</h3>
          <div className="list">
            {data.biggestIncreases.map((row) => (
              <Fila key={row.category} row={row} currency={currency} destino={abrir(row)} />
            ))}
          </div>
        </div>
      )}

      {data.biggestDecreases.length > 0 && (
        <div className="card">
          <h3>Donde bajó</h3>
          <div className="list">
            {data.biggestDecreases.map((row) => (
              <Fila key={row.category} row={row} currency={currency} destino={abrir(row)} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>Todas las categorías</h3>
        {/*
          * Cuatro columnas de plata no caben en un teléfono: cada nombre de
          * categoría se partía en dos líneas y las filas quedaban de alturas
          * distintas. Acá la categoría manda la fila, el mes que se mira va a
          * la derecha en grande, y los dos datos de contexto —el mes anterior y
          * el promedio— van debajo, que es el papel que cumplen.
          */}
        <div className="list">
          {data.categories.map((row) => (
            <Link className="item" key={row.category} to={abrir(row)}>
              <div className="body">
                <div className="title">{row.category}</div>
                <div className="meta">
                  {monthLabel(data.previousMonth, true)} {money(row.previous, currency)}
                  {' · promedio '}{money(row.average, currency)}
                </div>
              </div>
              <div className="amount">{money(row.current, currency)}</div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

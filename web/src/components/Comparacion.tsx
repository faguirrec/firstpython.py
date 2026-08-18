import { useEffect, useState } from 'react';
import { api, type CategoryChange, type Comparison } from '../lib/api';
import { useModo } from '../lib/modo';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';
import { FichaCategoria } from './Fichas';

function Delta({ value, pct, currency }: { value: number; pct: number | null; currency: string }) {
  if (Math.abs(value) < 0.005) return <span className="muted">sin cambio</span>;
  const subio = value > 0;
  return (
    <span style={{ color: subio ? 'var(--critical)' : 'var(--good-text)', whiteSpace: 'nowrap' }}>
      {subio ? '▲' : '▼'} {money(Math.abs(value), currency)}
      {pct != null && <span className="muted"> ({Math.abs(pct * 100).toFixed(0)}%)</span>}
    </span>
  );
}

function Fila({ row, currency }: { row: CategoryChange; currency: string }) {
  return (
    <div className="item">
      <FichaCategoria emoji={row.emoji} color={row.color} />
      <div className="body">
        <div className="title">{row.category}</div>
        <div className="meta">
          {money(row.previous, currency)} → {money(row.current, currency)}
        </div>
      </div>
      <Delta value={row.deltaPrevious} pct={row.changePct} currency={currency} />
    </div>
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

  useEffect(() => {
    void api
      .comparison(month, 3, modo)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [month, modo]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const total = data.totalCurrent - data.totalPrevious;
  const vsPromedio = data.totalCurrent - data.totalAverage;

  return (
    <>
      <div className="card">
        <h2>Comparación con {monthLabel(data.previousMonth)}</h2>
        <div className="grid2" style={{ marginTop: 10 }}>
          <div>
            <div className="label">Contra el mes anterior</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>
              <Delta value={total} pct={data.totalPrevious > 0 ? total / data.totalPrevious : null} currency={currency} />
            </div>
          </div>
          <div>
            <div className="label">Contra el promedio</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>
              <Delta
                value={vsPromedio}
                pct={data.totalAverage > 0 ? vsPromedio / data.totalAverage : null}
                currency={currency}
              />
            </div>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          {monthLabel(data.month)}: {money(data.totalCurrent, currency)} en gastos comunes. Los gastos personales de
          cada uno no entran en esta comparación.
        </p>
      </div>

      {data.biggestIncreases.length > 0 && (
        <div className="card">
          <h3>Donde más subió</h3>
          <div className="list">
            {data.biggestIncreases.map((row) => (
              <Fila key={row.category} row={row} currency={currency} />
            ))}
          </div>
        </div>
      )}

      {data.biggestDecreases.length > 0 && (
        <div className="card">
          <h3>Donde bajó</h3>
          <div className="list">
            {data.biggestDecreases.map((row) => (
              <Fila key={row.category} row={row} currency={currency} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>Todas las categorías</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Categoría</th>
              <th>{monthLabel(data.previousMonth, true)}</th>
              <th>{monthLabel(data.month, true)}</th>
              <th>Promedio</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((row) => (
              <tr key={row.category}>
                <td>{row.category}</td>
                <td className="num">{money(row.previous, currency)}</td>
                <td className="num">{money(row.current, currency)}</td>
                <td className="num">{money(row.average, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

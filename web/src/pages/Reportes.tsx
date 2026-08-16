import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';
import { CategoryBars, TrendChart, type CategorySlice, type TrendPoint } from '../components/Charts';

export default function Reportes() {
  const { household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [range, setRange] = useState(12);
  const [months, setMonths] = useState<(TrendPoint & { income: number; personal: number })[]>([]);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, c] = await Promise.all([api.monthlyReport(range), api.byCategory()]);
        setMonths(m.months);
        setCategories(c.categories);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [range]);

  const totalShared = months.reduce((a, b) => a + b.shared, 0);
  const average = months.length ? totalShared / months.length : 0;
  const last = months[months.length - 1];
  const previous = months[months.length - 2];
  const delta = last && previous && previous.shared > 0 ? (last.shared - previous.shared) / previous.shared : null;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Reportes</h1>
          <div className="sub">Cómo evoluciona el gasto de la casa</div>
        </div>
      </div>

      <div className="tabs">
        {[6, 12, 24].map((r) => (
          <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
            {r} meses
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="label">Promedio mensual de gastos comunes</div>
        <div className="hero num">{money(average, currency)}</div>
        {last && (
          <div className="muted">
            {monthLabel(last.month)}: {money(last.shared, currency)}
            {delta != null && (
              <span style={{ color: delta > 0 ? 'var(--critical)' : 'var(--good-text)' }}>
                {' '}· {delta > 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% vs. el mes anterior
              </span>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Gastos y aportes por mes</h2>
        <TrendChart data={months} currency={currency} />
      </div>

      <div className="card">
        <h2>Gasto acumulado por categoría</h2>
        <p className="muted" style={{ marginTop: 0 }}>Todo el historial registrado.</p>
        <CategoryBars data={categories} currency={currency} limit={12} />
      </div>

      <div className="card">
        <h2>Detalle mensual</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Mes</th>
              <th>Comunes</th>
              <th>Personales</th>
              <th>Ingreso</th>
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td>
                <td className="num">{money(m.shared, currency)}</td>
                <td className="num">{money(m.personal, currency)}</td>
                <td className="num">{m.income ? money(m.income, currency) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {months.length === 0 && <p className="muted">Todavía no hay datos suficientes.</p>}
      </div>
    </>
  );
}

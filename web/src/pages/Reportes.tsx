import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { currentMonth, money, monthLabel } from '../lib/format';
import { CategoryBars, TrendChart, type CategorySlice, type TrendPoint } from '../components/Charts';
import Cabecera from '../components/Cabecera';
import Presupuesto from '../components/Presupuesto';
import Comparacion from '../components/Comparacion';
import { usePrivacidad } from '../lib/privacidad';

const VISTAS = [
  { key: 'presupuesto', label: 'Presupuesto' },
  { key: 'comparacion', label: 'Comparación' },
  { key: 'tendencia', label: 'Tendencia' },
] as const;

type Vista = (typeof VISTAS)[number]['key'];

export default function Reportes() {
  const [vista, setVista] = useState<Vista>('presupuesto');
  const [month, setMonth] = useState(currentMonth());

  return (
    <>
      <Cabecera
        hogar="Análisis"
        month={vista !== 'tendencia' ? month : undefined}
        onMonthChange={vista !== 'tendencia' ? setMonth : undefined}
      />

      <div className="tabs">
        {VISTAS.map((v) => (
          <button key={v.key} className={vista === v.key ? 'active' : ''} onClick={() => setVista(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {vista === 'presupuesto' && <Presupuesto month={month} />}
      {vista === 'comparacion' && <Comparacion month={month} />}
      {vista === 'tendencia' && <Tendencia />}
    </>
  );
}

function Tendencia() {
  const { household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const privado = usePrivacidad();
  const [range, setRange] = useState(12);
  const [months, setMonths] = useState<(TrendPoint & { income: number; personal: number })[]>([]);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, c] = await Promise.all([api.monthlyReport(range), api.byCategory(undefined, 'comun')]);
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
        <h2>Gasto común acumulado por categoría</h2>
        <p className="muted" style={{ marginTop: 0 }}>Todo el historial registrado, sin los gastos personales.</p>
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
                <td className="num">
                  {m.income ? (privado ? '•••••' : money(m.income, currency)) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {months.length === 0 && <p className="muted">Todavía no hay datos suficientes.</p>}
      </div>
    </>
  );
}

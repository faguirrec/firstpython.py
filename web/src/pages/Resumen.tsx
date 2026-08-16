import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Settlement, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { currentMonth, dayLabel, money, monthLabel, percent } from '../lib/format';
import { CategoryBars, SplitBar, type CategorySlice } from '../components/Charts';
import MonthNav from '../components/MonthNav';
import NuevoMovimiento from '../components/NuevoMovimiento';

export default function Resumen() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [month, setMonth] = useState(currentMonth());
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [pending, setPending] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, c, t, g] = await Promise.all([
        api.settlement(month),
        api.byCategory(month),
        api.transactions({ month, limit: 6 }),
        api.gmailStatus().catch(() => ({ pendingReview: 0 })),
      ]);
      setSettlement(s);
      setCategories(c.categories);
      setRecent(t.transactions);
      setPending(g.pendingReview);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const me = settlement?.members.find((m) => m.userId === user?.id);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{household?.name}</h1>
          <div className="sub">{monthLabel(month)}</div>
        </div>
        <button className="primary small" onClick={() => setAdding(true)}>+ Movimiento</button>
      </div>

      <MonthNav month={month} onChange={setMonth} />

      {error && <div className="error">{error}</div>}

      {pending > 0 && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warning) 55%, transparent)' }}>
          <div className="row">
            <div>
              <strong>⚠ {pending} movimiento{pending === 1 ? '' : 's'} por revisar</strong>
              <div className="muted">Importados desde Gmail. Conviene confirmar categoría y si son comunes.</div>
            </div>
            <Link to="/movimientos?pendientes=1"><button className="small">Revisar</button></Link>
          </div>
        </div>
      )}

      <div className="card">
        <div className="label">Gastos comunes del mes</div>
        <div className="hero num">{money(settlement?.totalSharedExpenses ?? 0, currency)}</div>
        {settlement && settlement.totalPersonalExpenses > 0 && (
          <div className="muted">
            + {money(settlement.totalPersonalExpenses, currency)} en gastos personales (no se reparten)
          </div>
        )}

        {settlement && settlement.members.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="label" style={{ marginBottom: 6 }}>Reparto según sueldo</div>
            <SplitBar
              parts={settlement.members.map((m, i) => ({
                name: m.name,
                share: m.incomeShare,
                color: i === 0 ? 'var(--series-1)' : 'var(--series-2)',
              }))}
            />
          </div>
        )}
      </div>

      {settlement && (
        <div className="card">
          <div className="card-head">
            <h2>Cómo va cada uno</h2>
            <Link to="/liquidacion" className="muted">Ver detalle →</Link>
          </div>

          <div className="list">
            {settlement.members.map((m) => {
              const debe = m.deviation < -0.5;
              return (
                <div className="item" key={m.userId}>
                  <div className="body">
                    <div className="title">
                      {m.name} {m.userId === user?.id && <span className="muted">· tú</span>}
                    </div>
                    <div className="meta">
                      Le toca {money(m.fairShare, currency)} ({percent(m.incomeShare)}) · lleva puesto{' '}
                      {money(m.contributed, currency)}
                    </div>
                  </div>
                  <span className={`pill ${debe ? 'alert' : 'good'}`}>
                    {debe ? '▼ debe' : '▲ al día'} {money(Math.abs(m.deviation), currency)}
                  </span>
                </div>
              );
            })}
          </div>

          {me && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
              {me.deviation < -0.5
                ? `Te falta poner ${money(-me.deviation, currency)} este mes.`
                : `Vas al día: pusiste ${money(me.deviation, currency)} de más.`}
            </p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>En qué se fue</h2>
          <Link to="/reportes" className="muted">Reportes →</Link>
        </div>
        <CategoryBars data={categories} currency={currency} limit={6} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Últimos movimientos</h2>
          <Link to="/movimientos" className="muted">Ver todos →</Link>
        </div>
        <div className="list">
          {recent.length === 0 && <p className="muted">Sin movimientos este mes.</p>}
          {recent.map((t) => (
            <div className="item" key={t.id}>
              <i className="dot" style={{ background: t.categoryColor ?? 'var(--text-muted)' }} />
              <div className="body">
                <div className="title">{t.merchant ?? t.description ?? 'Movimiento'}</div>
                <div className="meta">
                  {dayLabel(t.occurredOn)} · {t.categoryName ?? 'Sin categoría'}
                  {t.scope === 'personal' && ' · personal'}
                  {t.type === 'aporte' && ` · aporte de ${t.userName ?? ''}`}
                </div>
              </div>
              <div className="amount">
                {t.type === 'aporte' ? '+' : ''}
                {money(t.amount, currency)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {adding && (
        <NuevoMovimiento
          month={month}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, type BudgetStatus, type CategoryBudget } from '../lib/api';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';

const STATUS: Record<CategoryBudget['status'], { label: string; glyph: string; color: string }> = {
  ok: { label: 'en rango', glyph: '✓', color: 'var(--good)' },
  atencion: { label: 'cerca del tope', glyph: '▲', color: 'var(--warning)' },
  excedido: { label: 'excedido', glyph: '✕', color: 'var(--critical)' },
  'sin-presupuesto': { label: 'sin presupuesto', glyph: '·', color: 'var(--text-muted)' },
};

/** Barra de avance del gasto contra su presupuesto. */
function Barra({ row, monthProgress }: { row: CategoryBudget; monthProgress: number }) {
  const filled = Math.min(row.used, 1) * 100;
  const overflow = row.used > 1 ? Math.min((row.used - 1) * 100, 100) : 0;

  return (
    <div style={{ position: 'relative', height: 10, background: 'var(--grid)', borderRadius: 5 }}>
      <div
        style={{
          width: `${filled}%`,
          height: '100%',
          background: STATUS[row.status].color,
          borderRadius: 5,
        }}
      />
      {overflow > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${overflow}%`,
            height: '100%',
            background: 'var(--critical)',
            borderRadius: 5,
            opacity: 0.45,
          }}
        />
      )}
      {/* Marca de por dónde va el mes: gastar 60% al día 15 es distinto que al día 28. */}
      {monthProgress > 0 && monthProgress < 1 && (
        <div
          title="Por aquí va el mes"
          style={{
            position: 'absolute',
            left: `${monthProgress * 100}%`,
            top: -3,
            width: 2,
            height: 16,
            background: 'var(--text-secondary)',
          }}
        />
      )}
    </div>
  );
}

export default function Presupuesto({ month }: { month: string }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.budgets(month);
      setStatus(data);
      const next: Record<string, string> = {};
      for (const c of data.categories) next[c.categoryId] = c.budget > 0 ? String(c.budget) : '';
      setDrafts(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(categoryId: string, raw: string) {
    const amount = Number(raw.replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
    setError(null);
    try {
      await api.saveBudget({ categoryId, amount });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!status) return <p className="muted">Cargando presupuesto…</p>;

  const conPresupuesto = status.categories.filter((c) => c.budget > 0);
  const sinPresupuesto = status.categories.filter((c) => c.budget === 0);
  // Sólo el gasto de las categorías con tope es comparable con el presupuesto.
  const usoTotal = status.totalBudget > 0 ? status.budgetedSpent / status.totalBudget : 0;

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Presupuesto</h2>
          <button className="small" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Listo' : 'Editar'}
          </button>
        </div>

        {conPresupuesto.length === 0 && !editing && (
          <p className="muted">
            Todavía no hay presupuestos. Toca <strong>Editar</strong> y define cuánto quieren gastar al mes en cada
            categoría; los montos se repiten todos los meses.
          </p>
        )}

        {conPresupuesto.length > 0 && (
          <>
            <div style={{ marginBottom: 8 }}>
              <div className="label">Gastado del tope</div>
              <div className="cifra-md" style={{ marginTop: 2 }}>
                {money(status.budgetedSpent, currency)}
                <span className="muted" style={{ fontWeight: 400 }}> de {money(status.totalBudget, currency)}</span>
              </div>
            </div>
            <Barra
              row={{
                ...conPresupuesto[0],
                budget: status.totalBudget,
                spent: status.budgetedSpent,
                used: usoTotal,
                status: usoTotal > 1 ? 'excedido' : usoTotal >= 0.8 ? 'atencion' : 'ok',
              }}
              monthProgress={status.monthProgress}
            />
            <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
              La marca vertical indica por dónde va el mes.
              {status.unbudgetedSpent > 0 && (
                <>
                  {' '}Aparte hay {money(status.unbudgetedSpent, currency)} en categorías sin tope, así que el gasto
                  común del mes suma {money(status.totalSpent, currency)}.
                </>
              )}
            </p>
          </>
        )}
      </div>

      {(status.overBudget.length > 0 || status.nearLimit.length > 0) && !editing && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warning) 55%, transparent)' }}>
          <h3>En qué se están pasando</h3>
          <div className="list">
            {[...status.overBudget, ...status.nearLimit].map((c) => (
              <div className="item" key={c.categoryId}>
                <i className="dot" style={{ background: c.color }} />
                <div className="body">
                  <div className="title">{c.category}</div>
                  <div className="meta">
                    {c.remaining < 0
                      ? `${money(-c.remaining, currency)} sobre el tope`
                      : `quedan ${money(c.remaining, currency)}`}
                  </div>
                </div>
                <span className={`pill ${c.status === 'excedido' ? 'alert' : 'warn'}`}>
                  {STATUS[c.status].glyph} {Math.round(c.used * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>{editing ? 'Definir montos mensuales' : 'Por categoría'}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Sólo cuentan los gastos comunes. Lo que cada uno gasta por su cuenta no entra acá.
        </p>

        <div className="stack">
          {(editing ? status.categories : conPresupuesto).map((c) => (
            <div key={c.categoryId}>
              <div className="row" style={{ marginBottom: 4 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <i className="dot" style={{ background: c.color }} />
                  <span style={{ fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.category}
                  </span>
                </span>

                {editing ? (
                  <input
                    style={{ width: 130, textAlign: 'right' }}
                    inputMode="decimal"
                    placeholder="sin tope"
                    value={drafts[c.categoryId] ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [c.categoryId]: e.target.value }))}
                    onBlur={(e) => void save(c.categoryId, e.target.value)}
                  />
                ) : (
                  <span className="num" style={{ fontSize: '0.86rem', whiteSpace: 'nowrap' }}>
                    {money(c.spent, currency)}
                    <span className="muted"> / {money(c.budget, currency)}</span>
                  </span>
                )}
              </div>

              {!editing && <Barra row={c} monthProgress={status.monthProgress} />}
            </div>
          ))}
        </div>

        {editing && (
          <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
            Deja en blanco o en cero las categorías que no quieras controlar. {sinPresupuesto.length} de{' '}
            {status.categories.length} están sin tope.
          </p>
        )}
      </div>
    </>
  );
}

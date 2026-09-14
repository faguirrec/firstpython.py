import { useCallback, useEffect, useState } from 'react';
import { api, type BudgetStatus, type CategoryBudget } from '../lib/api';
import { useVersionDatos } from '../lib/datos';
import { useModo } from '../lib/modo';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';
import { FichaCategoria } from './Fichas';
import { Link } from 'react-router-dom';
import { verCategoria } from '../lib/verCategoria';

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
  const modo = useModo();
  /* El presupuesto cuenta todos los gastos del mes en ese ámbito, fijos
     incluidos: el enlace a la lista tiene que pedir lo mismo o los totales no
     van a calzar. */
  const abrir = (categoryId: string) =>
    verCategoria({ categoryId, month, scope: modo === 'personal' ? 'personal' : 'comun' });
  // Para que anotar desde el botón flotante también actualice esta pantalla.
  const version = useVersionDatos();

  const load = useCallback(async () => {
    try {
      const data = await api.budgets(month, modo);
      setStatus(data);
      const next: Record<string, string> = {};
      for (const c of data.categories) next[c.categoryId] = c.budget > 0 ? String(c.budget) : '';
      setDrafts(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, modo, version]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(categoryId: string, raw: string) {
    const amount = Number(raw.replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
    setError(null);
    try {
      await api.saveBudget({ categoryId, amount, modo });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!status) return <p className="muted">Cargando presupuesto…</p>;

  const conPresupuesto = status.categories.filter((c) => c.budget > 0);
  const sinPresupuesto = status.categories.filter((c) => c.budget === 0);
  // Las que gastan sin control: las únicas sobre las que vale la pena insistir.
  const sinTopeConGasto = sinPresupuesto.filter((c) => c.spent > 0);
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
          <div className="card-head">
            <h3 style={{ margin: 0 }}>En qué se están pasando</h3>
            {/* Pasarse del tope tiene dos salidas de verdad: gastar menos o
                reconocer que el tope estaba mal puesto. La segunda es la que la
                app puede ofrecer, y hasta acá no ofrecía ninguna. */}
            <button className="small ghost" onClick={() => setEditing(true)}>Ajustar los topes</button>
          </div>
          <div className="list">
            {[...status.overBudget, ...status.nearLimit].map((c) => (
              <Link className="item" key={c.categoryId} to={abrir(c.categoryId)}>
                <FichaCategoria emoji={c.emoji} color={c.color} />
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
              </Link>
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
                {editing ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <FichaCategoria emoji={c.emoji} color={c.color} size={26} />
                    <span style={{ fontSize: 'var(--t-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.category}
                    </span>
                  </span>
                ) : (
                  <Link
                    to={abrir(c.categoryId)}
                    className="nombre-categoria"
                    aria-label={`Ver los movimientos de ${c.category}`}
                  >
                    <FichaCategoria emoji={c.emoji} color={c.color} size={26} />
                    <span style={{ fontSize: 'var(--t-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.category}
                    </span>
                  </Link>
                )}

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
                  <span className="num" style={{ fontSize: 'var(--t-md)', whiteSpace: 'nowrap' }}>
                    {money(c.spent, currency)}
                    <span className="muted"> / {money(c.budget, currency)}</span>
                  </span>
                )}
              </div>

              {!editing && <Barra row={c} monthProgress={status.monthProgress} />}
            </div>
          ))}
        </div>

        {/*
          * Gastan y nadie les puso tope.
          *
          * Son las que no aparecen en ninguna barra de esta pantalla: se gastan
          * en silencio. Ofrecer ponerles tope acá convierte un dato muerto en la
          * única decisión que esta pantalla puede pedir.
          */}
        {!editing && sinTopeConGasto.length > 0 && (
          <div className="sin-tope">
            <p className="muted" style={{ marginTop: 0 }}>
              {sinTopeConGasto.length === 1
                ? 'Una categoría gastó este mes y no tiene tope:'
                : `${sinTopeConGasto.length} categorías gastaron este mes y no tienen tope:`}{' '}
              {sinTopeConGasto.slice(0, 4).map((c) => c.category).join(', ')}
              {sinTopeConGasto.length > 4 && ` y ${sinTopeConGasto.length - 4} más`}.
            </p>
            <button className="primary small" onClick={() => setEditing(true)}>Ponerles tope</button>
          </div>
        )}

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

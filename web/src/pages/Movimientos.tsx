import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Category, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { currentMonth, dayLabel, money, monthLabel } from '../lib/format';
import Cabecera from '../components/Cabecera';
import { IconoMas } from '../components/Icons';
import NuevoMovimiento from '../components/NuevoMovimiento';
import Sheet from '../components/Sheet';

export default function Movimientos() {
  const { household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [params, setParams] = useSearchParams();
  const onlyPending = params.get('pendientes') === '1';

  const [month, setMonth] = useState(currentMonth());
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.transactions({
        month: onlyPending ? undefined : month,
        pending: onlyPending ? '1' : undefined,
        search: search || undefined,
        scope: scope || undefined,
        categoryId: categoryId || undefined,
        limit: 300,
      });
      setRows(data.transactions);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, search, scope, categoryId, onlyPending]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.categories().then((c) => setCategories(c.categories));
  }, []);

  const total = rows.filter((r) => r.type === 'gasto').reduce((a, b) => a + b.amount, 0);

  async function quickCategory(transaction: Transaction, newCategoryId: string) {
    await api.updateTransaction(transaction.id, { categoryId: newCategoryId, reviewed: true });
    await load();
    setDetail(null);
  }

  async function remove(transaction: Transaction) {
    if (!confirm(`¿Borrar "${transaction.merchant ?? transaction.description ?? 'este movimiento'}"?`)) return;
    await api.deleteTransaction(transaction.id);
    setDetail(null);
    await load();
  }

  return (
    <>
      <Cabecera
        hogar={onlyPending ? 'Pendientes de revisar' : 'Movimientos'}
        month={onlyPending ? undefined : month}
        onMonthChange={onlyPending ? undefined : setMonth}
        accion={
          <button
            className="primary small"
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}
          >
            <IconoMas size={16} /> Nuevo
          </button>
        }
      />

      {onlyPending && (
        <div className="card">
          <div className="row">
            <span className="muted">Mostrando sólo lo importado desde Gmail sin revisar.</span>
            <div className="wrap">
              <button
                className="small"
                onClick={async () => {
                  await api.reviewAll();
                  await load();
                }}
              >
                Marcar todo revisado
              </button>
              <button className="small ghost" onClick={() => setParams({})}>Ver todos</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <label className="field" style={{ marginBottom: 8 }}>
          <span>Buscar</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Comercio o nota"
            type="search"
          />
        </label>
        <div className="grid2">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Tipo</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Todos</option>
              <option value="comun">Comunes</option>
              <option value="personal">Personales</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Categoría</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Gastos listados</h2>
          <strong className="num">{money(total, currency)}</strong>
        </div>

        <div className="list">
          {rows.length === 0 && <p className="muted">No hay movimientos con estos filtros.</p>}
          {rows.map((t) => (
            <button
              key={t.id}
              className="item ghost"
              onClick={() => setDetail(t)}
              style={{ textAlign: 'left', border: 'none', borderBottom: '1px solid var(--grid)', borderRadius: 0, width: '100%' }}
            >
              <i className="dot" style={{ background: t.categoryColor ?? 'var(--text-muted)' }} />
              <div className="body">
                <div className="title">
                  {t.merchant ?? t.description ?? 'Movimiento'}
                  {t.reviewed === 0 && <span className="pill warn" style={{ marginLeft: 6 }}>por revisar</span>}
                </div>
                <div className="meta">
                  {dayLabel(t.occurredOn)} · {t.categoryName ?? 'Sin categoría'}
                  {t.scope === 'personal' && ' · personal'}
                  {t.type === 'aporte' && ` · aporte de ${t.userName ?? ''}`}
                  {t.fundedBy !== 'oficial' && t.type === 'gasto' && ` · pagó ${t.userName ?? 'uno de los dos'}`}
                  {t.source === 'gmail' && ' · ✉'}
                </div>
              </div>
              <div className="amount">
                {t.type === 'aporte' ? '+' : ''}
                {money(t.amount, currency)}
              </div>
            </button>
          ))}
        </div>
      </div>

      {detail && (
        <Sheet title={detail.merchant ?? 'Movimiento'} onClose={() => setDetail(null)}>
          <div className="hero num">{money(detail.amount, currency)}</div>
          <p className="muted" style={{ marginTop: 4 }}>
            {detail.occurredOn} · {detail.type === 'aporte' ? 'aporte' : detail.scope === 'comun' ? 'gasto común' : 'gasto personal'}
            {detail.accountLabel && ` · ${detail.accountLabel}`}
            {detail.installments && ` · ${detail.installments} cuotas`}
          </p>

          {detail.type === 'gasto' && (
            <label className="field">
              <span>Categoría</span>
              <select value={detail.categoryId ?? ''} onChange={(e) => void quickCategory(detail, e.target.value)}>
                <option value="">Sin categoría</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          {detail.source === 'gmail' && detail.rawSnippet && (
            <details className="table-view" open>
              <summary>Correo de origen</summary>
              <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.rawSnippet}</p>
            </details>
          )}

          <div className="wrap" style={{ marginTop: 14 }}>
            <button
              className="primary"
              onClick={() => {
                setEditing(detail);
                setDetail(null);
              }}
            >
              Editar
            </button>
            {detail.reviewed === 0 && (
              <button
                onClick={async () => {
                  await api.updateTransaction(detail.id, { reviewed: true });
                  setDetail(null);
                  await load();
                }}
              >
                Marcar revisado
              </button>
            )}
            <button className="danger" onClick={() => void remove(detail)}>Borrar</button>
          </div>
        </Sheet>
      )}

      {(adding || editing) && (
        <NuevoMovimiento
          month={month}
          existing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { api, type Category, type Member, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { today } from '../lib/format';
import Sheet from './Sheet';

type Props = {
  month?: string;
  existing?: Transaction | null;
  onClose: () => void;
  onSaved: () => void;
};

export default function NuevoMovimiento({ month, existing, onClose, onSaved }: Props) {
  const { user, household } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Al crear en un mes pasado, la fecha por defecto cae en ese mes.
  const defaultDate = month && !today().startsWith(month) ? `${month}-01` : today();

  const [form, setForm] = useState({
    occurredOn: existing?.occurredOn ?? defaultDate,
    amount: existing ? String(existing.amount) : '',
    type: existing?.type ?? ('gasto' as Transaction['type']),
    scope: existing?.scope ?? ('comun' as Transaction['scope']),
    fundedBy: existing?.fundedBy ?? 'oficial',
    categoryId: existing?.categoryId ?? '',
    merchant: existing?.merchant ?? '',
    description: existing?.description ?? '',
    userId: existing?.userId ?? user?.id ?? '',
  });

  useEffect(() => {
    void Promise.all([api.categories(), api.household()]).then(([c, h]) => {
      setCategories(c.categories.filter((cat) => !cat.archived));
      setMembers(h.members);
    });
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(form.amount.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Ingresa un monto válido');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        occurredOn: form.occurredOn,
        amount,
        type: form.type,
        scope: form.type === 'aporte' ? 'comun' : form.scope,
        fundedBy: form.type === 'aporte' ? 'oficial' : form.fundedBy,
        categoryId: form.categoryId || null,
        merchant: form.merchant || null,
        description: form.description || null,
        // Un gasto pagado de bolsillo pertenece a quien lo pagó; el aporte, a quien transfirió.
        userId:
          form.type === 'aporte'
            ? form.userId
            : form.fundedBy !== 'oficial'
              ? form.fundedBy
              : form.scope === 'personal'
                ? form.userId
                : null,
        reviewed: true,
      };
      if (existing) await api.updateTransaction(existing.id, payload);
      else await api.createTransaction(payload);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={existing ? 'Editar movimiento' : 'Nuevo movimiento'} onClose={onClose}>
      {error && <div className="error">{error}</div>}

      <form onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={form.type === 'gasto' ? 'active' : ''} onClick={() => set('type', 'gasto')}>
            Gasto
          </button>
          <button type="button" className={form.type === 'aporte' ? 'active' : ''} onClick={() => set('type', 'aporte')}>
            Aporte al hogar
          </button>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Monto ({household?.currency ?? 'CLP'})</span>
            <input
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
              inputMode="decimal"
              placeholder="45990"
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>Fecha</span>
            <input type="date" value={form.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} required />
          </label>
        </div>

        {form.type === 'gasto' ? (
          <>
            <label className="field">
              <span>Comercio</span>
              <input value={form.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Jumbo" />
            </label>

            <label className="field">
              <span>Categoría</span>
              <select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">Automática, según las reglas</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>

            <div className="grid2">
              <label className="field">
                <span>¿Se reparte?</span>
                <select value={form.scope} onChange={(e) => set('scope', e.target.value as 'comun' | 'personal')}>
                  <option value="comun">Común: entra al reparto</option>
                  <option value="personal">Personal: no se reparte</option>
                </select>
              </label>
              <label className="field">
                <span>¿Quién lo pagó?</span>
                <select value={form.fundedBy} onChange={(e) => set('fundedBy', e.target.value)}>
                  <option value="oficial">{household?.officialAccount ?? 'Cuenta del hogar'}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}, de su bolsillo</option>
                  ))}
                </select>
              </label>
            </div>
            {form.fundedBy !== 'oficial' && (
              <p className="muted" style={{ marginTop: -4 }}>
                Se contabiliza como aporte de esa persona al gasto común del mes.
              </p>
            )}
          </>
        ) : (
          <label className="field">
            <span>¿Quién transfirió?</span>
            <select value={form.userId} onChange={(e) => set('userId', e.target.value)}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Nota</span>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>

        <div className="wrap">
          <button className="primary" disabled={busy} style={{ flex: 1 }}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  );
}

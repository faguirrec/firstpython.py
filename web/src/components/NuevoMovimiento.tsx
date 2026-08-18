import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Category, type Member, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { today } from '../lib/format';
import Sheet from './Sheet';
import { Avatar, FichaCategoria } from './Fichas';

type Props = {
  month?: string;
  existing?: Transaction | null;
  onClose: () => void;
  onSaved: () => void;
};

/**
 * Anotar un gasto o un aporte.
 *
 * La pantalla se ordena como en las apps de banco: primero el monto, en grande;
 * después la categoría como fichas que se recorren con el pulgar; y el resto
 * como controles segmentados. Los menús desplegables obligaban a abrir, buscar
 * y elegir para algo que se hace varias veces al día.
 */
export default function NuevoMovimiento({ month, existing, onClose, onSaved }: Props) {
  const { user, household } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const montoRef = useRef<HTMLInputElement>(null);

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
      // Las más usadas del hogar quedan al alcance del pulgar, sin tener que
      // recorrer toda la fila.
      setCategories(
        c.categories.filter((cat) => !cat.archived).sort((a, b) => b.usos - a.usos || a.name.localeCompare(b.name)),
      );
      setMembers(h.members);
    });
    // El teclado numérico aparece de inmediato: el monto es lo primero que
    // uno quiere escribir.
    setTimeout(() => montoRef.current?.focus(), 250);
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const moneda = household?.currency ?? 'CLP';
  const simbolo = ['CLP', 'ARS', 'COP', 'MXN', 'USD'].includes(moneda) ? '$' : moneda;

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
        <div className="segmentado" style={{ marginBottom: 4 }}>
          <button type="button" className={form.type === 'gasto' ? 'activo' : ''} onClick={() => set('type', 'gasto')}>
            Gasto
          </button>
          <button type="button" className={form.type === 'aporte' ? 'activo' : ''} onClick={() => set('type', 'aporte')}>
            Aporte al hogar
          </button>
        </div>

        <div className="monto-grande">
          <span className="simbolo">{simbolo}</span>
          <input
            ref={montoRef}
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
            inputMode="decimal"
            placeholder="0"
            aria-label={`Monto en ${moneda}`}
            required
          />
        </div>

        {form.type === 'gasto' ? (
          <>
            <div className="label" style={{ margin: '10px 0 6px' }}>Categoría</div>
            <div className="chips">
              {categories.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`chip ${form.categoryId === c.id ? 'activo' : ''}`}
                  onClick={() => set('categoryId', form.categoryId === c.id ? '' : c.id)}
                >
                  <FichaCategoria emoji={c.emoji} color={c.color} size={30} />
                  <span className="nombre">{c.name}</span>
                </button>
              ))}
            </div>
            {!form.categoryId && (
              <p className="muted" style={{ marginTop: 0 }}>
                Si no eliges ninguna, se asigna sola según el comercio.
              </p>
            )}

            <label className="field" style={{ marginTop: 10 }}>
              <span>Comercio</span>
              <input value={form.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Jumbo" />
            </label>

            <div className="label" style={{ marginBottom: 6 }}>¿Se reparte?</div>
            <div className="segmentado" style={{ marginBottom: 12 }}>
              <button type="button" className={form.scope === 'comun' ? 'activo' : ''} onClick={() => set('scope', 'comun')}>
                Común
              </button>
              <button
                type="button"
                className={form.scope === 'personal' ? 'activo' : ''}
                onClick={() => set('scope', 'personal')}
              >
                Personal
              </button>
            </div>

            <div className="label" style={{ marginBottom: 6 }}>¿Quién lo pagó?</div>
            <div className="segmentado" style={{ marginBottom: 6 }}>
              <button
                type="button"
                className={form.fundedBy === 'oficial' ? 'activo' : ''}
                onClick={() => set('fundedBy', 'oficial')}
              >
                Cuenta del hogar
              </button>
              {members.map((m, i) => (
                <button
                  type="button"
                  key={m.id}
                  className={form.fundedBy === m.id ? 'activo' : ''}
                  onClick={() => set('fundedBy', m.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                >
                  <Avatar nombre={m.name} indice={i} size={20} />
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
            {form.fundedBy !== 'oficial' && (
              <p className="muted" style={{ marginTop: 0 }}>
                Se cuenta como aporte de esa persona al gasto común del mes.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="label" style={{ margin: '10px 0 6px' }}>¿Quién transfirió?</div>
            <div className="segmentado" style={{ marginBottom: 12 }}>
              {members.map((m, i) => (
                <button
                  type="button"
                  key={m.id}
                  className={form.userId === m.id ? 'activo' : ''}
                  onClick={() => set('userId', m.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                >
                  <Avatar nombre={m.name} indice={i} size={20} />
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="grid2">
          <label className="field">
            <span>Fecha</span>
            <input type="date" value={form.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} required />
          </label>
          <label className="field">
            <span>Nota</span>
            <input value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </div>

        <button className="primary" disabled={busy} style={{ width: '100%', minHeight: 50, fontSize: '1rem' }}>
          {busy ? 'Guardando…' : existing ? 'Guardar cambios' : 'Confirmar'}
        </button>
      </form>
    </Sheet>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, type GoalsView } from '../lib/api';
import { useModo } from '../lib/modo';
import { useSession } from '../lib/session';
import { money } from '../lib/format';
import Sheet from './Sheet';

/**
 * Metas de ahorro. El fondo de reserva es una sola bolsa, así que se reparte por
 * orden de prioridad: la primera meta se completa antes de que la siguiente
 * reciba nada. Mostrarlas todas avanzando a la vez daría a entender que hay más
 * plata de la que hay.
 */
export default function Metas() {
  const currency = useSession().household?.currency ?? 'CLP';
  const [view, setView] = useState<GoalsView | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modo = useModo();

  const load = useCallback(async () => {
    try {
      setView(await api.goals(modo));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [modo]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view) return null;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Metas de ahorro</h2>
        <button className="small primary" onClick={() => setAdding(true)}>+ Meta</button>
      </div>

      {error && <div className="error">{error}</div>}

      {view.goals.length === 0 ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Sin metas todavía. Una buena primera es un fondo de emergencia de tres meses de gastos comunes.
        </p>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Se financian con el fondo de reserva ({money(view.reserve, currency)}), en orden: la de arriba se completa
            primero.
          </p>

          <div className="stack" style={{ gap: 14 }}>
            {view.goals.map((goal, i) => (
              <div key={goal.id}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: '0.92rem' }}>
                      {i + 1}. {goal.name}
                    </strong>
                    {goal.complete && <span className="pill good" style={{ marginLeft: 6 }}>✓ lograda</span>}
                  </span>
                  <span className="num" style={{ fontSize: '0.86rem', whiteSpace: 'nowrap' }}>
                    {money(goal.funded, currency)}
                    <span className="muted"> / {money(goal.targetAmount, currency)}</span>
                  </span>
                </div>

                <div style={{ height: 10, background: 'var(--grid)', borderRadius: 5 }}>
                  <div
                    style={{
                      width: `${Math.min(goal.progress, 1) * 100}%`,
                      height: '100%',
                      background: goal.complete ? 'var(--good)' : 'var(--series-1)',
                      borderRadius: 5,
                    }}
                  />
                </div>

                <div className="row" style={{ marginTop: 4 }}>
                  <span className="muted">
                    {Math.round(goal.progress * 100)}%
                    {goal.targetDate && ` · para ${goal.targetDate}`}
                  </span>
                  <span className="muted">
                    {goal.complete
                      ? 'completa'
                      : goal.monthlyNeeded != null && goal.monthsLeft != null
                        ? goal.monthsLeft > 0
                          ? `${money(goal.monthlyNeeded, currency)} al mes por ${goal.monthsLeft} meses`
                          : 'la fecha ya pasó'
                        : `faltan ${money(goal.targetAmount - goal.funded, currency)}`}
                  </span>
                </div>

                <button
                  className="small ghost danger"
                  style={{ marginTop: 4 }}
                  onClick={async () => {
                    if (!confirm(`¿Borrar la meta "${goal.name}"?`)) return;
                    await api.deleteGoal(goal.id);
                    await load();
                  }}
                >
                  Borrar
                </button>
              </div>
            ))}
          </div>

          {view.unassigned > 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
              Quedan {money(view.unassigned, currency)} del fondo sin asignar a ninguna meta.
            </p>
          )}
        </>
      )}

      {adding && (
        <NuevaMeta
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NuevaMeta({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const currency = useSession().household?.currency ?? 'CLP';
  // La meta nace en el bolsillo que se está mirando.
  const modo = useModo();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const target = Number(amount.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!name.trim() || !Number.isFinite(target) || target <= 0) {
      setError('Ponle un nombre y un monto mayor que cero');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createGoal({ name: name.trim(), targetAmount: target, targetDate: date || null, modo });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Nueva meta" onClose={onClose}>
      {error && <div className="error">{error}</div>}

      <div className="wrap" style={{ marginBottom: 10 }}>
        {['Fondo de emergencia', 'Vacaciones', 'Auto', 'Pie departamento'].map((s) => (
          <button key={s} className="small ghost" onClick={() => setName(s)}>{s}</button>
        ))}
      </div>

      <label className="field">
        <span>Nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fondo de emergencia" />
      </label>
      <label className="field">
        <span>Monto a juntar ({currency})</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="4000000" />
      </label>
      <label className="field">
        <span>Fecha objetivo <em className="muted">(opcional)</em></span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <em className="muted">Con fecha, la app calcula cuánto hay que apartar cada mes.</em>
      </label>

      <div className="wrap">
        <button className="primary" onClick={() => void save()} disabled={busy} style={{ flex: 1 }}>
          {busy ? 'Guardando…' : 'Crear meta'}
        </button>
        <button className="ghost" onClick={onClose}>Cancelar</button>
      </div>
    </Sheet>
  );
}

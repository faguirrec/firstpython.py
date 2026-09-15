import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Category, type Member, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { monthLabel, shiftMonth, today } from '../lib/format';
import { MODO_PERSONAL_VISIBLE } from '../lib/modo';
import Sheet from './Sheet';
import { Avatar, FichaCategoria } from './Fichas';

type Props = {
  month?: string;
  existing?: Transaction | null;
  /**
   * Con qué llega abierto el formulario. Sirve para entrar desde una pantalla
   * que ya sabe qué se va a anotar —el reparto sabe quién debe poner cuánto— y
   * no obligar a repetirlo a mano.
   */
  inicial?: { type?: Transaction['type']; userId?: string; amount?: number };
  onClose: () => void;
  /** Recibe el movimiento guardado, para poder ofrecer deshacerlo. */
  onSaved: (guardado?: Transaction) => void;
};

/**
 * Anotar un gasto o un aporte.
 *
 * La pantalla se ordena como en las apps de banco: primero el monto, en grande;
 * después la categoría como fichas que se recorren con el pulgar; y el resto
 * como controles segmentados. Los menús desplegables obligaban a abrir, buscar
 * y elegir para algo que se hace varias veces al día.
 */
/**
 * Los meses a los que tiene sentido imputar un movimiento: el de su fecha y los
 * vecinos. Pagar en agosto la cuenta de septiembre es corriente; imputarla a
 * marzo no lo es, y una lista larga sólo invita a equivocarse.
 */
function mesesPosibles(fecha: string, actual: string): string[] {
  const base = fecha.slice(0, 7);
  const meses = [shiftMonth(base, -1), base, shiftMonth(base, 1)];
  if (!meses.includes(actual)) meses.push(actual);
  return [...new Set(meses)].sort();
}

export default function NuevoMovimiento({ month, existing, inicial, onClose, onSaved }: Props) {
  const { user, household } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const montoRef = useRef<HTMLInputElement>(null);

  /*
   * La fecha es cuándo ocurrió, siempre. Antes, al anotar en otro mes se le
   * ponía el día 1 de ese mes para que cayera donde correspondía: el gasto
   * quedaba bien contado pero con una fecha falsa, y después no cuadraba con la
   * cartola. Ahora eso lo resuelve el período, que es un campo aparte.
   */
  const [form, setForm] = useState({
    occurredOn: existing?.occurredOn ?? today(),
    // A qué mes cuenta: el que se está mirando, o el de la fecha.
    period: existing?.period ?? month ?? today().slice(0, 7),
    amount: existing ? String(existing.amount) : inicial?.amount ? String(Math.round(inicial.amount)) : '',
    type: existing?.type ?? inicial?.type ?? ('gasto' as Transaction['type']),
    scope: existing?.scope ?? ('comun' as Transaction['scope']),
    fundedBy: existing?.fundedBy ?? 'oficial',
    categoryId: existing?.categoryId ?? '',
    merchant: existing?.merchant ?? '',
    description: existing?.description ?? '',
    userId: existing?.userId ?? inicial?.userId ?? user?.id ?? '',
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

  /** El movimiento cuenta en un mes distinto al de su fecha. */
  const desfasado = form.period !== form.occurredOn.slice(0, 7);

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
        period: form.period,
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
      const guardado = existing
        ? await api.updateTransaction(existing.id, payload)
        : await api.createTransaction(payload);
      onSaved(existing ? undefined : guardado);
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

            {/*
              * Elegir si el gasto se reparte o no.
              *
              * Con el modo personal escondido la pregunta no tiene sentido: si
              * la app es sólo lo compartido, todo lo que uno anota acá es del
              * hogar, y ofrecer la otra mitad dejaría a mano la única forma de
              * crear movimientos que después no se verían en ninguna parte.
              *
              * Lo que no se toca es `form.scope` cuando se está editando: nace
              * con el ámbito que el movimiento ya tenía. Un gasto personal
              * viejo sigue siendo personal aunque se le corrija el monto, y no
              * se cuela al reparto por haber pasado por este formulario.
              */}
            {MODO_PERSONAL_VISIBLE && (
              <>
                <div className="label" style={{ marginBottom: 6 }}>¿Se reparte?</div>
                <div className="segmentado" style={{ marginBottom: 12 }}>
                  <button type="button" className={form.scope === 'comun' ? 'activo' : ''} onClick={() => set('scope', 'comun')}>
                    Común
                  </button>
                  <button
                    type="button"
                    className={form.scope === 'personal' ? 'activo' : ''}
                    onClick={() => {
                      // Al marcarlo personal, quien paga pasa a ser uno mismo:
                      // comprarse algo propio con la cuenta común es la excepción,
                      // no lo normal, y como valor por defecto salía del pozo del
                      // hogar sin que nadie respondiera por esa plata.
                      setForm((prev) => ({
                        ...prev,
                        scope: 'personal',
                        fundedBy: prev.fundedBy === 'oficial' ? (user?.id ?? prev.fundedBy) : prev.fundedBy,
                      }));
                    }}
                  >
                    Personal
                  </button>
                </div>
              </>
            )}

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

        {/*
          * Fecha, mes contable y nota se pliegan.
          *
          * En la enorme mayoría de los casos se anota algo de hoy que cuenta
          * en el mes que uno está mirando, y los tres campos ya vienen con esa
          * respuesta. Tenerlos siempre a la vista alargaba el formulario y
          * hacía parecer que había que decidirlos.
          *
          * Se abre solo cuando hay algo que mirar: al editar un movimiento
          * viejo, o cuando el mes no es el de la fecha.
          */}
        <details className="plegable" open={Boolean(existing) || desfasado}>
          <summary>
            Fecha y detalles
            <span className="resumen-dato">
              {' · '}{form.occurredOn === today() ? 'hoy' : form.occurredOn}
              {desfasado && `, cuenta en ${monthLabel(form.period)}`}
            </span>
          </summary>

          <div className="grid2">
            <label className="field">
              <span>Fecha</span>
              <input type="date" value={form.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} required />
            </label>
            <label className="field">
              <span>Cuenta para</span>
              <select value={form.period} onChange={(e) => set('period', e.target.value)}>
                {mesesPosibles(form.occurredOn, form.period).map((m) => (
                  <option key={m} value={m}>{monthLabel(m)}</option>
                ))}
              </select>
            </label>
          </div>

          {desfasado && (
            <p className="muted" style={{ marginTop: 0 }}>
              Se pagó en {monthLabel(form.occurredOn.slice(0, 7))} pero cuenta en {monthLabel(form.period)}. La fecha
              queda como está, para que cuadre con la cartola.
            </p>
          )}

          <label className="field" style={{ marginBottom: 0 }}>
            <span>Nota</span>
            <input value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </details>

        {/* Fijo abajo: el monto es lo único obligatorio, así que en el caso
            normal —anotar y confirmar— no debería hacer falta bajar por todo
            el formulario para llegar al botón. */}
        <div className="pie-hoja">
          <button className="primary" disabled={busy} style={{ minHeight: 50, fontSize: 'var(--t-lg)' }}>
            {busy ? 'Guardando…' : existing ? 'Guardar cambios' : 'Confirmar'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

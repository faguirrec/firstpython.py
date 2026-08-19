import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Category, type EstadoFijos, type GastoFijo } from '../lib/api';
import { useSession } from '../lib/session';
import { currentMonth, dayLabel, money } from '../lib/format';
import { FichaCategoria } from './Fichas';
import Sheet from './Sheet';

/**
 * Los gastos que se repiten todos los meses.
 *
 * Declararlos no los da por pagados: la app los cruza con los movimientos
 * reales y muestra cuáles ya aparecieron y cuáles no. Ese cruce es lo que
 * permite responder la pregunta de mitad de mes —qué falta por pagar— sin que
 * nadie tenga que acordarse.
 */
export default function GastosFijos() {
  const currency = useSession().household?.currency ?? 'CLP';
  const [estado, setEstado] = useState<EstadoFijos | null>(null);
  const [categorias, setCategorias] = useState<Category[]>([]);
  const [editando, setEditando] = useState<Partial<GastoFijo> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([api.gastosFijos(currentMonth()), api.categories()]);
      setEstado(e);
      setCategorias(c.categories.filter((x) => !x.archived));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function borrar(g: GastoFijo) {
    if (!confirm(`¿Quitar «${g.name}» de los gastos fijos? Los movimientos ya anotados no se tocan.`)) return;
    await api.borrarGastoFijo(g.id);
    await cargar();
  }

  const apagados = estado?.all.filter((g) => !g.active) ?? [];

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Gastos fijos del hogar</h2>
          <button className="small primary" onClick={() => setEditando({})}>Agregar</button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          El arriendo, las cuentas, las suscripciones. Se declaran una vez y la app te va diciendo cuáles ya se
          pagaron este mes y cuáles no. <strong>No crea movimientos</strong>: sólo compara con lo que realmente
          pasó.
        </p>

        {estado && estado.items.length > 0 && (
          <>
            <div className="list">
              {/* La fila entera abre el editor: con un botón aparte, el nombre
                  se quedaba sin ancho y terminaba cortado con puntos. */}
              {estado.items.map((g) => (
                <button className="item" key={g.id} onClick={() => setEditando(g)}>
                  <FichaCategoria
                    emoji={g.categoryEmoji ?? '📌'}
                    color={g.paid ? 'var(--good)' : 'var(--text-muted)'}
                    size={34}
                  />
                  <div className="body">
                    <div className="title">{g.name}</div>
                    <div className="meta">
                      {/* Ya pagado, lo que interesa es cuándo; la píldora de al
                          lado se encarga de decir que lo está. */}
                      {g.paid && g.paidWith
                        ? `Pagado el ${dayLabel(g.paidWith.occurredOn)}`
                        : `${g.dueDay ? `Vence el ${g.dueDay} · ` : ''}${
                            g.expectedFrom === 'promedio'
                              ? 'estimado según meses anteriores'
                              : g.expectedFrom === 'sin-datos'
                                ? 'monto variable, aún sin historia'
                                : 'monto declarado'
                          }`}
                    </div>
                  </div>
                  <span className={g.paid ? 'pill good' : 'pill'}>{g.paid ? 'pagado' : 'pendiente'}</span>
                  <div className="amount">{g.expected > 0 ? money(g.expected, currency) : '—'}</div>
                </button>
              ))}
            </div>

            <div className="list" style={{ marginTop: 10 }}>
              <div className="item">
                <div className="body"><div className="title">Esperado este mes</div></div>
                <div className="amount">{money(estado.totalExpected, currency)}</div>
              </div>
              <div className="item">
                <div className="body">
                  <div className="title">Falta por pagar</div>
                  <div className="meta">{estado.pendientes.length} de {estado.items.length}</div>
                </div>
                <div className="amount">{money(estado.totalPending, currency)}</div>
              </div>
            </div>
          </>
        )}

        {estado && estado.items.length === 0 && (
          <p className="muted">
            Todavía no hay ninguno. Agrega el arriendo y las cuentas: son los que más se repiten y los que menos
            gracia tiene anotar a mano cada mes.
          </p>
        )}
      </div>

      {apagados.length > 0 && (
        <div className="card">
          <h2>Apagados</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            No cuentan para el mes, pero quedan guardados por si vuelven.
          </p>
          <div className="list">
            {apagados.map((g) => (
              <div className="item" key={g.id}>
                <div className="body"><div className="title">{g.name}</div></div>
                <button
                  className="small"
                  onClick={async () => {
                    await api.actualizarGastoFijo(g.id, { active: true });
                    await cargar();
                  }}
                >
                  Reactivar
                </button>
                <button className="small danger ghost" onClick={() => void borrar(g)}>Quitar</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {editando && (
        <EditorGastoFijo
          gasto={editando}
          categorias={categorias}
          onClose={() => setEditando(null)}
          onSaved={async () => {
            setEditando(null);
            await cargar();
          }}
          onDelete={async (g) => {
            setEditando(null);
            await borrar(g);
          }}
        />
      )}
    </>
  );
}

function EditorGastoFijo({
  gasto,
  categorias,
  onClose,
  onSaved,
  onDelete,
}: {
  gasto: Partial<GastoFijo>;
  categorias: Category[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: (g: GastoFijo) => void;
}) {
  const [name, setName] = useState(gasto.name ?? '');
  // Vacío significa "cambia cada mes", que es distinto de cero.
  const [amount, setAmount] = useState(gasto.amount != null ? String(gasto.amount) : '');
  const [categoryId, setCategoryId] = useState(gasto.categoryId ?? '');
  const [dueDay, setDueDay] = useState(gasto.dueDay != null ? String(gasto.dueDay) : '');
  const [matchText, setMatchText] = useState(gasto.matchText ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Ponle un nombre');
      return;
    }
    const monto = amount.trim() ? Number(amount.replace(/[^\d.,-]/g, '').replace(',', '.')) : null;
    if (monto != null && (!Number.isFinite(monto) || monto <= 0)) {
      setError('El monto tiene que ser mayor que cero, o dejarlo vacío si cambia cada mes');
      return;
    }

    setBusy(true);
    setError(null);
    const cuerpo = {
      name: name.trim(),
      amount: monto,
      categoryId: categoryId || null,
      dueDay: dueDay ? Number(dueDay) : null,
      matchText: matchText.trim() || null,
    };
    try {
      if (gasto.id) await api.actualizarGastoFijo(gasto.id, cuerpo);
      else await api.crearGastoFijo(cuerpo);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={gasto.id ? 'Editar gasto fijo' : 'Nuevo gasto fijo'} onClose={onClose}>
      {error && <div className="error">{error}</div>}

      <form onSubmit={guardar}>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Arriendo" required />
        </label>

        <label className="field">
          <span>Monto</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Déjalo vacío si cambia cada mes"
          />
          <em className="muted">
            La luz y el agua cambian todos los meses: déjalo vacío y la app estima con lo que pagaron antes.
          </em>
        </label>

        <div className="grid2">
          <label className="field">
            <span>Categoría</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Día de vencimiento</span>
            <input
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              inputMode="numeric"
              placeholder="5"
            />
          </label>
        </div>

        <label className="field">
          <span>Se reconoce cuando el movimiento dice</span>
          <input value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="enel" />
          <em className="muted">
            Necesario si tienes dos cuentas en la misma categoría —la luz y el agua—, para que un cargo no dé por
            pagadas las dos.
          </em>
        </label>

        <button className="primary" disabled={busy} style={{ width: '100%', marginTop: 10 }}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>

        {gasto.id && (
          <button
            type="button"
            className="danger ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => onDelete(gasto as GastoFijo)}
          >
            Quitar de los gastos fijos
          </button>
        )}
      </form>
    </Sheet>
  );
}

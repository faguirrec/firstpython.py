import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Category, type Plan, type RenglonPlan } from '../lib/api';
import { useSession } from '../lib/session';
import { dayLabel, money, monthLabel, shiftMonth } from '../lib/format';
import { avisar, avisarError } from '../lib/aviso';
import { datosCambiaron } from '../lib/datos';
import { FichaCategoria } from './Fichas';
import FilaDeslizable from './FilaDeslizable';
import Sheet from './Sheet';

/**
 * El plan del mes, adentro de Movimientos.
 *
 * Empezar un mes obligaba a anotar de nuevo el arriendo, la luz, el internet y
 * el supermercado uno por uno, aunque los mismos gastos estuvieran ahí el mes
 * anterior. Esto los trae de una: los gastos fijos declarados más lo que se
 * gastó el mes pasado en cada categoría, y desde ahí se edita.
 *
 * Lo que **no** hace, y es la mitad del diseño: no da nada por gastado. Un
 * renglón dice que se espera plata, no que salió. Mientras nadie pague, el saldo
 * de la cuenta no se mueve y el reparto no le cobra un peso a nadie. Lo que
 * convierte un renglón en hecho es un movimiento real que le calce —del correo,
 * de Apple Pay o de haberlo anotado acá—, nunca una marca que alguien tenga que
 * acordarse de poner.
 */
export default function PlanDelMes({ month }: { month: string }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const [plan, setPlan] = useState<Plan | null>(null);
  const [categorias, setCategorias] = useState<Category[]>([]);
  const [editando, setEditando] = useState<Partial<RenglonPlan> | null>(null);
  const [armando, setArmando] = useState(false);
  const [abierto, setAbierto] = useState(true);

  const cargar = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.plan(month), api.categories()]);
      setPlan(p);
      setCategorias(c.categories.filter((x) => !x.archived));
    } catch (err) {
      avisarError((err as Error).message);
    }
  }, [month]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const anterior = shiftMonth(month, -1);

  async function armar() {
    setArmando(true);
    try {
      const r = await api.armarPlan(month);
      setPlan(r.plan);
      avisar(
        r.creados > 0
          ? `Listo: ${r.creados} ${r.creados === 1 ? 'renglón' : 'renglones'} desde ${monthLabel(r.desde, true)}.`
          : 'No había nada nuevo que traer.',
      );
    } catch (err) {
      avisarError((err as Error).message);
    } finally {
      setArmando(false);
    }
  }

  async function anotar(r: RenglonPlan) {
    try {
      await api.anotarRenglon(r.id, {});
      // El movimiento nuevo cambia el mes entero: el saldo, el reparto y la
      // lista de abajo. Avisar es lo que hace que todo eso se vuelva a pedir.
      datosCambiaron();
      await cargar();
      avisar(`Anotado: ${r.name}.`);
    } catch (err) {
      avisarError((err as Error).message);
    }
  }

  async function borrar(r: RenglonPlan) {
    await api.borrarRenglon(r.id);
    await cargar();
  }

  if (!plan) return null;

  /*
   * Sin plan, sólo se ofrece armarlo de este mes en adelante.
   *
   * En un mes que ya pasó no hay nada que planear: lo que se gastó, se gastó.
   * Ofrecerlo ahí sería invitar a ensuciar el historial con expectativas
   * inventadas después de los hechos.
   */
  if (!plan.hayPlan) {
    if (month < new Date().toISOString().slice(0, 7)) return null;
    /*
     * El mes en curso ya puede llevar gasto encima.
     *
     * Sin plan, todo lo del mes cae en `fueraDelPlan`, así que eso mismo sirve
     * para saber si el mes está en blanco o ya empezado. Decirle "está en
     * blanco" a alguien parado el 28 con siete movimientos anotados haría que
     * dejara de leer la tarjeta, con razón.
     */
    const empezado = plan.fueraDelPlan > 0;
    return (
      <div className="card plan-vacio">
        <h2>{empezado ? `Ordenar ${monthLabel(month, true)}` : `Armar ${monthLabel(month, true)}`}</h2>
        <p className="muted">
          {empezado
            ? `Van ${money(plan.fueraDelPlan, currency)} gastados este mes, pero sin un plan no hay contra qué
               compararlos. Arma uno con tus gastos fijos y lo de ${monthLabel(anterior, true)} y vas a ver
               cuánto falta por salir.`
            : `Trae los gastos fijos que ya tienes declarados y lo que se gastó en ${monthLabel(anterior, true)},
               por categoría. Después lo editas: subes el arriendo, borras lo que no va, agregas lo del mes.`}
        </p>
        <p className="muted">
          <strong>No anota nada como gastado.</strong> Cada renglón se va marcando solo cuando la plata sale
          de verdad.
        </p>
        <button className="primary" onClick={() => void armar()} disabled={armando}>
          {armando ? 'Armando…' : `Traer lo de ${monthLabel(anterior, true)}`}
        </button>
      </div>
    );
  }

  const pendientes = plan.items.filter((i) => !i.cumplido);

  return (
    <>
      <div className="card plan-mes">
        <div className="card-head">
          <h2>Plan de {monthLabel(month, true)}</h2>
          <button className="small ghost" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
            {abierto ? 'Ocultar' : `Ver (${plan.items.length})`}
          </button>
        </div>

        {/*
          * Dos cifras y una barra, no tres cifras.
          *
          * Con el mes recién armado, "esperado" y "falta" son el mismo número y
          * mostrarlo dos veces hace dudar de si son cosas distintas. Además tres
          * montos de siete dígitos no caben en un teléfono: se atropellaban y el
          * tercero se salía de la tarjeta. Lo que falta va en la barra, que
          * encima dice de un vistazo por dónde va el mes.
          */}
        <div className="plan-cifras">
          <span className="plan-cifra">
            <span className="plan-cifra-rotulo">Esperado</span>
            <strong className="num">{money(plan.totalEsperado, currency)}</strong>
          </span>
          <span className="plan-cifra-linea" aria-hidden="true" />
          <span className="plan-cifra">
            <span className="plan-cifra-rotulo">Va gastado</span>
            <strong className="num">{money(plan.totalGastado, currency)}</strong>
          </span>
        </div>

        <div className="plan-avance">
          <div className="plan-barra plan-barra-total" aria-hidden="true">
            <span
              style={{
                width: `${plan.totalEsperado > 0 ? Math.min(100, (plan.totalGastado / plan.totalEsperado) * 100) : 0}%`,
              }}
            />
          </div>
          <span className="muted">
            {plan.totalPendiente > 0
              ? `Falta por salir ${money(plan.totalPendiente, currency)}`
              : 'Ya salió todo lo que estaba planeado'}
          </span>
        </div>

        {abierto && (
          <>
            <div className="list">
              {plan.items.map((r) => (
                <FilaDeslizable
                  key={r.id}
                  onClick={() => setEditando(r)}
                  acciones={
                    <>
                      <button className="fila-accion" onClick={() => setEditando(r)}>
                        <span aria-hidden="true">✎</span>
                        Editar
                      </button>
                      <button className="fila-accion borrar" onClick={() => void borrar(r)}>
                        <span aria-hidden="true">✕</span>
                        Quitar
                      </button>
                    </>
                  }
                >
                  <FichaCategoria
                    emoji={r.categoryEmoji ?? '📌'}
                    color={r.cumplido ? 'var(--good)' : r.categoryColor}
                  />
                  <div className="body">
                    <div className="title">{r.name}</div>
                    <div className="meta">{leyenda(r)}</div>
                    {/* Los acumulados llevan barra porque su pregunta no es
                        "¿ya?" sino "¿cuánto llevo?". Los puntuales no: una
                        barra de 0% o 100% no dice nada que la píldora no diga. */}
                    {r.modo === 'acumulado' && r.expected > 0 && (
                      <div className="plan-barra" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (r.gastado / r.expected) * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="amount">
                    {r.expected > 0 ? money(r.expected, currency) : '—'}
                    {r.modo === 'acumulado' && r.gastado > 0 && (
                      <span className="plan-llevado num">{money(r.gastado, currency)}</span>
                    )}
                  </div>
                </FilaDeslizable>
              ))}
            </div>

            {/* Anotar lo puntual que ya se pagó, sin tener que abrir el
                formulario de un movimiento nuevo y escribirlo todo de nuevo. */}
            {pendientes.some((r) => r.modo === 'puntual' && r.expected > 0) && (
              <div className="plan-anotar">
                <span className="muted">¿Ya se pagó alguno? Anótalo de un toque:</span>
                <div className="chips-fila">
                  {pendientes
                    .filter((r) => r.modo === 'puntual' && r.expected > 0)
                    .map((r) => (
                      <button key={r.id} className="filtro-chip" onClick={() => void anotar(r)}>
                        {r.name} · {money(r.expected, currency)}
                      </button>
                    ))}
                </div>
              </div>
            )}

            <div className="plan-pie">
              <button className="small" onClick={() => setEditando({ modo: 'puntual' })}>
                Agregar al plan
              </button>
              <button className="small ghost" onClick={() => void armar()} disabled={armando}>
                Traer lo de {monthLabel(anterior, true)}
              </button>
            </div>

            {plan.fueraDelPlan > 0 && (
              <p className="muted plan-fuera">
                Además se gastaron <strong className="num">{money(plan.fueraDelPlan, currency)}</strong> en cosas
                que no estaban en el plan. No es un error: es lo que pasó y no se había previsto.
              </p>
            )}
          </>
        )}
      </div>

      {editando && (
        <EditorRenglon
          renglon={editando}
          month={month}
          categorias={categorias}
          onClose={() => setEditando(null)}
          onSaved={async () => {
            setEditando(null);
            await cargar();
          }}
          onDelete={async (r) => {
            setEditando(null);
            await borrar(r);
          }}
        />
      )}
    </>
  );
}

/** La línea gris bajo el nombre: en qué va este renglón y de dónde salió. */
function leyenda(r: RenglonPlan): string {
  if (r.modo === 'acumulado') {
    if (r.movimientos === 0) return `Todavía sin gastos · ${deDonde(r)}`;
    const cuantos = `${r.movimientos} ${r.movimientos === 1 ? 'movimiento' : 'movimientos'}`;
    return r.cumplido ? `Ya pasó lo planeado · ${cuantos}` : `${cuantos} hasta ahora`;
  }
  if (r.cumplido && r.cumplidoCon) {
    // El comercio suele llamarse igual que el renglón —"Arriendo · Pagado ·
    // Arriendo"—, así que sólo se nombra cuando aporta algo distinto.
    const quien = r.cumplidoCon.merchant;
    const distinto = quien && quien.trim().toLowerCase() !== r.name.trim().toLowerCase();
    return `Pagado el ${dayLabel(r.cumplidoCon.occurredOn)}${distinto ? ` · ${quien}` : ''}`;
  }
  const cuando = r.dueDay ? `Vence el ${r.dueDay}` : 'Sin fecha';
  if (r.expectedFrom === 'promedio') return `${cuando} · estimado según meses anteriores`;
  if (r.expectedFrom === 'sin-datos') return `${cuando} · falta ponerle monto`;
  return `${cuando} · ${deDonde(r)}`;
}

function deDonde(r: RenglonPlan): string {
  if (r.origin === 'fijo') return 'de tus gastos fijos';
  if (r.origin === 'anterior') return 'del mes pasado';
  return 'agregado a mano';
}

function EditorRenglon({
  renglon,
  month,
  categorias,
  onClose,
  onSaved,
  onDelete,
}: {
  renglon: Partial<RenglonPlan>;
  month: string;
  categorias: Category[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: (r: RenglonPlan) => void;
}) {
  const [name, setName] = useState(renglon.name ?? '');
  // Vacío significa "no sé cuánto va a ser", que es distinto de cero.
  const [amount, setAmount] = useState(renglon.amount != null ? String(renglon.amount) : '');
  const [categoryId, setCategoryId] = useState(renglon.categoryId ?? '');
  const [dueDay, setDueDay] = useState(renglon.dueDay != null ? String(renglon.dueDay) : '');
  const [modo, setModo] = useState<'puntual' | 'acumulado'>(renglon.modo ?? 'puntual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esNuevo = !renglon.id;

  async function guardar(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Ponle un nombre');
      return;
    }
    const monto = amount.trim() ? Number(amount.replace(/[^\d.,-]/g, '').replace(',', '.')) : null;
    if (monto != null && (!Number.isFinite(monto) || monto <= 0)) {
      setError('El monto tiene que ser mayor que cero, o dejarlo vacío si todavía no se sabe');
      return;
    }
    const dia = dueDay.trim() ? Number(dueDay) : null;
    if (dia != null && (!Number.isInteger(dia) || dia < 1 || dia > 31)) {
      setError('El día tiene que estar entre 1 y 31');
      return;
    }

    setBusy(true);
    try {
      const datos = {
        name: name.trim(),
        amount: monto,
        categoryId: categoryId || null,
        dueDay: dia,
        modo,
      };
      if (esNuevo) await api.agregarAlPlan({ month, ...datos });
      else await api.actualizarRenglon(renglon.id!, datos);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={esNuevo ? `Agregar a ${monthLabel(month, true)}` : name || 'Renglón del plan'} onClose={onClose}>
      <form className="stack" onSubmit={guardar}>
        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Qué es</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Arriendo" maxLength={120} />
        </label>

        <label className="field">
          <span>Cuánto</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            placeholder="Déjalo vacío si todavía no se sabe"
          />
          <em className="muted">Vacío no es cero: la app lo estima con lo de meses anteriores.</em>
        </label>

        <label className="field">
          <span>Categoría</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sin categoría</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>
            ))}
          </select>
          <em className="muted">Es con lo que la app reconoce el gasto cuando ocurra.</em>
        </label>

        {/* La distinción que hace que la lista no mienta: el arriendo lo cumple
            un pago, el supermercado son muchos y hay que verlo llenarse. */}
        <fieldset className="field plan-modo">
          <legend>Cómo se paga</legend>
          <label>
            <input type="radio" checked={modo === 'puntual'} onChange={() => setModo('puntual')} />
            <span>
              <strong>De una vez</strong>
              <em className="muted">El arriendo, el internet, la patente. Un pago y queda listo.</em>
            </span>
          </label>
          <label>
            <input type="radio" checked={modo === 'acumulado'} onChange={() => setModo('acumulado')} />
            <span>
              <strong>De a poco</strong>
              <em className="muted">El supermercado, la bencina. Se va llenando con lo del mes.</em>
            </span>
          </label>
        </fieldset>

        {modo === 'puntual' && (
          <label className="field">
            <span>Día de vencimiento</span>
            <input
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              inputMode="numeric"
              placeholder="5"
              maxLength={2}
            />
          </label>
        )}

        <div className="hero-acciones">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
          {!esNuevo && (
            <button
              className="ghost danger"
              type="button"
              onClick={() => onDelete(renglon as RenglonPlan)}
            >
              Quitar del plan
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

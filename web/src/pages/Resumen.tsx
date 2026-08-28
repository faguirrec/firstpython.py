import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BudgetStatus,
  type EstadoFijos,
  type Projection,
  type ResumenPersonal,
  type Reserve,
  type Settlement,
  type Transaction,
} from '../lib/api';
import { useSession } from '../lib/session';
import { useModo } from '../lib/modo';
import { dayLabel, monthLabel, esMesFuturo, money, percent } from '../lib/format';
import { cambiarMes, useMes } from '../lib/mes';
import { useVersionDatos } from '../lib/datos';
import { CategoryBars, SplitBar, type CategorySlice } from '../components/Charts';
import Cabecera from '../components/Cabecera';
import NuevoMovimiento from '../components/NuevoMovimiento';
import { IconoAlerta, IconoBolsillo } from '../components/Icons';
import { Avatar, FichaCategoria } from '../components/Fichas';
import Cifra from '../components/Cifra';
import PrimerosPasos, { pasosPendientes } from '../components/PrimerosPasos';
import SaldoCuenta from '../components/SaldoCuenta';
import { TarjetaCargando, Vacio } from '../components/Estados';

export default function Resumen() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const month = useMes();
  const version = useVersionDatos();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [pending, setPending] = useState(0);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [personal, setPersonal] = useState<ResumenPersonal | null>(null);
  const [fijos, setFijos] = useState<EstadoFijos | null>(null);
  const [proyeccion, setProyeccion] = useState<Projection | null>(null);
  /** Cuántos buzones hay conectados, para saber si falta ese paso. */
  const [buzones, setBuzones] = useState<number | null>(null);
  /** Cuánto debería haber en la cuenta del hogar. */
  const [reserve, setReserve] = useState<Reserve | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modo = useModo();
  const esPersonal = modo === 'personal';
  const futuro = esMesFuturo(month);

  const load = useCallback(async () => {
    setError(null);
    try {
      // En un mes que todavía no empieza no hay nada gastado que mostrar: lo
      // que sirve es cuánto va a tener que poner cada uno.
      const [s, c, t, g, b, p, f, pr, rv] = await Promise.all([
        api.settlement(month),
        // Sin los fijos: el arriendo se lleva tres cuartos del gráfico todos
        // los meses y tapa lo único sobre lo que se puede decidir algo.
        api.byCategory(month, esPersonal ? 'personal' : 'comun', !esPersonal),
        api.transactions({ month, limit: 6, scope: esPersonal ? 'personal' : undefined }),
        api.gmailStatus().catch(() => ({ pendingReview: 0 })),
        api.budgets(month, modo),
        esPersonal ? api.resumenPersonal(month) : Promise.resolve(null),
        esPersonal ? Promise.resolve(null) : api.gastosFijos(month),
        futuro && !esPersonal ? api.projection(month) : Promise.resolve(null),
        // El saldo de la cuenta es del hogar; en el bolsillo propio no aplica.
        esPersonal ? Promise.resolve(null) : api.reserve(),
      ]);
      // Si el servidor no responde, el paso queda como pendiente y no como
      // hecho: es preferible ofrecer conectar algo ya conectado que dar por
      // resuelto lo que quizá no lo está.
      setBuzones(
        await Promise.all([api.imapStatus().catch(() => null), api.gmailStatus().catch(() => null)]).then(
          ([i, g]) => (i?.accounts.length ?? 0) + (g?.accounts.length ?? 0),
        ),
      );
      setSettlement(s);
      setCategories(c.categories);
      setRecent(t.transactions);
      setPending(g.pendingReview);
      setBudget(b);
      setPersonal(p);
      setFijos(f);
      setProyeccion(pr);
      setReserve(rv);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, modo, esPersonal, futuro, version]);

  useEffect(() => {
    void load();
  }, [load]);

  const me = settlement?.members.find((m) => m.userId === user?.id);

  return (
    <>
      <Cabecera
        hogar={household?.name ?? 'Mi hogar'}
        month={month}
        onMonthChange={cambiarMes}
      />

      {error && <div className="error">{error}</div>}

      {/* Sólo en el hogar: lo personal no necesita sueldos declarados ni gastos
          fijos, y el buzón es del hogar. */}
      {!esPersonal && <PrimerosPasos pasos={pasosPendientes(settlement, fijos, buzones ?? 0)} />}

      {!settlement && <TarjetaCargando conCifra filas={2} />}

      {/* En modo personal la pregunta es otra: no cuánto debo a la casa, sino
          cuánto me queda después de todo, con el aporte al hogar descontado
          como el gasto que es. */}
      {esPersonal ? (
        <div className="card principal">
          {personal ? (
            <>
              <div className="label">
                {personal.left >= 0 ? 'Te queda este mes' : 'Vas gastando de más'}
              </div>
              <Cifra
                className="hero"
                valor={Math.abs(personal.left)}
                moneda={currency}
                style={{ color: personal.left >= 0 ? 'var(--good-text)' : 'var(--critical)' }}
              />
              {personal.income > 0 ? (
                <div className="muted">
                  De {money(personal.income, currency)} de sueldo, {money(personal.contributedToHousehold, currency)}{' '}
                  fueron a la casa y {money(personal.personalExpenses, currency)} a lo tuyo.
                </div>
              ) : (
                <div className="muted">
                  Falta declarar tu sueldo del mes en <Link to="/liquidacion">Reparto</Link> para saber cuánto te queda.
                </div>
              )}

              <div className="list" style={{ marginTop: 14 }}>
                <div className="item">
                  <div className="body"><div className="title">Sueldo</div></div>
                  <div className="amount">{money(personal.income, currency)}</div>
                </div>
                <div className="item">
                  <div className="body">
                    <div className="title">A la casa</div>
                    <div className="meta">Aportes y gastos comunes que pagaste tú</div>
                  </div>
                  <div className="amount">−{money(personal.contributedToHousehold, currency)}</div>
                </div>
                <div className="item">
                  <div className="body"><div className="title">Tus gastos</div></div>
                  <div className="amount">−{money(personal.personalExpenses, currency)}</div>
                </div>
              </div>

              {personal.savingsRate != null && (
                <div className="muted" style={{ marginTop: 10 }}>
                  Estás guardando el {percent(personal.savingsRate)} de lo que ganas.
                </div>
              )}
            </>
          ) : (
            <TarjetaCargando conCifra filas={2} />
          )}
        </div>
      ) : (
      <div className="card principal">
        {futuro ? (
          <>
            <div className="label">
              {(proyeccion?.rows.find((r) => r.userId === user?.id)?.contributed ?? 0) > 0
                ? 'Te falta poner'
                : 'Te va a tocar poner'}
            </div>
            <Cifra
              className="hero"
              valor={proyeccion?.rows.find((r) => r.userId === user?.id)?.pending ?? 0}
              moneda={currency}
            />
            <div className="muted">
              {proyeccion
                ? `Estimado sobre ${money(proyeccion.target, currency)} para el hogar, según ${proyeccion.basedOn}.`
                : 'Este mes todavía no empieza. Carga los sueldos y los gastos fijos para verlo estimado.'}
            </div>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              Es una estimación, no una deuda: el mes no ha empezado. Sirve para saber cuánto apartar de un sueldo
              que ya llegó.
            </p>
          </>
        ) : me ? (
          <>
            {/* "Vas al día · $330.600" deja el número sin explicar: no es lo que
                debes ni lo que gastaste, es lo que pusiste de más. */}
            <div className="label">{me.deviation < -0.5 ? 'Te falta poner' : 'Pusiste de más'}</div>
            <Cifra
              className="hero"
              valor={Math.abs(me.deviation)}
              moneda={currency}
              style={{ color: me.deviation < -0.5 ? 'var(--critical)' : 'var(--good-text)' }}
            />
            <div className="muted">
              {me.deviation < -0.5
                ? `De los ${money(me.fairShare, currency)} que te tocan este mes, llevas ${money(me.contributed, currency)}.`
                : `Pusiste ${money(me.contributed, currency)} de los ${money(me.fairShare, currency)} que te tocaban.`}
            </div>
          </>
        ) : (
          <>
            <div className="label">Gastos comunes del mes</div>
            <Cifra className="hero" valor={settlement?.totalSharedExpenses ?? 0} moneda={currency} />
          </>
        )}

        {settlement && settlement.members.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 8 }}>Reparto según sueldo</div>
            <SplitBar
              parts={settlement.members.map((m, i) => ({
                name: m.name,
                share: m.incomeShare,
                color: i === 0 ? 'var(--series-1)' : 'var(--series-2)',
              }))}
            />
            <div className="muted" style={{ marginTop: 2 }}>
              {futuro
                ? proyeccion
                  ? `Sobre ${money(proyeccion.target, currency)} estimados para el mes.`
                  : 'La proporción sale de los sueldos declarados.'
                : `Sobre ${money(settlement.totalSharedExpenses, currency)} en gastos comunes del mes.`}
            </div>
          </div>
        )}

        {settlement && settlement.totalPersonalExpenses > 0 && (
          <div className="muted" style={{ marginTop: 10 }}>
            Aparte, {money(settlement.totalPersonalExpenses, currency)} tuyos en gastos personales, que no se
            reparten.
          </div>
        )}
      </div>
      )}

      {/* Lo que falta por pagar del mes. Va arriba porque es lo único de esta
          pantalla sobre lo que se puede actuar hoy mismo. */}
      {!esPersonal && fijos && fijos.pendientes.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Falta por pagar</h2>
            <Link to="/reportes?vista=fijos" className="muted">Gastos fijos →</Link>
          </div>
          <div className="list">
            {fijos.pendientes.map((g) => (
              <div className="item" key={g.id}>
                <FichaCategoria emoji={g.categoryEmoji ?? '📌'} color="var(--text-muted)" size={32} />
                <div className="body">
                  <div className="title">{g.name}</div>
                  <div className="meta">
                    {g.dueDay ? `Vence el ${g.dueDay}` : 'Sin fecha'}
                    {g.expectedFrom === 'promedio' && ' · estimado'}
                  </div>
                </div>
                <div className="amount">{g.expected > 0 ? money(g.expected, currency) : '—'}</div>
              </div>
            ))}
          </div>
          {fijos.totalPending > 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              Suman {money(fijos.totalPending, currency)}. Ya pagaron {money(fijos.totalPaid, currency)} de los
              fijos del mes.
            </p>
          )}
        </div>
      )}

      {pending > 0 && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warning) 55%, transparent)' }}>
          <div className="row">
            <span style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{ color: 'var(--warning)', flex: 'none' }}><IconoAlerta size={20} /></span>
              <span>
                <strong>{pending} movimiento{pending === 1 ? '' : 's'} por revisar</strong>
                <div className="muted">Importados desde Gmail. Conviene confirmar categoría y si son comunes.</div>
              </span>
            </span>
            <Link to="/movimientos?pendientes=1"><button className="small">Revisar</button></Link>
          </div>
        </div>
      )}

      {!esPersonal && reserve && (
        <SaldoCuenta
          reserve={reserve}
          settlement={settlement}
          month={month}
          currency={currency}
          cuenta={household?.officialAccount ?? 'la cuenta del hogar'}
          compacto
        />
      )}

      {/* Cómo va cada uno es del hogar: en el bolsillo propio no viene al caso,
          y mostrar lo del otro acá sería justo lo que se acaba de separar. */}
      {/* En un mes que no ha empezado nadie va atrasado ni adelantado: la tarjeta
          diría "al día $0" para los dos, que no es información. */}
      {settlement && !esPersonal && !futuro && settlement.members.some((m) => m.userId !== user?.id) && (
        <div className="card">
          <div className="card-head">
            <h2>Cómo va {settlement.members.find((m) => m.userId !== user?.id)?.name ?? 'el resto'}</h2>
            <Link to="/liquidacion" className="muted">Ver detalle →</Link>
          </div>

          <div className="fichas-persona">
            {/* Sin tu propia fila: el encabezado de arriba ya dice cómo vas tú,
                y repetirlo a media pantalla de distancia sólo alarga la vista. */}
            {settlement.members.map((m, i) => ({ m, i })).filter(({ m }) => m.userId !== user?.id).map(({ m, i }) => {
              const debe = m.deviation < -0.5;
              return (
                /* La misma ficha que en Reparto: el saldo arriba a la derecha
                   y los dos datos que lo explican abajo, en columnas. Antes el
                   detalle se partía en tres líneas al lado de una pastilla y la
                   fila quedaba descuadrada. */
                <div className="ficha-persona" key={m.userId}>
                  <div className="ficha-persona-cabeza">
                    <span className="quien">
                      <Avatar nombre={m.name} indice={i} size={26} />
                      <span>
                        <strong>{m.name}</strong>
                        <span className="muted"> · {percent(m.incomeShare)}</span>
                      </span>
                    </span>
                    <span className={`pill ${debe ? 'alert' : 'good'}`}>
                      {debe ? '▼ debe' : '▲ al día'} {money(Math.abs(m.deviation), currency)}
                    </span>
                  </div>
                  <div className="ficha-persona-datos">
                    <span>
                      <span className="label">Le toca</span>
                      <span className="num">{money(m.fairShare, currency)}</span>
                    </span>
                    <span>
                      <span className="label">Lleva puesto</span>
                      <span className="num">{money(m.contributed, currency)}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {settlement.transfer == null && settlement.members.length > 1 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
              {settlement.note}
            </p>
          )}
        </div>
      )}

      {budget && budget.totalBudget > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Presupuesto</h2>
            <Link to="/reportes" className="muted">Ver detalle →</Link>
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="num">
              {money(budget.budgetedSpent, currency)}
              <span className="muted"> de {money(budget.totalBudget, currency)}</span>
            </span>
            {budget.overBudget.length > 0 ? (
              <span className="pill alert">
                ✕ {budget.overBudget.length} categoría{budget.overBudget.length === 1 ? '' : 's'} excedida
                {budget.overBudget.length === 1 ? '' : 's'}
              </span>
            ) : budget.nearLimit.length > 0 ? (
              <span className="pill warn">▲ {budget.nearLimit.length} cerca del tope</span>
            ) : (
              <span className="pill good">✓ en rango</span>
            )}
          </div>
          <div style={{ height: 10, background: 'var(--grid)', borderRadius: 5 }}>
            <div
              style={{
                width: `${Math.min(budget.budgetedSpent / budget.totalBudget, 1) * 100}%`,
                height: '100%',
                borderRadius: 5,
                background:
                  budget.budgetedSpent > budget.totalBudget
                    ? 'var(--critical)'
                    : budget.budgetedSpent / budget.totalBudget >= 0.8
                      ? 'var(--warning)'
                      : 'var(--good)',
              }}
            />
          </div>
          {budget.overBudget.length > 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              Excedidas: {budget.overBudget.map((c) => c.category).join(', ')}.
            </p>
          )}
        </div>
      )}

      {categories.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>{esPersonal ? 'En qué se fue' : 'En qué se fue, sin los fijos'}</h2>
            <Link to="/reportes" className="muted">Análisis →</Link>
          </div>
          {!esPersonal && fijos && fijos.totalPaid > 0 && (
            <p className="muted" style={{ marginTop: 0 }}>
              Los fijos suman {money(fijos.totalPaid, currency)} aparte. Se dejan fuera porque son los mismos todos
              los meses y tapaban el resto.
            </p>
          )}
          <CategoryBars data={categories} currency={currency} limit={6} />
        </div>
      )}

      {/* Plegado a propósito: la lista completa está a un toque en su propia
          pestaña, y desplegada empujaba fuera de pantalla todo lo que sí se
          responde acá. Se abre sola cuando no hay nada más que mostrar. */}
      <details className="card plegable" open={recent.length === 0}>
        <summary>
          <strong>Últimos movimientos</strong>
          <span className="muted">
            {recent.length > 0
              ? `Los ${recent.length} más recientes · ver todos en Movimientos`
              : 'Todavía no hay ninguno'}
          </span>
        </summary>
        {recent.length === 0 && (
          <Vacio
            icono={<IconoBolsillo size={26} />}
            titulo="Todavía no hay movimientos"
            detalle="Anota el primer gasto común del mes, o conecta el correo del banco para que entren solos."
            accion={
              <button className="primary" onClick={() => setAdding(true)}>
                Anotar un gasto
              </button>
            }
          />
        )}

        <div className="list">
          {recent.map((t) => (
            <div className="item" key={t.id}>
              <FichaCategoria emoji={t.categoryEmoji} color={t.categoryColor} />
              <div className="body">
                <div className="title">{t.merchant ?? t.description ?? 'Movimiento'}</div>
                <div className="meta">
                  {dayLabel(t.occurredOn)}
                  {/* Se marca sólo cuando no coincide: si la fecha y el mes al
                      que cuenta son el mismo, decirlo sería ruido. */}
                  {t.period !== t.occurredOn.slice(0, 7) && ` · cuenta en ${monthLabel(t.period, true)}`}
                  {' · '}{t.categoryName ?? 'Sin categoría'}
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
      </details>

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

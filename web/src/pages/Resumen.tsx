import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BudgetStatus,
  type EstadoFijos,
  type ResumenPersonal,
  type Settlement,
  type Transaction,
} from '../lib/api';
import { useSession } from '../lib/session';
import { useModo } from '../lib/modo';
import { currentMonth, dayLabel, money, percent } from '../lib/format';
import { CategoryBars, SplitBar, type CategorySlice } from '../components/Charts';
import Cabecera from '../components/Cabecera';
import NuevoMovimiento from '../components/NuevoMovimiento';
import { IconoAlerta, IconoBolsillo, IconoMas } from '../components/Icons';
import { Avatar, FichaCategoria } from '../components/Fichas';
import { TarjetaCargando, Vacio } from '../components/Estados';

export default function Resumen() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [month, setMonth] = useState(currentMonth());
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [pending, setPending] = useState(0);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [personal, setPersonal] = useState<ResumenPersonal | null>(null);
  const [fijos, setFijos] = useState<EstadoFijos | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modo = useModo();
  const esPersonal = modo === 'personal';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, c, t, g, b, p, f] = await Promise.all([
        api.settlement(month),
        api.byCategory(month, esPersonal ? 'personal' : 'comun'),
        api.transactions({ month, limit: 6, scope: esPersonal ? 'personal' : undefined }),
        api.gmailStatus().catch(() => ({ pendingReview: 0 })),
        api.budgets(month, modo),
        esPersonal ? api.resumenPersonal(month) : Promise.resolve(null),
        esPersonal ? Promise.resolve(null) : api.gastosFijos(month),
      ]);
      setSettlement(s);
      setCategories(c.categories);
      setRecent(t.transactions);
      setPending(g.pendingReview);
      setBudget(b);
      setPersonal(p);
      setFijos(f);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, modo, esPersonal]);

  useEffect(() => {
    void load();
  }, [load]);

  const me = settlement?.members.find((m) => m.userId === user?.id);

  return (
    <>
      <Cabecera
        hogar={household?.name ?? 'Mi hogar'}
        month={month}
        onMonthChange={setMonth}
        accion={
          <button
            className="primary small"
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}
          >
            <IconoMas size={16} /> Movimiento
          </button>
        }
      />

      {error && <div className="error">{error}</div>}

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
              <div
                className="hero"
                style={{ color: personal.left >= 0 ? 'var(--good-text)' : 'var(--critical)' }}
              >
                {money(Math.abs(personal.left), currency)}
              </div>
              {personal.income > 0 ? (
                <div className="muted">
                  De {money(personal.income, currency)} de sueldo, {money(personal.contributedToHousehold, currency)}{' '}
                  fueron a la casa y {money(personal.personalExpenses, currency)} a lo tuyo.
                </div>
              ) : (
                <div className="muted">
                  Falta declarar tu sueldo del mes en <Link to="/reparto">Reparto</Link> para saber cuánto te queda.
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
        {me ? (
          <>
            <div className="label">{me.deviation < -0.5 ? 'Te falta poner' : 'Vas al día'}</div>
            <div
              className="hero"
              style={{ color: me.deviation < -0.5 ? 'var(--critical)' : 'var(--good-text)' }}
            >
              {money(Math.abs(me.deviation), currency)}
            </div>
            <div className="muted">
              {me.deviation < -0.5
                ? `De los ${money(me.fairShare, currency)} que te tocan este mes, llevas ${money(me.contributed, currency)}.`
                : `Pusiste ${money(me.contributed, currency)} de los ${money(me.fairShare, currency)} que te tocaban.`}
            </div>
          </>
        ) : (
          <>
            <div className="label">Gastos comunes del mes</div>
            <div className="hero">{money(settlement?.totalSharedExpenses ?? 0, currency)}</div>
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
              Sobre {money(settlement.totalSharedExpenses, currency)} en gastos comunes del mes.
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
            <Link to="/ajustes/fijos" className="muted">Gastos fijos →</Link>
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

      {/* Cómo va cada uno es del hogar: en el bolsillo propio no viene al caso,
          y mostrar lo del otro acá sería justo lo que se acaba de separar. */}
      {settlement && !esPersonal && (
        <div className="card">
          <div className="card-head">
            <h2>Cómo va cada uno</h2>
            <Link to="/liquidacion" className="muted">Ver detalle →</Link>
          </div>

          <div className="list">
            {settlement.members.map((m, i) => {
              const debe = m.deviation < -0.5;
              return (
                <div className="item" key={m.userId}>
                  <Avatar nombre={m.name} indice={i} />
                  <div className="body">
                    <div className="title">
                      {m.name} {m.userId === user?.id && <span className="muted">· tú</span>}
                    </div>
                    <div className="meta">
                      Le toca {money(m.fairShare, currency)} ({percent(m.incomeShare)}) · lleva puesto{' '}
                      {money(m.contributed, currency)}
                    </div>
                  </div>
                  <span className={`pill ${debe ? 'alert' : 'good'}`}>
                    {debe ? '▼ debe' : '▲ al día'} {money(Math.abs(m.deviation), currency)}
                  </span>
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
            <h2>En qué se fue</h2>
            <Link to="/reportes" className="muted">Análisis →</Link>
          </div>
          <CategoryBars data={categories} currency={currency} limit={6} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Últimos movimientos</h2>
          <Link to="/movimientos" className="muted">Ver todos →</Link>
        </div>
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
                  {dayLabel(t.occurredOn)} · {t.categoryName ?? 'Sin categoría'}
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
      </div>

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

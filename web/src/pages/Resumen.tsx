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
import { MODO_PERSONAL_VISIBLE, useModo } from '../lib/modo';
import { dayLabel, monthLabel, esMesCerrado, esMesFuturo, money, percent } from '../lib/format';
import { cambiarMes, useMes } from '../lib/mes';
import { useDeslizarMes } from '../lib/deslizar';
import { useVersionDatos } from '../lib/datos';
import { verCategoria } from '../lib/verCategoria';
import { CategoryBars, SplitBar, type CategorySlice } from '../components/Charts';
import BloqueDelMes from '../components/BloqueDelMes';
import NuevoMovimiento from '../components/NuevoMovimiento';
import { IconoAlerta, IconoBolsillo } from '../components/Icons';
import { Avatar, FichaCategoria } from '../components/Fichas';
import Cifra from '../components/Cifra';
import PrimerosPasos, { pasosPendientes } from '../components/PrimerosPasos';
import SaldoCuenta from '../components/SaldoCuenta';
import PorArreglar from '../components/PorArreglar';
import CitaDelMes from '../components/CitaDelMes';
import { TarjetaCargando, Vacio } from '../components/Estados';

export default function Resumen() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const month = useMes();
  const version = useVersionDatos();
  // Deslizar de lado cambia de mes, para no obligar a estirar el pulgar
  // hasta las flechas de la cabecera.
  useDeslizarMes(month);
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
  /*
   * Los últimos meses de gasto común, para la línea de fondo del bloque.
   *
   * Se pide aparte y sin bloquear: es decoración informativa, así que si la
   * respuesta se demora o falla, el bloque se dibuja igual sin la silueta. Lo
   * que no puede pasar es que la cifra del mes espere por un gráfico.
   */
  const [tendencia, setTendencia] = useState<number[] | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  /*
   * Lo que se va a anotar al tocar el botón del encabezado, ya con el monto.
   *
   * El encabezado dice "Para quedar a mano — $3.181" y hasta acá no había forma
   * de hacerlo desde esta pantalla: había que ir a Reparto y bajar tres
   * pantallas. Decir qué hacer y no dejar hacerlo es la razón número uno por la
   * que se abandonan las apps de presupuesto.
   */
  const [saldando, setSaldando] = useState<number | null>(null);
  /** La lectura del mes que terminó, antes de cerrarlo. */
  const [leyendoElMes, setLeyendoElMes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modo = useModo();
  /*
   * Con el modo personal escondido esto es siempre falso, porque `useModo`
   * devuelve siempre 'hogar'. Toda la vista del bolsillo propio que cuelga de
   * acá —el encabezado de "te queda este mes", las llamadas a la API que sólo
   * sirven para eso— queda dormida sin borrarse, y vuelve sola el día que se
   * prenda `MODO_PERSONAL_VISIBLE`. Por eso las condiciones se dejaron tal
   * cual en vez de reemplazarlas por el caso hogar: el diff de volver atrás
   * tiene que ser una línea, no esta pantalla entera.
   */
  const esPersonal = modo === 'personal';
  const futuro = esMesFuturo(month);
  /**
   * Sólo un mes ya cerrado con plata faltante se pinta en rojo. Durante el
   * mes en curso lo que falta es lo que queda por hacer, y eso va en el color
   * del texto normal: el rojo se guarda para cuando algo salió mal de verdad.
   */
  const cerrado = esMesCerrado(month);

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

  useEffect(() => {
    void api
      .monthlyReport(6)
      .then((r) => setTendencia(r.months.map((m) => m.shared)))
      .catch(() => setTendencia(undefined));
  }, [version]);

  const me = settlement?.members.find((m) => m.userId === user?.id);

  /*
   * Un hogar sin nada: ni un gasto común ni un sueldo declarado.
   *
   * No alcanza con mirar los gastos —alguien puede haber cargado los sueldos y
   * todavía no gastar, y ahí el reparto sí tiene algo que decir—, ni sólo los
   * sueldos. Es la conjunción la que significa "acá todavía no pasó nada".
   */
  const sinDatos = Boolean(
    settlement &&
      settlement.totalSharedExpenses === 0 &&
      settlement.members.every((m) => m.income === 0) &&
      settlement.members.every((m) => m.contributed === 0),
  );

  /*
   * Lo que dice el bloque de arriba, resuelto antes de dibujarlo.
   *
   * Son cuatro situaciones distintas —un mes que no empezó, un hogar en cero,
   * el mes corriendo, y el caso raro de no encontrarse a uno mismo en el
   * reparto— y cada una cambia las cuatro cosas a la vez: la etiqueta, la
   * cifra, la frase de apoyo y los botones. Decidirlas juntas acá, en vez de
   * anidar cuatro ternarios dentro del JSX, es lo que permite leer de un
   * vistazo qué dice la app en cada caso.
   */
  const proyeccionMia = proyeccion?.rows.find((r) => r.userId === user?.id);
  const bloque = futuro
    ? {
        etiqueta: (proyeccionMia?.contributed ?? 0) > 0 ? 'Para quedar a mano' : 'Te va a tocar poner',
        cifra: <Cifra valor={proyeccionMia?.pending ?? 0} moneda={currency} />,
        apoyo: proyeccion
          ? `Estimado sobre ${money(proyeccion.target, currency)} para el hogar, según ${proyeccion.basedOn}. Es una estimación, no una deuda: el mes no ha empezado.`
          : 'Este mes todavía no empieza. Carga los sueldos y los gastos fijos para verlo estimado.',
        acciones: null as React.ReactNode,
      }
    : sinDatos
      ? {
          /*
           * El primer día.
           *
           * Con la base vacía la fórmula da cero y el encabezado anunciaba
           * "PUSISTE DE MÁS — $0", una felicitación por no haber hecho nada.
           */
          etiqueta: 'Todavía no hay nada que repartir',
          cifra: (
            <span className="sin-cifra">
              Cuando anoten el primer gasto común, acá va a decir cuánto le toca poner a cada uno.
            </span>
          ),
          apoyo: null,
          acciones: (
            <>
              <button className="primary" onClick={() => setAdding(true)}>Anotar un gasto</button>
              <Link to="/liquidacion"><button className="ghost">Cargar los sueldos</button></Link>
            </>
          ),
        }
      : me
        ? {
            /*
             * "Para quedar a mano" en vez de "te falta poner".
             *
             * Es la misma cifra, pero "falta" es una falta. La razón número uno
             * por la que se abandona una app de presupuesto no es que sea fea:
             * es que da vergüenza abrirla, y a la culpa se responde evitando.
             * Una tarea con final —quedar a mano— no da vergüenza.
             */
            etiqueta: me.deviation < -0.5 ? 'Para quedar a mano' : 'Pusiste de más',
            cifra: <Cifra valor={Math.abs(me.deviation)} moneda={currency} />,
            apoyo:
              me.deviation < -0.5
                ? `De los ${money(me.fairShare, currency)} que te tocan este mes, llevas ${money(me.contributed, currency)}.`
                : `Pusiste ${money(me.contributed, currency)} de los ${money(me.fairShare, currency)} que te tocaban.`,
            /* El botón que hace lo que el número acaba de pedir, con el monto
               puesto. Un toque en vez de tres pantallas. */
            acciones:
              me.deviation < -0.5 ? (
                <>
                  <button className="primary" onClick={() => setSaldando(Math.round(Math.abs(me.deviation)))}>
                    Anotar {money(Math.abs(me.deviation), currency)}
                  </button>
                  <Link to="/liquidacion"><button className="ghost">Ver el reparto</button></Link>
                </>
              ) : null,
          }
        : {
            etiqueta: 'Gastos comunes del mes',
            cifra: <Cifra valor={settlement?.totalSharedExpenses ?? 0} moneda={currency} />,
            apoyo: null,
            acciones: null as React.ReactNode,
          };

  return (
    <>
      <BloqueDelMes
        hogar={household?.name ?? 'Mi hogar'}
        month={month}
        onMonthChange={cambiarMes}
        etiqueta={bloque.etiqueta}
        cifra={bloque.cifra}
        apoyo={bloque.apoyo}
        tendencia={tendencia}
        acciones={bloque.acciones}
      />

      {error && <div className="error">{error}</div>}

      {!settlement && <TarjetaCargando conCifra filas={2} />}

      {/*
        * El reparto, ahora en su propia tarjeta.
        *
        * Antes vivía al pie de la tarjeta de la cifra. Con la cifra arriba en el
        * bloque de marca, esto es otra cosa: la explicación de por qué a cada
        * uno le toca lo que le toca. Se gana su tarjeta.
        *
        * Sin sueldos ni gastos no aparece: la barra diría "100%" sobre cero, que
        * es una precisión sobre nada.
        */}
      {settlement && settlement.members.length > 0 && !sinDatos && (
        <div className="card">
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

          {/* Esta línea se queda aunque el modo personal esté escondido: es la
              única que da cuenta de la plata que se gastó y no entró al reparto.
              Sacarla haría que un gasto anotado ayer no apareciera en ninguna
              parte, que es exactamente lo que no puede pasar. Lo que se dejó de
              nombrar es el modo; el hecho se sigue diciendo. */}
          {settlement.totalPersonalExpenses > 0 && (
            <div className="muted" style={{ marginTop: 10 }}>
              Aparte, {money(settlement.totalPersonalExpenses, currency)} tuyos en gastos que no se reparten.
            </div>
          )}
        </div>
      )}

      {/*
        * La invitación a leer el mes, cuando el mes ya terminó.
        *
        * Vive también al pie de Reparto, pero ahí queda a más de dos mil
        * píxeles del borde: nadie baja hasta el fondo de la pantalla más larga
        * para descubrir que existe. Acá aparece sola, en el momento en que
        * tiene sentido —el mes cerró y todavía no lo cerraron ustedes— y
        * desaparece apenas se cierra.
        */}
      {!esPersonal && cerrado && settlement && !settlement.settledAt && (
        <button className="card leer-el-mes" onClick={() => setLeyendoElMes(true)}>
          <span className="leer-el-mes-texto">
            <strong>{monthLabel(month)} terminó</strong>
            <span className="meta">Léanlo juntos antes de cerrarlo: qué costó, qué cambió y qué viene</span>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      )}

      {/* Lo que hay que ordenar para que el desglose de más abajo diga la
          verdad. En lo personal no aplica: lo que uno gasta por su cuenta no
          entra en ningún gráfico común. */}
      {!esPersonal && <PorArreglar month={month} />}

      {/* Los primeros pasos, debajo de la respuesta y plegados.
          Sólo en el hogar: lo personal no necesita sueldos declarados ni gastos
          fijos, y el buzón es del hogar. */}
      {!esPersonal && <PrimerosPasos pasos={pasosPendientes(settlement, fijos, buzones ?? 0)} />}

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
            {/* Una tarjeta titulada con el nombre del otro es un marcador.
                 Aunque el dato sea neutro, el encuadre dice "vengo a revisar
                 cómo va el otro" — y en apps de pareja, la que se convierte en
                 la herramienta para probar quién tiene la razón se abandona. */}
            <h2>El mes de los dos</h2>
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
                    <span className={`pill ${debe ? (cerrado ? 'alert' : 'pendiente') : 'good'}`}>
                      {/* "Debe" juzga a la persona; "falta" describe la plata.
                           Corto a propósito: la píldora se llevaba media pantalla
                           y el nombre de al lado quedaba partido en dos líneas.
                           Lo que falta y lo que lleva puesto va acá abajo. */}
                      {debe ? `Falta ${money(Math.abs(m.deviation), currency)}` : 'Al día'}
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
          {/* El enlace arrastra el mismo recorte que arma el gráfico —arriba,
              en `api.byCategory`—, para que la lista sume lo mismo que la
              barra que se tocó. */}
          <CategoryBars
            data={categories}
            currency={currency}
            limit={6}
            enlace={(row) =>
              row.categoryId === undefined
                ? null
                : verCategoria({
                    categoryId: row.categoryId,
                    month,
                    scope: esPersonal ? 'personal' : 'comun',
                    sinFijos: !esPersonal,
                  })
            }
          />
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
                  {/* Igual que en Movimientos: lo que ya estaba anotado como
                      personal se sigue marcando para que la lista no parezca
                      sumar al reparto, pero sin nombrar un modo que no se ve. */}
                  {t.scope === 'personal' && (MODO_PERSONAL_VISIBLE ? ' · personal' : ' · no se reparte')}
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

      {leyendoElMes && (
        <CitaDelMes
          month={month}
          onClose={() => setLeyendoElMes(false)}
          onCerrar={async () => {
            setLeyendoElMes(false);
            await api.closeSettlement(month, false);
            await load();
          }}
        />
      )}

      {/* Anotar el aporte que deja el mes a mano, con el monto ya puesto: lo que
          hay que confirmar es la fecha y de dónde salió, no volver a calcular
          cuánto. */}
      {saldando != null && (
        <NuevoMovimiento
          month={month}
          inicial={{ type: 'aporte', userId: user?.id, amount: saldando }}
          onClose={() => setSaldando(null)}
          onSaved={() => {
            setSaldando(null);
            void load();
          }}
        />
      )}
    </>
  );
}

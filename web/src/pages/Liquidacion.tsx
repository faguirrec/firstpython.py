import { useCallback, useEffect, useState } from 'react';
import { api, type Member, type Projection, type RepartoExcedente, type Reserve, type Settlement } from '../lib/api';
import { useSession } from '../lib/session';
import { money, monthLabel, percent } from '../lib/format';
import { cambiarMes, useMes } from '../lib/mes';
import { useVersionDatos } from '../lib/datos';
import Cabecera from '../components/Cabecera';
import { SplitBar } from '../components/Charts';
import { Avatar } from '../components/Fichas';
import Metas from '../components/Metas';
import NuevoMovimiento from '../components/NuevoMovimiento';
import { IconoOculto, IconoVer } from '../components/Icons';
import { alternarPrivacidad, usePrivacidad } from '../lib/privacidad';

export default function Liquidacion() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const month = useMes();
  const version = useVersionDatos();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [incomes, setIncomes] = useState<Record<string, string>>({});
  const [projection, setProjection] = useState<Projection | null>(null);
  const [reserve, setReserve] = useState<Reserve | null>(null);
  const [budget, setBudget] = useState('');
  /** Quiénes tienen sueldo declarado para *este* mes y no heredado. */
  const [propios, setPropios] = useState<Set<string>>(new Set());
  const [aporteDe, setAporteDe] = useState<{ userId: string; amount: number } | null>(null);
  /** Qué hacer con lo que sobró, y cuánto de eso decide guardar el hogar. */
  const [excedente, setExcedente] = useState<RepartoExcedente | null>(null);
  const [alAhorro, setAlAhorro] = useState('');
  const privado = usePrivacidad();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, h, i, p, r, e] = await Promise.all([
        api.settlement(month),
        api.household(),
        api.incomes(),
        api.projection(month),
        api.reserve(),
        api.excedenteDelMes(month),
      ]);
      setSettlement(s);
      setMembers(h.members);
      setProjection(p);
      setReserve(r);
      setExcedente(e);
      // La propuesta del hogar, editable antes de confirmar.
      setAlAhorro(String(Math.round(e.sugeridoAlAhorro)));
      /*
       * Las casillas parten con el sueldo que el cálculo está usando de verdad,
       * que puede venir arrastrado de un mes anterior. Antes sólo se llenaban
       * con el registro exacto del mes, así que al abrir un mes nuevo aparecían
       * vacías y parecía que hubiera que cargarlo otra vez —cuando el reparto
       * ya estaba bien calculado—.
       */
      const map: Record<string, string> = {};
      for (const m of s.members) if (m.income > 0) map[m.userId] = String(Math.round(m.income));
      setIncomes(map);
      setPropios(new Set(i.incomes.filter((x) => x.month === month).map((x) => x.userId)));
      setBudget(p.savedTarget != null ? String(Math.round(p.savedTarget)) : '');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, version]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveIncome(userId: string, value: string) {
    const amount = Number(value.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) return;
    await api.saveIncome({ month, userId, amount });
    setMessage('Sueldo guardado. El reparto se recalculó.');
    await load();
  }

  /**
   * Guarda el total estimado y recalcula. Queda anotado para este mes y los
   * siguientes lo heredan: la idea es escribirlo una vez, no cada vez que se
   * abre la pantalla.
   */
  async function guardarEstimado() {
    const value = Number(budget.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return;
    await api.guardarGastoEstimado({ month, amount: value });
    setMessage(
      value > 0
        ? 'Total guardado. Los meses siguientes lo van a asumir hasta que lo cambies.'
        : 'Total borrado. Vuelve a estimarse con los gastos fijos.',
    );
    await load();
  }

  const transferFrom = settlement?.transfer ? members.find((m) => m.id === settlement.transfer!.fromUserId) : null;
  const transferTo = settlement?.transfer ? members.find((m) => m.id === settlement.transfer!.toUserId) : null;

  /* Si a alguien le falta el sueldo, la tarjeta se abre sola: es lo primero
     que hay que resolver y esconderlo sería esconder el trabajo pendiente. */
  const faltaAlgunSueldo =
    members.length < 2 || members.some((m) => !incomes[m.id] || Number(incomes[m.id]) <= 0);

  /* Lo que el hogar decide guardar, acotado a lo que de verdad sobró. */
  const ahorroElegido = Math.min(
    Math.max(Number(alAhorro.replace(/[^\d.-]/g, '')) || 0, 0),
    excedente?.excedente ?? 0,
  );

  /* ¿Hay algo que arrastrar? Con el mes cuadrado no tiene sentido ofrecerlo. */
  const hayDesbalance = Boolean(settlement?.members.some((m) => Math.abs(m.deviation) >= 1));

  /* Un desajuste chico frente a lo que gasta el hogar es redondeo, no déficit. */
  const enRojoDeVerdad =
    reserve != null &&
    reserve.balance < 0 &&
    // El 1% de lo que gasta el hogar en un mes típico, y nunca menos de mil
    // pesos. Antes se medía contra el gasto del mes que se está mirando, que en
    // uno recién abierto es cero: ahí cualquier saldo negativo pasaba a ser una
    // alarma, incluso el redondeo de meses anteriores.
    Math.abs(reserve.balance) > Math.max(reserve.monthlyAverage * 0.01, 1000);

  return (
    <>
      <Cabecera
        hogar="Reparto"
        month={month}
        onMonthChange={cambiarMes}
        accion={
          <button
            className="small ghost"
            onClick={alternarPrivacidad}
            aria-pressed={privado}
            title={privado ? 'Mostrar los sueldos' : 'Ocultar los sueldos'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}
          >
            {privado ? <IconoOculto size={17} /> : <IconoVer size={17} />}
            {privado ? 'Ocultos' : 'Ocultar'}
          </button>
        }
      />

      {error && <div className="error">{error}</div>}
      {message && <div className="ok">{message}</div>}

      {/*
        * Los sueldos se pliegan cuando ya están los dos.
        *
        * Es lo primero que hay que hacer una vez, y después casi nunca se toca:
        * dos campos grandes ocupando la primera pantalla todos los meses
        * empujaban hacia abajo lo que uno viene a mirar, que es cuánto
        * transferir. Si falta alguno, se abre solo.
        */}
      <details className="card plegable" open={faltaAlgunSueldo}>
        <summary>
          <strong>Sueldos de {monthLabel(month)}</strong>
          <span className="resumen-dato">
            {faltaAlgunSueldo
              ? ' · falta cargar alguno'
              : privado
                ? ' · ocultos'
                : ` · ${members.map((m) => money(Number(incomes[m.id] ?? 0), currency)).join(' y ')}`}
          </span>
        </summary>
        <p className="muted" style={{ marginTop: 0 }}>
          El sueldo líquido de cada uno. Si no lo cargas, se arrastra el del último mes declarado.
        </p>
        {members.map((m) => (
          <label className="field" key={m.id}>
            <span>{m.name}{m.id === user?.id && ' (tú)'}</span>
            {privado ? (
              // Enmascarado y no editable: escribir a ciegas en un campo que se
              // guarda al salir es una receta para cargar un sueldo equivocado.
              <div className="campo-oculto" aria-label={`Sueldo de ${m.name}, oculto`}>
                {'•'.repeat(7)}
              </div>
            ) : (
              <input
                inputMode="decimal"
                value={incomes[m.id] ?? ''}
                placeholder="1450000"
                onChange={(e) => setIncomes((prev) => ({ ...prev, [m.id]: e.target.value }))}
                onBlur={(e) => void saveIncome(m.id, e.target.value)}
              />
            )}
            {!privado && incomes[m.id] && !propios.has(m.id) && (
              <em className="muted">Viene del último mes declarado. Cámbialo sólo si este mes es distinto.</em>
            )}
          </label>
        ))}
        {privado && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Los sueldos están ocultos en este dispositivo. Toca «Ocultos» arriba para verlos y poder editarlos.
          </p>
        )}
        {members.length < 2 && (
          <p className="muted">Falta que la otra persona se una al hogar (Ajustes → Hogar → código de invitación).</p>
        )}

        {/* El porcentaje sale de los sueldos, así que vive con ellos: en su
            propia tarjeta parecía un dato aparte que hubiera que configurar. */}
        {settlement && settlement.members.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 8 }}>Porcentaje que le toca a cada uno</div>
          <SplitBar
            parts={settlement.members.map((m, i) => ({
              name: m.name,
              share: m.incomeShare,
              color: i === 0 ? 'var(--series-1)' : 'var(--series-2)',
            }))}
          />
            {settlement.totalIncome === 0 && (
              <p className="muted" style={{ marginTop: 8 }}>
                Sin sueldos cargados el reparto queda 50/50. Carga los sueldos arriba para que sea proporcional.
              </p>
            )}
          </div>
        )}
      </details>

      <div className="card">
        <h2>Cuánto transferir este mes</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Sobre un gasto estimado de {projection ? money(projection.target, currency) : '—'} —
          {projection?.basedOn ?? '—'}—, descontando lo que cada uno ya puso.
        </p>
        {/* El campo va en su propia línea y la etiqueta arriba: como marcador
            de posición, el texto se cortaba a la mitad —"Gasto estimado ($1.312."—
            y de paso desaparecía apenas se escribía el primer número. */}
        <label className="field">
          <span>Gasto estimado del mes</span>
          <input
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={projection ? money(projection.baseBudget, currency) : '—'}
          />
        </label>
        <button style={{ width: '100%', marginBottom: 16 }} onClick={() => void guardarEstimado()}>
          Guardar el estimado
        </button>

        {projection?.targetInherited && (
          <p className="muted" style={{ marginTop: 0 }}>
            Este total viene de un mes anterior. Si lo cambias, queda para este mes en adelante.
          </p>
        )}

        {projection && (
          <>
            {/*
              * Una ficha por persona, no una tabla.
              *
              * Cuatro columnas de plata no caben en un teléfono: los nombres se
              * partían en tres líneas y las cifras quedaban pegadas unas a
              * otras. Acá cada uno tiene su bloque, con lo que le falta —que es
              * lo que se viene a mirar— en grande y el resto de apoyo.
              */}
            <div className="fichas-persona">
              {projection.rows.map((row, i) => (
                <div className="ficha-persona" key={row.userId}>
                  <div className="ficha-persona-cabeza">
                    <span className="quien">
                      <Avatar nombre={row.name} indice={i} size={26} />
                      <span>
                        <strong>{row.name}</strong>
                        <span className="muted"> · {percent(row.share)}</span>
                      </span>
                    </span>
                    <span
                      className="cifra-sm"
                      style={{ color: row.pending > 0 ? 'var(--critical)' : 'var(--good-text)' }}
                    >
                      {row.pending > 0 ? money(row.pending, currency) : 'al día'}
                    </span>
                  </div>

                  <div className="ficha-persona-datos">
                    <span>
                      <span className="label">Le toca</span>
                      <span className="num">{money(row.amount, currency)}</span>
                    </span>
                    <span>
                      <span className="label">Puso</span>
                      <span className="num">{money(row.contributed, currency)}</span>
                    </span>
                  </div>

                  {/* El arrastre va en su propia línea y no sumado a "puso": lo
                      que puso es lo que transfirió, y mezclarlo haría imposible
                      cuadrar con la cartola. */}
                  {row.carriedOver !== 0 && (
                    <div className="arrastre">
                      {row.carriedOver < 0 ? 'Venía debiendo de' : 'Tenía a favor de'}{' '}
                      {monthLabel(row.carriedFrom ?? '', true)}
                      <strong className="num">
                        {row.carriedOver < 0 ? '−' : '+'}{money(Math.abs(row.carriedOver), currency)}
                      </strong>
                    </div>
                  )}

                  {row.pending > 0 && (
                    <button
                      className="small"
                      style={{ width: '100%' }}
                      onClick={() => setAporteDe({ userId: row.userId, amount: row.pending })}
                    >
                      Anotar el aporte de {row.name.split(' ')[0]}
                    </button>
                  )}
                </div>
              ))}

              <div className="ficha-persona total">
                <div className="ficha-persona-cabeza">
                  <strong>Entre los dos</strong>
                  <span className="cifra-sm">
                    {money(projection.rows.reduce((a, r) => a + r.pending, 0), currency)}
                  </span>
                </div>
                <div className="ficha-persona-datos">
                  <span>
                    <span className="label">Objetivo</span>
                    <span className="num">{money(projection.target, currency)}</span>
                  </span>
                  <span>
                    <span className="label">Puesto</span>
                    <span className="num">
                      {money(projection.rows.reduce((a, r) => a + r.contributed, 0), currency)}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
              Cada uno transfiere su monto a {household?.officialAccount ?? 'la cuenta del hogar'} y lo anota con
              el botón de al lado.
              {projection.contingencyPct > 0 ? (
                <>
                  {' '}Incluye un {projection.contingencyPct}% de contingencia que se acumula como reserva; se ajusta en
                  Ajustes → Hogar.
                </>
              ) : (
                <> Sin contingencia configurada: puedes activarla en Ajustes → Hogar.</>
              )}
            </p>
          </>
        )}
      </div>

      {reserve && (
        <div className="card">
          <div className="card-head">
            <h2>Fondo de reserva</h2>
            {reserve.monthsCovered > 0 && (
              <span className={`pill ${reserve.monthsCovered >= 1 ? 'good' : 'warn'}`}>
                {reserve.monthsCovered} {reserve.monthsCovered === 1 ? 'mes' : 'meses'} de gastos
              </span>
            )}
          </div>
          {/*
            * Rojo sólo cuando de verdad hay un problema.
            *
            * El saldo del fondo es la resta de dos cifras de siete dígitos, así
            * que quedar en −$423 sobre un millón y medio es que la cuenta
            * cuadra, no que el hogar esté en rojo. Pintarlo en rojo enorme y
            * escribir "se ha gastado más de lo aportado" convertía el redondeo
            * en una alarma —y una alarma que salta sin motivo enseña a
            * ignorarlas todas—. El umbral es el 1% del gasto del mes.
            */}
          <div
            className="hero num"
            style={{ color: enRojoDeVerdad ? 'var(--critical)' : undefined }}
          >
            {money(reserve.balance, currency)}
          </div>
          {/* Lo prometido a alguien no es reserva: decirlo evita que la cifra
              grande de arriba se lea como plata disponible cuando parte hay
              que devolverla. */}
          {reserve.committed > 0 && (
            <div className="arrastre" style={{ marginTop: 8 }}>
              Comprometido como crédito
              <strong className="num">−{money(reserve.committed, currency)}</strong>
            </div>
          )}
          {reserve.committed > 0 && (
            <div className="ficha-persona-datos" style={{ marginTop: 8 }}>
              <span>
                <span className="label">Libre para metas</span>
                <span className="num">{money(reserve.free, currency)}</span>
              </span>
              <span>
                <span className="label">Cubre</span>
                <span className="num">{reserve.monthsCovered} meses</span>
              </span>
            </div>
          )}

          <p className="muted" style={{ marginTop: 8 }}>
            {enRojoDeVerdad
              ? 'La cuenta del hogar está en rojo: se ha gastado más de lo aportado.'
              : reserve.balance < 0
                ? `${household?.officialAccount ?? 'La cuenta del hogar'} está prácticamente a cero: lo aportado y lo gastado se emparejan.`
                : `Acumulado en ${household?.officialAccount ?? 'la cuenta del hogar'} sobre los gastos pagados.`}
          </p>
          {/* Mes a mes, en filas: el saldo a la derecha y el detalle debajo.
              Cuatro columnas de plata en 390px dejaban las cifras pegadas. */}
          <details className="plegable" style={{ marginTop: 12 }}>
            <summary>
              <strong>Mes a mes</strong>
              <span className="resumen-dato"> · últimos {Math.min(6, reserve.history.length)}</span>
            </summary>
            <div className="list">
              {[...reserve.history].reverse().slice(0, 6).map((h) => (
                <div className="item" key={h.month}>
                  <div className="body">
                    <div className="title">{monthLabel(h.month)}</div>
                    <div className="meta">
                      Aportes {money(h.contributed, currency)} · gastos {money(h.spent, currency)}
                    </div>
                  </div>
                  {/* Rojo sólo si el mes se pasó de verdad: un desajuste de mil
                      pesos sobre un millón es redondeo, y pintarlo de rojo mes
                      tras mes enseña a no mirar el color. */}
                  <div
                    className="amount"
                    style={{
                      color:
                        h.balance < 0 && Math.abs(h.balance) > h.spent * 0.01
                          ? 'var(--critical)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {money(h.balance, currency)}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {aporteDe && (
        <NuevoMovimiento
          month={month}
          inicial={{ type: 'aporte', userId: aporteDe.userId, amount: aporteDe.amount }}
          onClose={() => setAporteDe(null)}
          onSaved={async () => {
            setAporteDe(null);
            setMessage('Aporte anotado.');
            await load();
          }}
        />
      )}

      <Metas />

      {settlement && (
        <div className="card">
          <div className="card-head">
            <h2>Liquidación de {monthLabel(month)}</h2>
            {settlement.settledAt && <span className="pill good">✓ cerrado</span>}
          </div>

          <div className="fichas-persona">
            {settlement.members.map((m, i) => (
              <div className="ficha-persona" key={m.userId}>
                <div className="ficha-persona-cabeza">
                  <span className="quien">
                    <Avatar nombre={m.name} indice={i} size={26} />
                    <span>
                      <strong>{m.name}</strong>
                      <span className="muted"> · {percent(m.incomeShare)}</span>
                    </span>
                  </span>
                  <span
                    className="cifra-sm"
                    style={{ color: m.deviation < -0.5 ? 'var(--critical)' : 'var(--good-text)' }}
                  >
                    {m.deviation >= 0 ? '+' : ''}{money(m.deviation, currency)}
                  </span>
                </div>

                <div className="ficha-persona-datos">
                  <span>
                    <span className="label">Le toca</span>
                    <span className="num">{money(m.fairShare, currency)}</span>
                  </span>
                  <span>
                    <span className="label">Puso</span>
                    <span className="num">{money(m.contributed, currency)}</span>
                    {m.paidOutOfPocket > 0 && (
                      <span className="muted">
                        {money(m.paidOutOfPocket, currency)} de su bolsillo
                      </span>
                    )}
                  </span>
                </div>

                {m.carriedOver !== 0 && (
                  <div className="arrastre">
                    {m.carriedOver < 0 ? 'Venía debiendo de' : 'Tenía a favor de'}{' '}
                    {monthLabel(m.carriedFrom ?? '', true)}
                    <strong className="num">
                      {m.carriedOver < 0 ? '−' : '+'}{money(Math.abs(m.carriedOver), currency)}
                    </strong>
                  </div>
                )}
              </div>
            ))}

            <div className="ficha-persona total">
              <div className="ficha-persona-cabeza">
                <strong>Gastos comunes</strong>
                <span className="cifra-sm">{money(settlement.totalSharedExpenses, currency)}</span>
              </div>
            </div>
          </div>

          <div
            className="card"
            style={{ marginTop: 14, marginBottom: 0, background: 'var(--plane)', boxShadow: 'none' }}
          >
            {settlement.transfer && transferFrom && transferTo ? (
              <>
                {/* Nombres y monto en líneas distintas: juntos se partían a
                    mitad de frase —"Ana → Bruno:" y abajo el número suelto—,
                    que se lee como un error de maquetación. */}
                <div className="label">Para quedar a mano</div>
                <div style={{ marginTop: 4 }}>
                  {transferFrom.name} le transfiere a {transferTo.name}
                </div>
                <div className="cifra-md num">{money(settlement.transfer.amount, currency)}</div>
              </>
            ) : (
              <div>{settlement.note}</div>
            )}
            {settlement.topUps.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {settlement.topUps.map((t) => {
                  const member = members.find((m) => m.id === t.userId);
                  return (
                    <li key={t.userId}>
                      {member?.name ?? 'Alguien'} debe completar {money(t.amount, currency)}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="muted" style={{ marginTop: 12, marginBottom: 8 }}>
            Saldo de la cuenta del hogar: {money(settlement.officialAccountBalance, currency)}
          </p>

          {settlement.settledAt ? (
            <button
              className="ghost small"
              onClick={async () => {
                await api.reopenSettlement(month);
                setMessage('Mes reabierto. Si habías pasado el saldo al mes siguiente, se deshizo.');
                await load();
              }}
            >
              Reabrir mes
            </button>
          ) : (
            <>
              <button
                className="primary"
                style={{ width: '100%' }}
                onClick={async () => {
                  await api.closeSettlement(month, false);
                  setMessage('Mes cerrado y guardado.');
                  await load();
                }}
              >
                Ya nos transferimos
              </button>
              {/* Cerrar sin arrastrar deja el excedente donde está: en la
                  cuenta, o sea del hogar. Decirlo evita que el bloque de abajo
                  parezca que también manda a este botón. */}
              {excedente && excedente.excedente > 0 && (
                <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                  Los {money(excedente.excedente, currency)} que sobraron se quedan en el hogar.
                </p>
              )}

              {/*
                * La otra forma de cerrar.
                *
                * Sólo aparece si hay algo que arrastrar: con el mes cuadrado,
                * ofrecer "pasar el saldo" sería ofrecer pasar cero.
                */}
              {hayDesbalance && (
                <>
                  {/*
                    * Lo que sobró en la cuenta tiene dos destinos posibles y hay
                    * que elegir uno: quedarse en el hogar —donde financia las
                    * metas por medio de la reserva— o volver como crédito a
                    * quien lo puso. Sin decidirlo, la misma plata quedaba
                    * prometida a los dos lados a la vez.
                    */}
                  <div className="o-bien">o</div>

                  {excedente && excedente.excedente > 0 && (
                    <div className="reparto-excedente">
                      <div className="label">Sobraron en la cuenta</div>
                      <div className="cifra-md num">{money(excedente.excedente, currency)}</div>

                      <label className="field" style={{ marginTop: 12, marginBottom: 8 }}>
                        <span>Cuánto se queda el hogar para ahorrar</span>
                        <input
                          inputMode="decimal"
                          value={alAhorro}
                          onChange={(e) => setAlAhorro(e.target.value)}
                        />
                      </label>

                      <div className="ficha-persona-datos">
                        <span>
                          <span className="label">Al ahorro</span>
                          <span className="num">{money(ahorroElegido, currency)}</span>
                        </span>
                        <span>
                          <span className="label">De vuelta</span>
                          <span className="num">
                            {money(Math.max(excedente.excedente - ahorroElegido, 0), currency)}
                          </span>
                        </span>
                      </div>

                      <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                        La sugerencia es el {excedente.savingsPct}% del gasto del mes
                        ({money(excedente.tope, currency)}), y se ajusta en Ajustes → Hogar. Lo que
                        se queda el hogar financia las metas de ahorro; el resto le baja el aporte
                        del próximo mes a quien puso de más.
                      </p>
                    </div>
                  )}

                  <button
                    className="small"
                    style={{ width: '100%', marginTop: 8 }}
                    onClick={async () => {
                      const r = await api.closeSettlement(month, true, ahorroElegido);
                      const partes = [];
                      if (r.arrastre?.ahorrado) partes.push(`${money(r.arrastre.ahorrado, currency)} al ahorro`);
                      if (r.arrastre?.arrastrado) {
                        partes.push(`${money(r.arrastre.arrastrado, currency)} de deuda a ${monthLabel(r.arrastre.hacia)}`);
                      }
                      setMessage(partes.length ? `Mes cerrado: ${partes.join(' y ')}.` : 'Mes cerrado.');
                      await load();
                    }}
                  >
                    Dejarlo para el próximo mes
                  </button>
                  <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                    En vez de transferirse la diferencia hoy, queda anotada y el mes que viene
                    ajusta cuánto pone cada uno. Se deshace reabriendo el mes.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

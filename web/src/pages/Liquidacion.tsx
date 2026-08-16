import { useCallback, useEffect, useState } from 'react';
import { api, type Member, type Settlement } from '../lib/api';
import { useSession } from '../lib/session';
import { currentMonth, money, monthLabel, percent } from '../lib/format';
import MonthNav from '../components/MonthNav';
import { SplitBar } from '../components/Charts';

export default function Liquidacion() {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [month, setMonth] = useState(currentMonth());
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [incomes, setIncomes] = useState<Record<string, string>>({});
  const [projection, setProjection] = useState<{ budget: number; basedOn: string; rows: { userId: string; name: string; amount: number }[] } | null>(null);
  const [budget, setBudget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, h, i, p] = await Promise.all([
        api.settlement(month),
        api.household(),
        api.incomes(),
        api.projection(month),
      ]);
      setSettlement(s);
      setMembers(h.members);
      setProjection(p);
      const map: Record<string, string> = {};
      for (const row of i.incomes.filter((x) => x.month === month)) map[row.userId] = String(row.amount);
      setIncomes(map);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month]);

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

  async function recalcProjection() {
    const value = Number(budget.replace(/[^\d.,-]/g, '').replace(',', '.'));
    setProjection(await api.projection(month, Number.isFinite(value) && value > 0 ? value : undefined));
  }

  const transferFrom = settlement?.transfer ? members.find((m) => m.id === settlement.transfer!.fromUserId) : null;
  const transferTo = settlement?.transfer ? members.find((m) => m.id === settlement.transfer!.toUserId) : null;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Reparto</h1>
          <div className="sub">Quién pone cuánto, según lo que gana cada uno</div>
        </div>
      </div>

      <MonthNav month={month} onChange={setMonth} />

      {error && <div className="error">{error}</div>}
      {message && <div className="ok">{message}</div>}

      <div className="card">
        <h2>Sueldos de {monthLabel(month)}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          El sueldo líquido de cada uno. Si no lo cargas, se arrastra el del último mes declarado.
        </p>
        {members.map((m) => (
          <label className="field" key={m.id}>
            <span>{m.name}{m.id === user?.id && ' (tú)'}</span>
            <input
              inputMode="decimal"
              value={incomes[m.id] ?? ''}
              placeholder="1450000"
              onChange={(e) => setIncomes((prev) => ({ ...prev, [m.id]: e.target.value }))}
              onBlur={(e) => void saveIncome(m.id, e.target.value)}
            />
          </label>
        ))}
        {members.length < 2 && (
          <p className="muted">Falta que la otra persona se una al hogar (Ajustes → Hogar → código de invitación).</p>
        )}
      </div>

      {settlement && settlement.members.length > 0 && (
        <div className="card">
          <h2>Porcentaje que le toca a cada uno</h2>
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

      <div className="card">
        <h2>Cuánto transferir este mes</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Base de cálculo: {projection?.basedOn ?? '—'}.
        </p>
        <div className="wrap" style={{ marginBottom: 10 }}>
          <input
            style={{ flex: 1, minWidth: 140 }}
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={`Presupuesto del mes (${projection ? money(projection.budget, currency) : '—'})`}
          />
          <button onClick={() => void recalcProjection()}>Calcular</button>
        </div>
        <div className="list">
          {projection?.rows.map((row) => (
            <div className="item" key={row.userId}>
              <div className="body"><div className="title">{row.name}</div></div>
              <div className="amount">{money(row.amount, currency)}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Cada uno transfiere ese monto a {household?.officialAccount ?? 'la cuenta del hogar'}.
        </p>
      </div>

      {settlement && (
        <div className="card">
          <div className="card-head">
            <h2>Liquidación de {monthLabel(month)}</h2>
            {settlement.settledAt && <span className="pill good">✓ cerrado</span>}
          </div>

          <table className="data">
            <thead>
              <tr>
                <th>Persona</th>
                <th>Le toca</th>
                <th>Puso</th>
                <th>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {settlement.members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    {m.name}
                    <div className="muted">{percent(m.incomeShare)} del ingreso</div>
                  </td>
                  <td className="num">{money(m.fairShare, currency)}</td>
                  <td className="num">
                    {money(m.contributed, currency)}
                    {m.paidOutOfPocket > 0 && (
                      <div className="muted">incl. {money(m.paidOutOfPocket, currency)} de su bolsillo</div>
                    )}
                  </td>
                  <td className="num" style={{ color: m.deviation < -0.5 ? 'var(--critical)' : 'var(--good-text)' }}>
                    {m.deviation >= 0 ? '+' : ''}{money(m.deviation, currency)}
                  </td>
                </tr>
              ))}
              <tr>
                <td><strong>Total gastos comunes</strong></td>
                <td className="num" colSpan={3}><strong>{money(settlement.totalSharedExpenses, currency)}</strong></td>
              </tr>
            </tbody>
          </table>

          <div
            className="card"
            style={{ marginTop: 14, marginBottom: 0, background: 'var(--plane)', boxShadow: 'none' }}
          >
            {settlement.transfer && transferFrom && transferTo ? (
              <>
                <div className="label">Para quedar a mano</div>
                <div className="hero num" style={{ fontSize: '1.5rem' }}>
                  {transferFrom.name} → {transferTo.name}: {money(settlement.transfer.amount, currency)}
                </div>
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

          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted">
              Saldo de la cuenta del hogar: {money(settlement.officialAccountBalance, currency)}
            </span>
            <button
              className={settlement.settledAt ? 'ghost small' : 'primary small'}
              onClick={async () => {
                if (settlement.settledAt) await api.reopenSettlement(month);
                else await api.closeSettlement(month);
                setMessage(settlement.settledAt ? 'Mes reabierto.' : 'Mes cerrado y guardado.');
                await load();
              }}
            >
              {settlement.settledAt ? 'Reabrir mes' : 'Cerrar mes'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

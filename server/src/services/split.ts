import { db } from '../lib/db.js';

export type MemberBreakdown = {
  userId: string;
  name: string;
  /** Sueldo líquido declarado para el mes. */
  income: number;
  /** Participación en el ingreso total del hogar (0..1). */
  incomeShare: number;
  /** Lo que le corresponde pagar del total de gastos comunes. */
  fairShare: number;
  /** Transferencias hechas a la cuenta oficial del hogar. */
  transferred: number;
  /** Gastos comunes que pagó de su bolsillo (no salieron de la cuenta oficial). */
  paidOutOfPocket: number;
  /** transferred + paidOutOfPocket */
  contributed: number;
  /** contributed - fairShare. Positivo = puso de más. */
  deviation: number;
};

export type Settlement = {
  month: string;
  currency: string;
  totalIncome: number;
  totalSharedExpenses: number;
  /**
   * Gastos personales **de quien pregunta**, no del hogar. Lo personal es
   * privado: sumar los de los dos diría cuánto gastó el otro por su cuenta.
   */
  totalPersonalExpenses: number;
  members: MemberBreakdown[];
  /** Saldo de la cuenta oficial del mes: aportes - gastos pagados desde ella. */
  officialAccountBalance: number;
  /** Instrucción final en lenguaje humano. */
  transfer: { fromUserId: string; toUserId: string; amount: number } | null;
  /** Cuando ambos aportaron de menos, cada uno debe completar su parte. */
  topUps: { userId: string; amount: number }[];
  note: string;
  settledAt: string | null;
};

type MemberRow = { userId: string; name: string };

/**
 * El sueldo del mes puede no estar cargado todavía; en ese caso se arrastra el
 * último mes declarado, que es lo que ocurre en la práctica cuando el sueldo no cambia.
 */
function incomeForMonth(householdId: string, userId: string, month: string): number {
  const exact = db
    .prepare('SELECT amount FROM incomes WHERE household_id = ? AND user_id = ? AND month = ?')
    .get(householdId, userId, month) as { amount: number } | undefined;
  if (exact) return exact.amount;

  const previous = db
    .prepare(
      `SELECT amount FROM incomes
        WHERE household_id = ? AND user_id = ? AND month < ?
        ORDER BY month DESC LIMIT 1`,
    )
    .get(householdId, userId, month) as { amount: number } | undefined;
  return previous?.amount ?? 0;
}

function sum(rows: { total: number | null }[]): number {
  return rows.reduce((acc, r) => acc + (r.total ?? 0), 0);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * @param viewerId quién está mirando. Determina de quién son los gastos
 *   personales que se informan. `null` los deja fuera por completo, que es lo
 *   que corresponde cuando el resultado no es para una persona en particular
 *   —el reporte mensual, que llega igual a los dos—.
 */
export function computeSettlement(
  householdId: string,
  month: string,
  currency: string,
  viewerId: string | null = null,
): Settlement {
  const members = db
    .prepare(
      `SELECT u.id AS userId, u.name AS name
         FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ?
        ORDER BY m.joined_at`,
    )
    .all(householdId) as MemberRow[];

  const like = `${month}-%`;

  const totalShared = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND occurred_on LIKE ? AND type = 'gasto' AND scope = 'comun'`,
      )
      .get(householdId, like) as { total: number }
  ).total;

  const totalPersonal = viewerId
    ? (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
              WHERE household_id = ? AND occurred_on LIKE ?
                AND type = 'gasto' AND scope = 'personal' AND user_id = ?`,
          )
          .get(householdId, like, viewerId) as { total: number }
      ).total
    : 0;

  const rawIncomes = members.map((m) => incomeForMonth(householdId, m.userId, month));
  const totalIncome = rawIncomes.reduce((a, b) => a + b, 0);

  const breakdown: MemberBreakdown[] = members.map((m, i) => {
    const income = rawIncomes[i];
    // Sin sueldos declarados el reparto proporcional no está definido: se cae a 50/50.
    const incomeShare = totalIncome > 0 ? income / totalIncome : 1 / Math.max(members.length, 1);

    const transferred = sum([
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE household_id = ? AND occurred_on LIKE ? AND type = 'aporte' AND user_id = ?`,
        )
        .get(householdId, like, m.userId) as { total: number },
    ]);

    const paidOutOfPocket = sum([
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE household_id = ? AND occurred_on LIKE ?
              AND type = 'gasto' AND scope = 'comun' AND funded_by = ?`,
        )
        .get(householdId, like, m.userId) as { total: number },
    ]);

    const fairShare = round2(totalShared * incomeShare);
    const contributed = round2(transferred + paidOutOfPocket);

    return {
      userId: m.userId,
      name: m.name,
      income,
      incomeShare,
      fairShare,
      transferred: round2(transferred),
      paidOutOfPocket: round2(paidOutOfPocket),
      contributed,
      deviation: round2(contributed - fairShare),
    };
  });

  const paidFromOfficial = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND occurred_on LIKE ?
            AND type = 'gasto' AND scope = 'comun' AND funded_by = 'oficial'`,
      )
      .get(householdId, like) as { total: number }
  ).total;

  const totalTransferred = breakdown.reduce((a, b) => a + b.transferred, 0);
  const officialAccountBalance = round2(totalTransferred - paidFromOfficial);

  const overpaid = breakdown.filter((b) => b.deviation > 0.005).sort((a, b) => b.deviation - a.deviation);
  const underpaid = breakdown.filter((b) => b.deviation < -0.005).sort((a, b) => a.deviation - b.deviation);

  let transfer: Settlement['transfer'] = null;
  let topUps: Settlement['topUps'] = [];
  let note: string;

  if (overpaid.length === 1 && underpaid.length === 1) {
    const amount = round2(Math.min(overpaid[0].deviation, -underpaid[0].deviation));
    transfer = { fromUserId: underpaid[0].userId, toUserId: overpaid[0].userId, amount };
    note = `${underpaid[0].name} le transfiere ${amount} a ${overpaid[0].name} para quedar a mano.`;
  } else if (underpaid.length > 0 && overpaid.length === 0) {
    topUps = underpaid.map((b) => ({ userId: b.userId, amount: round2(-b.deviation) }));
    note = 'Ambos aportaron menos que su parte: cada uno debe completar el saldo a la cuenta del hogar.';
  } else if (overpaid.length > 0 && underpaid.length === 0) {
    note = 'Ambos aportaron de más. Nadie le debe a nadie; el excedente queda en la cuenta del hogar.';
  } else {
    note = 'Las cuentas del mes están cuadradas.';
  }

  const settledRow = db
    .prepare('SELECT settled_at FROM settlements WHERE household_id = ? AND month = ?')
    .get(householdId, month) as { settled_at: string } | undefined;

  return {
    month,
    currency,
    totalIncome,
    totalSharedExpenses: round2(totalShared),
    totalPersonalExpenses: round2(totalPersonal),
    members: breakdown,
    officialAccountBalance,
    transfer,
    topUps,
    note,
    settledAt: settledRow?.settled_at ?? null,
  };
}

export type Projection = {
  /** Gasto estimado del mes, sin contingencia. */
  baseBudget: number;
  contingencyPct: number;
  /** Monto de la contingencia sobre el gasto estimado. */
  contingencyAmount: number;
  /** baseBudget + contingencyAmount: lo que se junta entre los dos. */
  target: number;
  basedOn: string;
  rows: {
    userId: string;
    name: string;
    share: number;
    /** Parte del gasto estimado. */
    base: number;
    /** Parte de la contingencia. */
    contingency: number;
    /** base + contingency: lo que transfiere a la cuenta del hogar. */
    amount: number;
  }[];
};

/**
 * Proyección para el mes en curso: cuánto debería transferir cada uno a la
 * cuenta del hogar dado un presupuesto (o el gasto promedio de los últimos meses),
 * más un porcentaje de contingencia que se reparte con el mismo criterio.
 */
export function projectContributions(
  householdId: string,
  month: string,
  budget: number | null,
  contingencyPct = 0,
): Projection {
  const members = db
    .prepare(
      `SELECT u.id AS userId, u.name AS name
         FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ? ORDER BY m.joined_at`,
    )
    .all(householdId) as MemberRow[];

  let basedOn = 'presupuesto ingresado';
  let baseBudget = budget;

  if (baseBudget == null) {
    const avg = db
      .prepare(
        `SELECT AVG(monthly) AS avg FROM (
            SELECT SUM(amount) AS monthly FROM transactions
             WHERE household_id = ? AND type = 'gasto' AND scope = 'comun' AND occurred_on < ?
             GROUP BY substr(occurred_on, 1, 7)
             ORDER BY substr(occurred_on, 1, 7) DESC
             LIMIT 3)`,
      )
      .get(householdId, `${month}-01`) as { avg: number | null };
    baseBudget = avg.avg ?? 0;
    basedOn = 'promedio de los últimos 3 meses';
  }

  const contingencyAmount = round2(baseBudget * (contingencyPct / 100));
  const target = round2(baseBudget + contingencyAmount);

  const incomes = members.map((m) => incomeForMonth(householdId, m.userId, month));
  const totalIncome = incomes.reduce((a, b) => a + b, 0);

  return {
    baseBudget: round2(baseBudget),
    contingencyPct,
    contingencyAmount,
    target,
    basedOn,
    rows: members.map((m, i) => {
      const share = totalIncome > 0 ? incomes[i] / totalIncome : 1 / Math.max(members.length, 1);
      return {
        userId: m.userId,
        name: m.name,
        share,
        base: round2(baseBudget! * share),
        contingency: round2(contingencyAmount * share),
        amount: round2(target * share),
      };
    }),
  };
}

export type Reserve = {
  /** Saldo acumulado de la cuenta del hogar: todo lo aportado menos lo gastado desde ella. */
  balance: number;
  totalContributed: number;
  totalSpentFromAccount: number;
  /** Gasto común promedio de los últimos meses, para medir la reserva en meses. */
  monthlyAverage: number;
  /** Cuántos meses de gastos cubre la reserva. */
  monthsCovered: number;
  history: { month: string; contributed: number; spent: number; balance: number }[];
};

/**
 * Fondo de reserva: lo que se ha ido acumulando en la cuenta del hogar por
 * encima de los gastos, mes a mes. Es donde termina la contingencia.
 */
/**
 * Las finanzas personales de una persona en un mes.
 *
 * El número que importa es `aporteAlHogar`: lo que puso en la casa es plata que
 * salió de su bolsillo igual que cualquier otro gasto, y es el gasto más grande
 * del mes de casi cualquiera que comparte casa. Una app de finanzas personales
 * aparte tendría que preguntarlo a mano, y quedaría desactualizada apenas
 * cambien los sueldos y con ellos el porcentaje de cada uno.
 */
export type ResumenPersonal = {
  month: string;
  currency: string;
  income: number;
  personalExpenses: number;
  /** Aportes a la cuenta del hogar más gastos comunes pagados de su bolsillo. */
  contributedToHousehold: number;
  /** Lo que queda: ingreso menos lo personal menos lo que puso en la casa. */
  left: number;
  /** Proporción del ingreso que no se gastó. Null si no declaró sueldo. */
  savingsRate: number | null;
};

export function computePersonalSummary(
  householdId: string,
  userId: string,
  month: string,
  currency: string,
): ResumenPersonal {
  const like = `${month}-%`;
  const uno = (sql: string, params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { total: number }).total;

  const income = incomeForMonth(householdId, userId, month);

  const personalExpenses = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND occurred_on LIKE ?
        AND type = 'gasto' AND scope = 'personal' AND user_id = ?`,
    [householdId, like, userId],
  );

  const aportes = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND occurred_on LIKE ? AND type = 'aporte' AND user_id = ?`,
    [householdId, like, userId],
  );

  // Un gasto común que pagó de su bolsillo es aporte igual: la plata salió de
  // su cuenta, no de la del hogar.
  const deSuBolsillo = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND occurred_on LIKE ?
        AND type = 'gasto' AND scope = 'comun' AND funded_by = ?`,
    [householdId, like, userId],
  );

  const contributedToHousehold = aportes + deSuBolsillo;
  const left = income - personalExpenses - contributedToHousehold;

  return {
    month,
    currency,
    income: round2(income),
    personalExpenses: round2(personalExpenses),
    contributedToHousehold: round2(contributedToHousehold),
    left: round2(left),
    savingsRate: income > 0 ? left / income : null,
  };
}

/**
 * Lo que una persona lleva ahorrado, según lo que la app sabe: todo lo que
 * entró menos lo que gastó en lo suyo y lo que puso en la casa.
 *
 * Es una estimación y no un saldo bancario: sólo cuenta los meses en que
 * declaró su sueldo. Sirve para financiar metas personales de la misma forma en
 * que el fondo de reserva financia las del hogar.
 */
export function computePersonalSavings(householdId: string, userId: string): number {
  const ingresos = (
    db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM incomes WHERE household_id = ? AND user_id = ?')
      .get(householdId, userId) as { total: number }
  ).total;

  const salidas = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND (
                (type = 'gasto' AND scope = 'personal' AND user_id = ?)
             OR (type = 'aporte' AND user_id = ?)
             OR (type = 'gasto' AND scope = 'comun' AND funded_by = ?)
          )`,
      )
      .get(householdId, userId, userId, userId) as { total: number }
  ).total;

  return round2(ingresos - salidas);
}

export function computeReserve(householdId: string): Reserve {
  const rows = db
    .prepare(
      `SELECT substr(occurred_on, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN type = 'aporte' THEN amount ELSE 0 END), 0) AS contributed,
              COALESCE(SUM(CASE WHEN type = 'gasto' AND scope = 'comun' AND funded_by = 'oficial'
                                THEN amount ELSE 0 END), 0) AS spent
         FROM transactions
        WHERE household_id = ?
        GROUP BY month
        ORDER BY month`,
    )
    .all(householdId) as { month: string; contributed: number; spent: number }[];

  let running = 0;
  const history = rows.map((r) => {
    running += r.contributed - r.spent;
    return { month: r.month, contributed: round2(r.contributed), spent: round2(r.spent), balance: round2(running) };
  });

  const totalContributed = rows.reduce((a, b) => a + b.contributed, 0);
  const totalSpent = rows.reduce((a, b) => a + b.spent, 0);

  const recent = rows.slice(-3);
  const monthlyAverage = recent.length ? recent.reduce((a, b) => a + b.spent, 0) / recent.length : 0;
  const balance = round2(totalContributed - totalSpent);

  return {
    balance,
    totalContributed: round2(totalContributed),
    totalSpentFromAccount: round2(totalSpent),
    monthlyAverage: round2(monthlyAverage),
    monthsCovered: monthlyAverage > 0 ? Math.round((balance / monthlyAverage) * 10) / 10 : 0,
    history,
  };
}

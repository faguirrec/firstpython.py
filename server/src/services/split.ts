import { db, uid } from '../lib/db.js';

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
  /**
   * Gastos **personales** suyos que pagó con la cuenta del hogar.
   *
   * Sacar plata del pozo común para algo propio es lo contrario de aportar, así
   * que se descuenta. Antes desaparecía de la liquidación: la cuenta quedaba
   * corta y nadie respondía por esa plata.
   */
  personalFromAccount: number;
  /** transferred + paidOutOfPocket - personalFromAccount */
  contributed: number;
  /**
   * Saldo que viene arrastrado de un mes anterior, firmado.
   *
   * Negativo es "quedó debiendo el mes pasado y todavía no lo salda". No es un
   * aporte ni un gasto: es un ajuste entre las dos personas, y por eso se
   * muestra aparte en vez de sumarse a `contributed`. Confundirlo con lo que
   * puso de verdad haría imposible cuadrar con la cartola.
   */
  carriedOver: number;
  /** contributed + carriedOver - fairShare. Positivo = puso de más. */
  deviation: number;
  /** De qué mes viene el arrastre, para poder decirlo en pantalla. */
  carriedFrom: string | null;
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
 * Lo que una persona puso en el hogar en un mes: lo que transfirió a la cuenta
 * común más los gastos comunes que pagó de su bolsillo.
 *
 * Vive en un solo lugar porque la liquidación y la proyección tienen que dar el
 * mismo número. Si cada una lo calculara por su cuenta, tarde o temprano una
 * diría que falta plata y la otra que está al día.
 */
export function contributedBy(householdId: string, userId: string, period: string): number {
  const fila = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
        WHERE household_id = @hogar AND period = @periodo AND (
              (type = 'aporte' AND user_id = @quien)
           OR (type = 'gasto' AND scope = 'comun' AND funded_by = @quien)
        )`,
    )
    .get({ hogar: householdId, periodo: period, quien: userId }) as { total: number };
  return round2(fila.total);
}

/**
 * @param viewerId quién está mirando. Determina de quién son los gastos
 *   personales que se informan. `null` los deja fuera por completo, que es lo
 *   que corresponde cuando el resultado no es para una persona en particular
 *   —el reporte mensual, que llega igual a los dos—.
 */
/* --------------------- Saldos que pasan de un mes a otro ------------------ */

/**
 * Un saldo arrastrado, tal como lo ve el mes que lo recibe.
 */
export type Arrastre = { amount: number; from: string };

/** El mes siguiente a uno dado. */
function mesSiguiente(mes: string): string {
  const [anio, m] = mes.split('-').map(Number);
  return m === 12 ? `${anio + 1}-01` : `${anio}-${String(m + 1).padStart(2, '0')}`;
}

/** Lo que cada persona trae arrastrado hacia este mes. */
export function arrastresHacia(householdId: string, periodo: string): Map<string, Arrastre> {
  const filas = db
    .prepare(
      `SELECT user_id AS userId, amount, from_period AS desde
         FROM carryovers WHERE household_id = ? AND to_period = ?`,
    )
    .all(householdId, periodo) as { userId: string; amount: number; desde: string }[];

  const mapa = new Map<string, Arrastre>();
  for (const f of filas) {
    // Si por lo que sea hubiera más de uno para la misma persona, se suman.
    const previo = mapa.get(f.userId);
    mapa.set(f.userId, { amount: (previo?.amount ?? 0) + f.amount, from: previo?.from ?? f.desde });
  }
  return mapa;
}

/**
 * Pasa al mes siguiente el desbalance con el que cierra un mes.
 *
 * Es la alternativa a transferirse la diferencia: en vez de que quien debe le
 * pase la plata al otro hoy, el saldo queda anotado y el mes que viene ajusta
 * cuánto le toca poner a cada uno.
 *
 * Lo que se arrastra es la desviación de cada uno, que mezcla dos cosas: lo que
 * una persona le debe a la otra, y lo que al hogar entero le sobró o le faltó
 * en la cuenta. Las dos tienen que viajar. Si entre los dos pusieron $430 de
 * más, ese excedente está en la cuenta y el mes siguiente hay que juntar $430
 * menos; por eso los arrastres suman cero sólo cuando el mes cerró financiado
 * justo. No hay doble conteo con el fondo de reserva: el arrastre no crea
 * movimientos, sólo cambia cuánto se le pide a cada uno.
 *
 * Se calcula sobre el reparto **sin** contar lo que ya venía arrastrado hacia
 * este mes: eso ya está incorporado en la desviación, así que arrastrar la
 * desviación resultante mueve el saldo completo hacia adelante, sin duplicarlo.
 */
export function pasarSaldoAlMesSiguiente(
  householdId: string,
  mes: string,
  currency = 'CLP',
  /**
   * Cuánto del excedente se queda el hogar para ahorrar, en vez de devolverlo
   * como crédito. Null usa la sugerencia según el tope configurado.
   */
  alAhorro: number | null = null,
): { arrastrado: number; hacia: string; ahorrado: number } {
  const cierre = computeSettlement(householdId, mes, currency);
  const destino = mesSiguiente(mes);

  const reparto = repartoDelExcedente(householdId, mes, currency);
  // Se acepta lo que pida quien cierra, dentro de lo que hay: guardar más que
  // el excedente sería prometer plata que no está en la cuenta.
  const guardado = Math.min(Math.max(alAhorro ?? reparto.sugeridoAlAhorro, 0), reparto.excedente);

  /*
   * Los créditos se recortan a prorrata; las deudas no se tocan.
   *
   * Quien debe, debe: lo que el hogar decida ahorrar no puede cambiarle el
   * saldo a quien puso de menos. El recorte cae sólo sobre los créditos, y
   * repartido en proporción a cada uno para que ahorrar no favorezca a ninguno.
   */
  const totalCreditos = cierre.members.reduce((a, m) => a + Math.max(m.deviation, 0), 0);
  const factor = totalCreditos > 0 ? Math.max(totalCreditos - guardado, 0) / totalCreditos : 1;

  db.prepare('DELETE FROM carryovers WHERE household_id = ? AND from_period = ?').run(householdId, mes);

  const insertar = db.prepare(
    `INSERT INTO carryovers (id, household_id, from_period, to_period, user_id, amount)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let arrastrado = 0;
  for (const m of cierre.members) {
    const saldo = m.deviation > 0 ? round2(m.deviation * factor) : round2(m.deviation);
    // Un desbalance de céntimos es redondeo, no una deuda que valga la pena
    // arrastrar: anotarlo llenaría los meses de líneas de un peso.
    if (Math.abs(saldo) < 1) continue;
    insertar.run(uid(), householdId, mes, destino, m.userId, saldo);
    if (saldo < 0) arrastrado += -saldo;
  }

  return { arrastrado: round2(arrastrado), hacia: destino, ahorrado: round2(guardado) };
}

/**
 * Qué hacer con lo que sobró en la cuenta al cerrar el mes.
 *
 * El excedente del mes es exactamente la suma de las desviaciones de los dos:
 * lo que pusieron menos lo que les tocaba. Si es positivo, esa plata está en la
 * cuenta y hay que decidir si se queda —y pasa a financiar las metas por medio
 * del fondo de reserva— o vuelve como crédito a quien la puso.
 *
 * La sugerencia usa un porcentaje del **gasto mensual**, no del excedente: así
 * el ahorro es una cifra estable mes a mes en vez de una que sube y baja según
 * lo que haya sobrado.
 */
export function repartoDelExcedente(
  householdId: string,
  mes: string,
  currency = 'CLP',
): {
  excedente: number;
  /** Tope de ahorro para el mes, según el porcentaje del hogar. */
  tope: number;
  savingsPct: number;
  sugeridoAlAhorro: number;
  sugeridoComoCredito: number;
  /** A quién se le devolvería, y cuánto, con la sugerencia. */
  creditos: { userId: string; name: string; amount: number }[];
} {
  const cierre = computeSettlement(householdId, mes, currency);
  const excedente = round2(cierre.members.reduce((a, m) => a + m.deviation, 0));

  const fila = db
    .prepare('SELECT savings_pct AS pct FROM households WHERE id = ?')
    .get(householdId) as { pct: number } | undefined;
  const savingsPct = fila?.pct ?? 10;

  // El gasto del mes que se cierra; si no hubo, el promedio reciente.
  const base = cierre.totalSharedExpenses > 0 ? cierre.totalSharedExpenses : computeReserve(householdId).monthlyAverage;
  const tope = round2(base * (savingsPct / 100));

  const sugeridoAlAhorro = round2(Math.min(Math.max(excedente, 0), tope));
  const sugeridoComoCredito = round2(Math.max(excedente, 0) - sugeridoAlAhorro);

  const totalCreditos = cierre.members.reduce((a, m) => a + Math.max(m.deviation, 0), 0);
  const factor = totalCreditos > 0 ? Math.max(totalCreditos - sugeridoAlAhorro, 0) / totalCreditos : 1;

  return {
    excedente,
    tope,
    savingsPct,
    sugeridoAlAhorro,
    sugeridoComoCredito,
    creditos: cierre.members
      .filter((m) => m.deviation > 0)
      .map((m) => ({ userId: m.userId, name: m.name, amount: round2(m.deviation * factor) })),
  };
}

/** Deshace el arrastre de un mes. Se usa al reabrirlo. */
export function quitarSaldoArrastrado(householdId: string, mes: string): void {
  db.prepare('DELETE FROM carryovers WHERE household_id = ? AND from_period = ?').run(householdId, mes);
}

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

  // El período contable, que no siempre es el mes de la fecha.
  const periodo = month;

  const totalShared = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND period = ? AND type = 'gasto' AND scope = 'comun'`,
      )
      .get(householdId, periodo) as { total: number }
  ).total;

  const totalPersonal = viewerId
    ? (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
              WHERE household_id = ? AND period = ?
                AND type = 'gasto' AND scope = 'personal' AND user_id = ?`,
          )
          .get(householdId, periodo, viewerId) as { total: number }
      ).total
    : 0;

  const rawIncomes = members.map((m) => incomeForMonth(householdId, m.userId, month));
  const totalIncome = rawIncomes.reduce((a, b) => a + b, 0);

  const arrastres = arrastresHacia(householdId, periodo);

  const breakdown: MemberBreakdown[] = members.map((m, i) => {
    const income = rawIncomes[i];
    // Sin sueldos declarados el reparto proporcional no está definido: se cae a 50/50.
    const incomeShare = totalIncome > 0 ? income / totalIncome : 1 / Math.max(members.length, 1);

    const transferred = sum([
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE household_id = ? AND period = ? AND type = 'aporte' AND user_id = ?`,
        )
        .get(householdId, periodo, m.userId) as { total: number },
    ]);

    const paidOutOfPocket = sum([
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE household_id = ? AND period = ?
              AND type = 'gasto' AND scope = 'comun' AND funded_by = ?`,
        )
        .get(householdId, periodo, m.userId) as { total: number },
    ]);

    const personalFromAccount = sum([
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE household_id = ? AND period = ?
              AND type = 'gasto' AND scope = 'personal'
              AND funded_by = 'oficial' AND user_id = ?`,
        )
        .get(householdId, periodo, m.userId) as { total: number },
    ]);

    const fairShare = round2(totalShared * incomeShare);
    const contributed = round2(transferred + paidOutOfPocket - personalFromAccount);
    const arrastre = arrastres.get(m.userId);

    return {
      userId: m.userId,
      name: m.name,
      income,
      incomeShare,
      fairShare,
      transferred: round2(transferred),
      paidOutOfPocket: round2(paidOutOfPocket),
      personalFromAccount: round2(personalFromAccount),
      contributed,
      carriedOver: round2(arrastre?.amount ?? 0),
      carriedFrom: arrastre?.from ?? null,
      deviation: round2(contributed + (arrastre?.amount ?? 0) - fairShare),
    };
  });

  const paidFromOfficial = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
          WHERE household_id = ? AND period = ?
            AND type = 'gasto' AND funded_by = 'oficial'`,
      )
      .get(householdId, periodo) as { total: number }
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
    /**
     * Saldo arrastrado del mes anterior, firmado. Negativo suma a lo que le
     * toca poner; positivo lo descuenta.
     */
    carriedOver: number;
    carriedFrom: string | null;
    /** Lo que ya puso este mes. */
    contributed: number;
    /** Lo que le falta, ya contando el arrastre. */
    pending: number;
  }[];
};

/**
 * Proyección para el mes en curso: cuánto debería transferir cada uno a la
 * cuenta del hogar dado un presupuesto (o el gasto promedio de los últimos meses),
 * más un porcentaje de contingencia que se reparte con el mismo criterio.
 */
/**
 * El gasto estimado que el hogar dejó anotado para un mes.
 *
 * Si ese mes no tiene uno propio, hereda el último declarado antes: la idea es
 * escribirlo una vez y que se mantenga, no volver a decidirlo cada mes.
 */
export function storedTarget(householdId: string, month: string): number | null {
  const exacto = db
    .prepare('SELECT amount FROM expense_targets WHERE household_id = ? AND month = ?')
    .get(householdId, month) as { amount: number } | undefined;
  if (exacto) return exacto.amount;

  const anterior = db
    .prepare(
      `SELECT amount FROM expense_targets
        WHERE household_id = ? AND month < ? ORDER BY month DESC LIMIT 1`,
    )
    .get(householdId, month) as { amount: number } | undefined;
  return anterior?.amount ?? null;
}

/** ¿El mes tiene su propio valor, o está heredando el de un mes anterior? */
export function targetIsInherited(householdId: string, month: string): boolean {
  const exacto = db
    .prepare('SELECT 1 FROM expense_targets WHERE household_id = ? AND month = ?')
    .get(householdId, month);
  return !exacto && storedTarget(householdId, month) !== null;
}

export function saveTarget(householdId: string, month: string, amount: number): void {
  db.prepare(
    `INSERT INTO expense_targets (household_id, month, amount) VALUES (?, ?, ?)
     ON CONFLICT (household_id, month) DO UPDATE SET amount = excluded.amount`,
  ).run(householdId, month, amount);
}

export function clearTarget(householdId: string, month: string): void {
  db.prepare('DELETE FROM expense_targets WHERE household_id = ? AND month = ?').run(householdId, month);
}

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
             WHERE household_id = ? AND type = 'gasto' AND scope = 'comun' AND period < ?
             GROUP BY period
             ORDER BY period DESC
             LIMIT 3)`,
      )
      .get(householdId, month) as { avg: number | null };
    baseBudget = avg.avg ?? 0;
    basedOn = 'promedio de los últimos 3 meses';
  }

  const contingencyAmount = round2(baseBudget * (contingencyPct / 100));
  const target = round2(baseBudget + contingencyAmount);

  const incomes = members.map((m) => incomeForMonth(householdId, m.userId, month));
  const totalIncome = incomes.reduce((a, b) => a + b, 0);
  const arrastres = arrastresHacia(householdId, month);

  return {
    baseBudget: round2(baseBudget),
    contingencyPct,
    contingencyAmount,
    target,
    basedOn,
    rows: members.map((m, i) => {
      const share = totalIncome > 0 ? incomes[i] / totalIncome : 1 / Math.max(members.length, 1);
      const amount = round2(target * share);
      // Lo que ya puso, para que la pantalla pueda decir cuánto falta y no
      // repetir el total del mes como si no hubiera pasado nada.
      const contributed = contributedBy(householdId, m.userId, month);
      // Y lo que quedó debiendo del mes pasado, que también hay que poner.
      const arrastre = arrastres.get(m.userId);
      const saldo = arrastre?.amount ?? 0;
      return {
        userId: m.userId,
        name: m.name,
        share,
        base: round2(baseBudget! * share),
        contingency: round2(contingencyAmount * share),
        amount,
        carriedOver: round2(saldo),
        carriedFrom: arrastre?.from ?? null,
        contributed,
        pending: round2(Math.max(amount - contributed - saldo, 0)),
      };
    }),
  };
}

export type Reserve = {
  /**
   * Lo que debería haber hoy en la cuenta del hogar: el ajuste inicial, más
   * todo lo aportado, menos todo lo que se pagó con ella.
   */
  balance: number;
  /**
   * Plata que ya estaba en la cuenta antes de usar la app, más lo que se haya
   * cuadrado a mano contra la cartola. No es aporte de nadie.
   */
  adjustment: number;
  /** Cuándo se cuadró por última vez, si se hizo. */
  adjustedAt: string | null;
  /**
   * Parte del saldo que ya está prometida como crédito a alguien.
   *
   * Cuando un mes cierra y alguien puso de más, esa plata sigue en la cuenta
   * pero deja de ser del hogar: el mes siguiente esa persona transfiere menos.
   * Contarla como reserva la promete dos veces —una al fondo y otra a quien la
   * puso— y las metas se verían financiadas con plata que hay que devolver.
   */
  committed: number;
  /** balance - committed: lo que de verdad puede financiar metas. */
  free: number;
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
  const periodo = month;
  const uno = (sql: string, params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { total: number }).total;

  const income = incomeForMonth(householdId, userId, month);

  const personalExpenses = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND period = ?
        AND type = 'gasto' AND scope = 'personal' AND user_id = ?`,
    [householdId, periodo, userId],
  );

  const aportes = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND period = ? AND type = 'aporte' AND user_id = ?`,
    [householdId, periodo, userId],
  );

  // Un gasto común que pagó de su bolsillo es aporte igual: la plata salió de
  // su cuenta, no de la del hogar.
  const deSuBolsillo = uno(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE household_id = ? AND period = ?
        AND type = 'gasto' AND scope = 'comun' AND funded_by = ?`,
    [householdId, periodo, userId],
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
      `SELECT period AS month,
              COALESCE(SUM(CASE WHEN type = 'aporte' THEN amount ELSE 0 END), 0) AS contributed,
              -- Todo lo que se pagó con la cuenta, sea común o personal: si
              -- alguien compra algo suyo con la tarjeta de la casa, esa plata
              -- sale del banco igual. Filtrar por 'comun' dejaba el saldo
              -- inflado y hacía imposible cuadrar con la cartola.
              COALESCE(SUM(CASE WHEN type = 'gasto' AND funded_by = 'oficial'
                                THEN amount ELSE 0 END), 0) AS spent
         FROM transactions
        WHERE household_id = ?
        GROUP BY month
        ORDER BY month`,
    )
    .all(householdId) as { month: string; contributed: number; spent: number }[];

  const ajuste = db
    .prepare(
      `SELECT balance_adjustment AS monto, balance_adjusted_at AS cuando
         FROM households WHERE id = ?`,
    )
    .get(householdId) as { monto: number; cuando: string | null } | undefined;
  const adjustment = ajuste?.monto ?? 0;

  // El acumulado arranca en lo que ya había: si no, la última fila del
  // histórico no coincidiría con el saldo que muestra la tarjeta.
  let running = adjustment;
  const history = rows.map((r) => {
    running += r.contributed - r.spent;
    return { month: r.month, contributed: round2(r.contributed), spent: round2(r.spent), balance: round2(running) };
  });

  const totalContributed = rows.reduce((a, b) => a + b.contributed, 0);
  const totalSpent = rows.reduce((a, b) => a + b.spent, 0);

  const recent = rows.slice(-3);
  const monthlyAverage = recent.length ? recent.reduce((a, b) => a + b.spent, 0) / recent.length : 0;
  const balance = round2(adjustment + totalContributed - totalSpent);

  /*
   * Créditos que el hogar todavía le debe a alguien.
   *
   * Sólo cuentan los que apuntan a este mes o a uno futuro: los de meses
   * pasados ya se aplicaron —esa persona transfirió menos y la cuenta recibió
   * menos—, así que su efecto está en el saldo y restarlos otra vez sería
   * descontarlos dos veces.
   */
  const ahora = new Date().toISOString().slice(0, 7);
  const committed = round2(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM carryovers
            WHERE household_id = ? AND amount > 0 AND to_period >= ?`,
        )
        .get(householdId, ahora) as { total: number }
    ).total,
  );
  const free = round2(balance - committed);

  return {
    balance,
    adjustment: round2(adjustment),
    adjustedAt: ajuste?.cuando ?? null,
    committed,
    free,
    totalContributed: round2(totalContributed),
    totalSpentFromAccount: round2(totalSpent),
    monthlyAverage: round2(monthlyAverage),
    // Los meses de gastos se miden contra lo que de verdad está libre: contar
    // plata prometida diría que hay más colchón del que hay.
    monthsCovered: monthlyAverage > 0 ? Math.round((free / monthlyAverage) * 10) / 10 : 0,
    history,
  };
}

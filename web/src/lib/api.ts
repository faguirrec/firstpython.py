import { paramModo, type Modo } from './modo';

export type User = { id: string; email: string; name: string };
export type Household = {
  id: string;
  name: string;
  currency: string;
  officialAccount: string;
  contingencyPct: number;
  sendMonthlyReport: number;
};

export type CambiosHogar = Partial<Omit<Household, 'id' | 'sendMonthlyReport'>> & {
  sendMonthlyReport?: boolean;
};
export type Member = { id: string; name: string; email: string; role: string; joinedAt: string };

export type Transaction = {
  id: string;
  occurredOn: string;
  amount: number;
  type: 'gasto' | 'aporte' | 'ingreso_extra';
  scope: 'comun' | 'personal';
  fundedBy: string;
  userId: string | null;
  userName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryEmoji: string | null;
  merchant: string | null;
  description: string | null;
  accountLabel: string | null;
  installments: number | null;
  source: 'manual' | 'gmail';
  rawSnippet: string | null;
  reviewed: number;
};

export type MemberBreakdown = {
  userId: string;
  name: string;
  income: number;
  incomeShare: number;
  fairShare: number;
  transferred: number;
  paidOutOfPocket: number;
  contributed: number;
  deviation: number;
};

export type Settlement = {
  month: string;
  currency: string;
  totalIncome: number;
  totalSharedExpenses: number;
  totalPersonalExpenses: number;
  members: MemberBreakdown[];
  officialAccountBalance: number;
  transfer: { fromUserId: string; toUserId: string; amount: number } | null;
  topUps: { userId: string; amount: number }[];
  note: string;
  settledAt: string | null;
};

export type Category = {
  id: string;
  name: string;
  kind: string;
  color: string;
  emoji: string;
  archived: number;
  usos: number;
};
export type CategoryRule = { id: string; pattern: string; priority: number; categoryId: string; categoryName: string };

export type EmailRule = {
  id: string;
  name: string;
  enabled: number;
  gmailQuery: string;
  amountRegex: string;
  merchantRegex: string | null;
  dateRegex: string | null;
  accountRegex: string | null;
  cardFilter: string | null;
  mustContain: string | null;
  mustNotContain: string | null;
  type: 'gasto' | 'aporte';
  scope: 'comun' | 'personal';
  accountLabel: string | null;
  /** A quién se le atribuye lo que importe esta regla. */
  userId: string | null;
  priority: number;
};

export type BankTemplate = {
  key: string;
  name: string;
  gmail_query: string;
  amount_regex: string;
  merchant_regex: string | null;
  date_regex: string | null;
  account_regex: string | null;
  must_contain?: string | null;
  must_not_contain?: string | null;
  type: 'gasto' | 'aporte';
  scope: 'comun' | 'personal';
};

export type SyncResult = {
  imported: number;
  skipped: number;
  scanned: number;
  errors: string[];
  byRule: Record<string, number>;
  dryRun: boolean;
  preview: {
    rule: string;
    amount: number;
    merchant: string | null;
    occurredOn: string;
    account: string | null;
    subject: string;
    duplicate: boolean;
  }[];
};

export type CuentaImap = {
  id: string;
  email: string;
  host: string;
  port: number;
  carpeta: string;
  lastSyncAt: string | null;
  /** Si hay una conexión abierta escuchando el buzón en este momento. */
  escuchando: boolean;
};

export type MessagePreview = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  alreadyImported: boolean;
};

export type Projection = {
  baseBudget: number;
  contingencyPct: number;
  contingencyAmount: number;
  target: number;
  basedOn: string;
  rows: { userId: string; name: string; share: number; base: number; contingency: number; amount: number }[];
};

export type CategoryBudget = {
  categoryId: string;
  category: string;
  color: string;
  emoji: string;
  budget: number;
  fromBase: boolean;
  spent: number;
  remaining: number;
  used: number;
  status: 'sin-presupuesto' | 'ok' | 'atencion' | 'excedido';
};

export type BudgetStatus = {
  month: string;
  totalBudget: number;
  totalSpent: number;
  budgetedSpent: number;
  unbudgetedSpent: number;
  categories: CategoryBudget[];
  monthProgress: number;
  overBudget: CategoryBudget[];
  nearLimit: CategoryBudget[];
};

export type Goal = {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  priority: number;
  funded: number;
  progress: number;
  complete: boolean;
  monthsLeft: number | null;
  monthlyNeeded: number | null;
  onTrack: boolean | null;
};

export type GoalsView = { reserve: number; goals: Goal[]; unassigned: number };

export type GastoFijo = {
  id: string;
  name: string;
  /** Null cuando el monto cambia mes a mes. */
  amount: number | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  dueDay: number | null;
  matchText: string | null;
  active: boolean;
};

export type EstadoGastoFijo = GastoFijo & {
  expected: number;
  expectedFrom: 'declarado' | 'promedio' | 'sin-datos';
  paidWith: { id: string; amount: number; occurredOn: string; merchant: string | null } | null;
  paid: boolean;
};

export type EstadoFijos = {
  month: string;
  items: EstadoGastoFijo[];
  totalExpected: number;
  totalPaid: number;
  totalPending: number;
  pendientes: EstadoGastoFijo[];
  /** Todos los declarados, incluidos los apagados. */
  all: GastoFijo[];
};

export type ResumenPersonal = {
  month: string;
  currency: string;
  income: number;
  personalExpenses: number;
  /** Aportes a la cuenta del hogar más gastos comunes pagados de su bolsillo. */
  contributedToHousehold: number;
  left: number;
  savingsRate: number | null;
};

export type CategoryChange = {
  category: string;
  color: string;
  emoji: string;
  current: number;
  previous: number;
  average: number;
  deltaPrevious: number;
  deltaAverage: number;
  changePct: number | null;
};

export type Comparison = {
  month: string;
  previousMonth: string;
  totalCurrent: number;
  totalPrevious: number;
  totalAverage: number;
  categories: CategoryChange[];
  biggestIncreases: CategoryChange[];
  biggestDecreases: CategoryChange[];
};

export type Reserve = {
  balance: number;
  totalContributed: number;
  totalSpentFromAccount: number;
  monthlyAverage: number;
  monthsCovered: number;
  history: { month: string; contributed: number; spent: number; balance: number }[];
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const payload = data as { error?: string; code?: string };
    throw new ApiError(payload.error ?? 'Algo salió mal', response.status, payload.code);
  }
  return data as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  me: () => get<{ user: User; household: Household | null }>('/auth/me'),
  health: () =>
    get<{
      ok: true;
      gmail: boolean;
      correo: boolean;
      version: string;
      build: string;
      compiladoEn: string;
      desde: string;
    }>('/health'),
  login: (email: string, password: string) => post<{ user: User }>('/auth/login', { email, password }),
  register: (body: { email: string; password: string; name: string; inviteCode?: string }) =>
    post<{ user: User; joined: boolean }>('/auth/register', body),
  logout: () => post<{ ok: true }>('/auth/logout'),

  createHousehold: (body: { name: string; currency: string; officialAccount: string }) =>
    post<{ id: string }>('/household', body),
  joinHousehold: (code: string) => post<{ id: string }>('/household/join', { code }),
  household: () => get<{ household: Household; members: Member[]; inviteCode: string | null }>('/household'),
  // El hogar llega con sendMonthlyReport como 0/1 (viene de SQLite), pero al
  // guardarlo se manda como booleano, que es lo que valida el servidor.
  updateHousehold: (body: CambiosHogar) => patch<{ ok: true }>('/household', body),
  invite: () => post<{ code: string }>('/household/invite'),
  rotateInvite: () => post<{ code: string }>('/household/invite/rotate'),
  revokeInvite: () => del<{ ok: true }>('/household/invite'),
  invitePreview: (code: string) =>
    get<{ householdName: string; invitedBy: string }>(`/household/invite/${encodeURIComponent(code)}`),
  inviteByEmail: (email: string) =>
    post<{ ok: true; enviadoA: string }>('/household/invite/email', { email, origin: window.location.origin }),

  emailStatus: () => get<{ configured: boolean; from: string | null }>('/settings/email'),
  sendTestEmail: () => post<{ ok: true; enviadoA: string }>('/settings/email/test'),
  sendTestReport: (month?: string) =>
    post<{ ok: true; enviadoA: string; mes: string }>('/settings/email/reporte-de-prueba', { month }),

  transactions: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') query.set(k, String(v));
    return get<{ transactions: Transaction[] }>(`/transactions?${query.toString()}`);
  },
  createTransaction: (body: Record<string, unknown>) => post<Transaction>('/transactions', body),
  updateTransaction: (id: string, body: Record<string, unknown>) => patch<Transaction>(`/transactions/${id}`, body),
  deleteTransaction: (id: string) => del<{ ok: true }>(`/transactions/${id}`),
  reviewAll: () => post<{ reviewed: number }>('/transactions/review-all'),
  recategorize: () => post<{ updated: number }>('/transactions/recategorize'),

  incomes: () => get<{ incomes: { id: string; month: string; amount: number; note: string | null; userId: string; userName: string }[] }>('/finance/incomes'),
  saveIncome: (body: { month: string; userId?: string; amount: number; note?: string | null }) =>
    put<{ ok: true }>('/finance/incomes', body),
  settlement: (month: string) => get<Settlement>(`/finance/settlement?month=${month}`),
  closeSettlement: (month: string) => post<{ ok: true }>('/finance/settlement/close', { month }),
  reopenSettlement: (month: string) => del<{ ok: true }>(`/finance/settlement/close?month=${month}`),
  projection: (month: string, budget?: number, contingency?: number) =>
    get<Projection>(
      `/finance/projection?month=${month}` +
        (budget != null ? `&budget=${budget}` : '') +
        (contingency != null ? `&contingency=${contingency}` : ''),
    ),
  reserve: () => get<Reserve>('/finance/reserve'),

  monthlyReport: (months = 12) =>
    get<{ months: { month: string; shared: number; personal: number; contributions: number; income: number }[] }>(
      `/finance/reports/monthly?months=${months}`,
    ),
  byCategory: (month?: string, scope?: 'comun' | 'personal') => {
    const query = new URLSearchParams();
    if (month) query.set('month', month);
    if (scope) query.set('scope', scope);
    return get<{ categories: { category: string; color: string; emoji: string; total: number; count: number }[] }>(
      `/finance/reports/by-category?${query.toString()}`,
    );
  },
  // `modo` decide qué bolsillo se consulta. Va explícito en cada llamada en vez
  // de leerse del almacenamiento acá dentro: así una pantalla puede mostrar los
  // dos lados a la vez el día que haga falta.
  comparison: (month: string, lookback = 3, modo: Modo = 'hogar') =>
    get<Comparison>(
      `/finance/reports/comparison?month=${month}&lookback=${lookback}${paramModo(modo)}`,
    ),

  budgets: (month: string, modo: Modo = 'hogar') =>
    get<BudgetStatus>(`/finance/budgets?month=${month}${paramModo(modo)}`),
  saveBudget: (body: { categoryId: string; amount: number; month?: string | null; modo?: Modo }) =>
    put<{ ok: true }>('/finance/budgets', body),

  gastosFijos: (month: string) => get<EstadoFijos>(`/finance/fixed?month=${month}`),
  crearGastoFijo: (body: {
    name: string; amount?: number | null; categoryId?: string | null;
    dueDay?: number | null; matchText?: string | null;
  }) => post<{ id: string }>('/finance/fixed', body),
  actualizarGastoFijo: (id: string, body: Record<string, unknown>) =>
    patch<{ ok: true }>(`/finance/fixed/${id}`, body),
  borrarGastoFijo: (id: string) => del<{ ok: true }>(`/finance/fixed/${id}`),

  /** Las finanzas de quien está usando la app, con el aporte al hogar incluido. */
  resumenPersonal: (month: string) => get<ResumenPersonal>(`/finance/personal?month=${month}`),

  goals: (modo: Modo = 'hogar') => get<GoalsView>(`/finance/goals?modo=${modo}`),
  createGoal: (body: { name: string; targetAmount: number; targetDate?: string | null; modo?: Modo }) =>
    post<{ id: string }>('/finance/goals', body),
  updateGoal: (id: string, body: Record<string, unknown>) => patch<{ ok: true }>(`/finance/goals/${id}`, body),
  deleteGoal: (id: string) => del<{ ok: true }>(`/finance/goals/${id}`),

  categories: () => get<{ categories: Category[] }>('/settings/categories'),
  createCategory: (body: { name: string; kind: string; color: string }) => post<Category>('/settings/categories', body),
  updateCategory: (id: string, body: Partial<Category>) => patch<{ ok: true }>(`/settings/categories/${id}`, body),
  deleteCategory: (id: string) => del<{ ok: true }>(`/settings/categories/${id}`),

  categoryRules: () => get<{ rules: CategoryRule[] }>('/settings/category-rules'),
  createCategoryRule: (body: { pattern: string; categoryId: string }) => post<{ id: string }>('/settings/category-rules', body),
  deleteCategoryRule: (id: string) => del<{ ok: true }>(`/settings/category-rules/${id}`),

  emailRules: () => get<{ rules: EmailRule[]; templates: BankTemplate[] }>('/settings/email-rules'),
  createEmailRule: (body: Record<string, unknown>) => post<{ id: string }>('/settings/email-rules', body),
  updateEmailRule: (id: string, body: Record<string, unknown>) => patch<{ ok: true }>(`/settings/email-rules/${id}`, body),
  deleteEmailRule: (id: string) => del<{ ok: true }>(`/settings/email-rules/${id}`),
  testEmailRule: (body: { sample: string; isHtml: boolean; rule: Record<string, unknown> }) =>
    post<{ matched: boolean; movement: { amount: number; merchant: string | null; occurredOn: string; account: string | null } | null; text: string }>(
      '/settings/email-rules/test',
      body,
    ),

  gmailStatus: () =>
    get<{
      configured: boolean;
      accounts: { id: string; email: string; lastSyncAt: string | null }[];
      pendingReview: number;
      redirectUri: string;
    }>('/gmail/status'),
  // El origen viaja explícito para que Google devuelva a la misma dirección
  // desde la que se abrió la app (localhost, IP de la casa o túnel HTTPS).
  gmailAuthUrl: () =>
    get<{ url: string }>(`/gmail/auth-url?origin=${encodeURIComponent(window.location.origin)}`),
  gmailSync: (dryRun = false) => post<SyncResult>('/gmail/sync', { dryRun }),
  gmailSearch: (q: string, limit = 10) =>
    get<{ messages: MessagePreview[]; errors: string[] }>(
      `/gmail/messages?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  gmailMessage: (id: string) => get<{ subject: string; from: string; body: string }>(`/gmail/messages/${id}`),
  disconnectGmail: (id: string) => del<{ ok: true }>(`/gmail/accounts/${id}`),

  imapStatus: () =>
    get<{
      accounts: CuentaImap[];
      tiempoReal: boolean;
      sondeoMinutos: number;
      porDefecto: { host: string; port: number; carpeta: string };
    }>('/imap/status'),
  conectarImap: (body: { email: string; secreto: string; host?: string; port?: number; carpeta?: string }) =>
    post<{ ok: true; carpeta: string; mensajes: number }>('/imap/accounts', body),
  desconectarImap: (id: string) => del<{ ok: true }>(`/imap/accounts/${id}`),
  imapSync: (dryRun = false) => post<SyncResult>('/imap/sync', { dryRun }),
  imapSearch: (q: string, limit = 10) =>
    get<{ messages: MessagePreview[]; errors: string[] }>(
      `/imap/messages?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  imapMessage: (id: string) =>
    get<{ subject: string; from: string; body: string }>(`/imap/message?id=${encodeURIComponent(id)}`),
};

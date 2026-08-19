import { useEffect, useState } from 'react';
import { api, type BankTemplate, type EmailRule, type Member } from '../lib/api';
import { useSession } from '../lib/session';
import { money } from '../lib/format';
import Sheet from './Sheet';
import ExploradorCorreos from './ExploradorCorreos';

const EMPTY: Omit<EmailRule, 'id'> = {
  name: '',
  enabled: 0,
  gmailQuery: 'from:(mibanco.cl) newer_than:60d',
  amountRegex: '\\$\\s?([\\d.,]+)',
  merchantRegex: 'en\\s+([^\\n,]{2,60})',
  dateRegex: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
  accountRegex: null,
  cardFilter: null,
  mustContain: null,
  mustNotContain: null,
  type: 'gasto',
  scope: 'comun',
  accountLabel: null,
  userId: null,
  priority: 100,
};

export default function AjustesReglas() {
  const { household } = useSession();
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [templates, setTemplates] = useState<BankTemplate[]>([]);
  const [editing, setEditing] = useState<(Omit<EmailRule, 'id'> & { id?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const data = await api.emailRules();
    setRules(data.rules);
    setTemplates(data.templates);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(rule: EmailRule) {
    await api.updateEmailRule(rule.id, { enabled: rule.enabled === 0 });
    await load();
  }

  function fromTemplate(template: BankTemplate) {
    setEditing({
      ...EMPTY,
      name: template.name,
      enabled: 1,
      gmailQuery: template.gmail_query,
      amountRegex: template.amount_regex,
      merchantRegex: template.merchant_regex,
      dateRegex: template.date_regex,
      accountRegex: template.account_regex,
      mustContain: template.must_contain ?? null,
      mustNotContain: template.must_not_contain ?? null,
      type: template.type,
      scope: template.scope,
    });
  }

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Reglas de correo</h2>
          <button className="primary small" onClick={() => setEditing({ ...EMPTY })}>+ Nueva</button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Cada regla busca ciertos correos en Gmail y saca de ellos el monto, el comercio y la fecha. Vienen
          desactivadas: activa la de tu banco y pruébala con un correo real antes de sincronizar.
        </p>

        <div className="list">
          {rules.map((rule) => (
            <div className="item" key={rule.id}>
              <div className="body">
                <div className="title">{rule.name}</div>
                <div className="meta una-linea" style={{ fontFamily: 'ui-monospace, monospace' }}>{rule.gmailQuery}</div>
                <div className="meta">
                  {rule.type === 'aporte' ? 'crea aportes' : 'crea gastos'} · {rule.scope === 'comun' ? 'comunes' : 'personales'}
                </div>
              </div>
              <div className="actions">
                <span className={`pill ${rule.enabled ? 'good' : ''}`}>{rule.enabled ? '● activa' : '○ inactiva'}</span>
                <div className="wrap">
                  <button className="small ghost" onClick={() => void toggle(rule)}>
                    {rule.enabled ? 'Desactivar' : 'Activar'}
                  </button>
                  <button className="small ghost" onClick={() => setEditing(rule)}>Editar</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Plantillas de bancos</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Punto de partida para los avisos más comunes. Los bancos cambian el texto de sus correos cada tanto, así que
          revisa el resultado con la prueba antes de confiar en una.
        </p>
        <div className="list">
          {templates.map((t) => (
            <div className="item" key={t.key}>
              <div className="body"><div className="title">{t.name}</div></div>
              <button className="small" onClick={() => fromTemplate(t)}>Usar</button>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <EditorRegla
          rule={editing}
          currency={household?.currency ?? 'CLP'}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function EditorRegla({
  rule,
  currency,
  onClose,
  onSaved,
  onError,
}: {
  rule: Omit<EmailRule, 'id'> & { id?: string };
  currency: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(rule);
  // Los integrantes del hogar, para poder decir de quién es un aporte.
  const [miembros, setMiembros] = useState<Member[]>([]);
  const [sample, setSample] = useState('');
  const [isHtml, setIsHtml] = useState(false);
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.testEmailRule>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [explorer, setExplorer] = useState(false);

  useEffect(() => {
    void api.household().then((h) => setMiembros(h.members)).catch(() => undefined);
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const payload = {
    name: form.name,
    enabled: Boolean(form.enabled),
    gmailQuery: form.gmailQuery,
    amountRegex: form.amountRegex,
    merchantRegex: form.merchantRegex || null,
    dateRegex: form.dateRegex || null,
    accountRegex: form.accountRegex || null,
    cardFilter: form.cardFilter || null,
    mustContain: form.mustContain || null,
    mustNotContain: form.mustNotContain || null,
    type: form.type,
    scope: form.scope,
    accountLabel: form.accountLabel || null,
    userId: form.userId || null,
    priority: form.priority,
  };

  async function runTest() {
    if (!sample.trim()) return;
    setBusy(true);
    try {
      setTest(await api.testEmailRule({ sample, isHtml, rule: payload }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      if (form.id) await api.updateEmailRule(form.id, payload);
      else await api.createEmailRule(payload);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={form.id ? 'Editar regla' : 'Nueva regla'} onClose={onClose}>
      <label className="field">
        <span>Nombre</span>
        <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mi banco — compras" />
      </label>

      <label className="field">
        <span>Búsqueda en Gmail</span>
        <input value={form.gmailQuery} onChange={(e) => set('gmailQuery', e.target.value)} />
        <em className="muted">Misma sintaxis del buscador de Gmail: from:, subject:, newer_than:…</em>
      </label>

      <div className="grid2">
        <label className="field">
          <span>Crea</span>
          <select value={form.type} onChange={(e) => set('type', e.target.value as 'gasto' | 'aporte')}>
            <option value="gasto">Gastos</option>
            <option value="aporte">Aportes recibidos</option>
          </select>
        </label>
        <label className="field">
          <span>Se reparten</span>
          <select value={form.scope} onChange={(e) => set('scope', e.target.value as 'comun' | 'personal')}>
            <option value="comun">Sí, comunes</option>
            <option value="personal">No, personales</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span>Monto (regex, grupo 1)</span>
        <input value={form.amountRegex} onChange={(e) => set('amountRegex', e.target.value)} />
      </label>
      <label className="field">
        <span>Comercio (regex)</span>
        <input value={form.merchantRegex ?? ''} onChange={(e) => set('merchantRegex', e.target.value)} />
      </label>
      <label className="field">
        <span>Fecha (regex)</span>
        <input value={form.dateRegex ?? ''} onChange={(e) => set('dateRegex', e.target.value)} />
      </label>
      <label className="field">
        <span>Cuenta o tarjeta (regex)</span>
        <input value={form.accountRegex ?? ''} onChange={(e) => set('accountRegex', e.target.value)} />
      </label>
      <label className="field">
        <span>Sólo estas tarjetas (últimos 4 dígitos, separados por coma)</span>
        <input
          value={form.cardFilter ?? ''}
          onChange={(e) => set('cardFilter', e.target.value)}
          placeholder="1234, 5678"
        />
        <em className="muted">Sirve para ignorar las tarjetas personales que no entran al reparto.</em>
      </label>

      <label className="field">
        <span>Sólo si el correo dice (uno por línea, tienen que estar todos)</span>
        <textarea
          rows={2}
          value={form.mustContain ?? ''}
          onChange={(e) => set('mustContain', e.target.value)}
          placeholder={'Mercado Pago\nFrancisco Javier Aguirre'}
        />
        <em className="muted">
          Para separar correos del mismo banco con el mismo formato: a qué cuenta llegó la plata, o quién la
          envió.
        </em>
      </label>

      <label className="field">
        <span>Y NO dice (uno por línea, basta con uno para descartarlo)</span>
        <textarea
          rows={2}
          value={form.mustNotContain ?? ''}
          onChange={(e) => set('mustNotContain', e.target.value)}
          placeholder={'Mercado Pago'}
        />
        <em className="muted">
          Los bancos avisan la misma transferencia dos veces, como enviada y como recibida. Descartando acá la
          cuenta del hogar, esa plata entra una sola vez y no como gasto y aporte a la vez.
        </em>
      </label>

      <label className="field">
        <span>Atribuir a</span>
        <select value={form.userId ?? ''} onChange={(e) => set('userId', e.target.value || null)}>
          <option value="">Nadie en particular</option>
          {miembros.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        {form.type === 'aporte' && !form.userId ? (
          <em className="alerta">
            Un aporte sin dueño no le cuenta a nadie en la liquidación. Elige de quién es.
          </em>
        ) : (
          <em className="muted">
            Obligatorio en los aportes: la liquidación suma lo que puso cada uno por su nombre.
          </em>
        )}
      </label>

      <div className="card" style={{ background: 'var(--plane)', boxShadow: 'none' }}>
        <h3>Probar con un correo real</h3>
        <p className="muted" style={{ marginTop: 4 }}>
          Trae un aviso de tu bandeja o pega el texto a mano, y revisa qué extrae la regla. No se guarda nada.
        </p>
        <button className="small" style={{ marginBottom: 8 }} onClick={() => setExplorer(true)}>
          ✉ Traer un correo real de Gmail
        </button>
        <textarea
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="Compra por $45.990 en JUMBO KENNEDY el 14/08/2026 con tu tarjeta terminada en 1234"
        />
        <label className="row" style={{ justifyContent: 'flex-start', gap: 8, margin: '8px 0' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={isHtml}
            onChange={(e) => setIsHtml(e.target.checked)}
          />
          <span className="muted">El texto pegado es HTML</span>
        </label>
        <button onClick={() => void runTest()} disabled={busy || !sample.trim()}>Probar</button>

        {test && (
          <div style={{ marginTop: 10 }}>
            {test.matched && test.movement ? (
              <div className="ok">
                <strong>Calzó.</strong>
                <div>Monto: {money(test.movement.amount, currency)}</div>
                <div>Comercio: {test.movement.merchant ?? '—'}</div>
                <div>Fecha: {test.movement.occurredOn}</div>
                <div>Cuenta/tarjeta: {test.movement.account ?? '—'}</div>
              </div>
            ) : (
              <div className="error">
                No calzó. Lo más común es que falle la regex del monto: revisa que el grupo 1 sea el número.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="wrap" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void save()} disabled={busy || !form.name.trim()}>
          Guardar regla
        </button>
        <button className="ghost" onClick={onClose}>Cancelar</button>
        {form.id && (
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`¿Borrar la regla "${form.name}"?`)) return;
              await api.deleteEmailRule(form.id!);
              onSaved();
            }}
          >
            Borrar
          </button>
        )}
      </div>

      {explorer && (
        <ExploradorCorreos
          onClose={() => setExplorer(false)}
          onUseMessage={(body) => {
            // El servidor ya devuelve texto plano, así que la casilla de HTML sobra.
            setSample(body);
            setIsHtml(false);
            setTest(null);
            setExplorer(false);
          }}
        />
      )}
    </Sheet>
  );
}

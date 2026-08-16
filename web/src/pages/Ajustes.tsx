import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Household, type Member } from '../lib/api';
import { useSession } from '../lib/session';
import Categorias from '../components/AjustesCategorias';
import GmailPanel from '../components/AjustesGmail';
import ReglasCorreo from '../components/AjustesReglas';

const TABS = [
  { key: 'hogar', label: 'Hogar' },
  { key: 'categorias', label: 'Categorías' },
  { key: 'gmail', label: 'Gmail' },
  { key: 'reglas', label: 'Reglas de correo' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function Ajustes() {
  const location = useLocation();
  const navigate = useNavigate();
  const fromUrl = location.pathname.split('/')[2] as TabKey | undefined;
  const [tab, setTab] = useState<TabKey>(TABS.some((t) => t.key === fromUrl) ? fromUrl! : 'hogar');

  function select(key: TabKey) {
    setTab(key);
    navigate(key === 'hogar' ? '/ajustes' : `/ajustes/${key}`, { replace: true });
  }

  return (
    <>
      <div className="topbar">
        <h1>Ajustes</h1>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => select(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'hogar' && <PanelHogar />}
      {tab === 'categorias' && <Categorias />}
      {tab === 'gmail' && <GmailPanel />}
      {tab === 'reglas' && <ReglasCorreo />}
    </>
  );
}

function PanelHogar() {
  const { user, signOut, refresh } = useSession();
  const [household, setHousehold] = useState<Household | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const data = await api.household();
    setHousehold(data.household);
    setMembers(data.members);
    setCode(data.inviteCode);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(patch: Partial<Household>) {
    await api.updateHousehold(patch);
    await Promise.all([load(), refresh()]);
    setMessage('Guardado.');
  }

  if (!household) return <p className="muted">Cargando…</p>;

  return (
    <>
      {message && <div className="ok">{message}</div>}

      <div className="card">
        <h2>Datos del hogar</h2>
        <label className="field">
          <span>Nombre</span>
          <input
            defaultValue={household.name}
            onBlur={(e) => e.target.value !== household.name && void save({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Cuenta oficial: de dónde salen los gastos comunes</span>
          <input
            defaultValue={household.officialAccount}
            onBlur={(e) =>
              e.target.value !== household.officialAccount && void save({ officialAccount: e.target.value })
            }
          />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Moneda</span>
          <select defaultValue={household.currency} onChange={(e) => void save({ currency: e.target.value })}>
            {['CLP', 'ARS', 'COP', 'MXN', 'PEN', 'USD', 'EUR'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>Integrantes</h2>
        <div className="list">
          {members.map((m) => (
            <div className="item" key={m.id}>
              <div className="body">
                <div className="title">{m.name} {m.id === user?.id && <span className="muted">· tú</span>}</div>
                <div className="meta">{m.email}</div>
              </div>
              <span className="pill">{m.role === 'owner' ? 'creó el hogar' : 'integrante'}</span>
            </div>
          ))}
        </div>

        {members.length < 2 && (
          <div style={{ marginTop: 12 }}>
            {code ? (
              <>
                <div className="label">Código para que se una la otra persona</div>
                <div className="hero num" style={{ letterSpacing: '0.15em' }}>{code}</div>
                <p className="muted">
                  Que cree su cuenta y elija «Unirme con código». Los dos ven exactamente los mismos datos.
                </p>
              </>
            ) : (
              <button
                className="primary"
                onClick={async () => {
                  const created = await api.invite();
                  setCode(created.code);
                }}
              >
                Generar código de invitación
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Instalar en el iPhone</h2>
        <ol style={{ paddingLeft: 20, margin: 0 }} className="muted">
          <li>Abre esta misma dirección en Safari (no en Chrome).</li>
          <li>Toca el botón Compartir.</li>
          <li>Elige «Agregar a pantalla de inicio».</li>
        </ol>
        <p className="muted" style={{ marginBottom: 0 }}>
          Queda como una app más, a pantalla completa y con su propio icono.
        </p>
      </div>

      <div className="card">
        <button className="danger" onClick={() => void signOut()}>Cerrar sesión</button>
      </div>
    </>
  );
}

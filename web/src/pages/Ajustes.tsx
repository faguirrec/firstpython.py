import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type CambiosHogar, type Household, type Member } from '../lib/api';
import { useSession } from '../lib/session';
import Categorias from '../components/AjustesCategorias';
import GastosFijos from '../components/GastosFijos';
import CorreoPanel from '../components/AjustesCorreo';
import ReglasCorreo from '../components/AjustesReglas';
import Invitacion from '../components/Invitacion';
import Cabecera from '../components/Cabecera';

const TABS = [
  { key: 'hogar', label: 'Hogar' },
  { key: 'categorias', label: 'Categorías' },
  { key: 'fijos', label: 'Gastos fijos' },
  { key: 'gmail', label: 'Correo' },
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
      <Cabecera hogar="Ajustes" conModo={false} />

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => select(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'hogar' && <PanelHogar />}
      {tab === 'categorias' && <Categorias />}
      {tab === 'fijos' && <GastosFijos />}
      {tab === 'gmail' && <CorreoPanel />}
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

  async function save(patch: CambiosHogar) {
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
          <div style={{ marginTop: 14 }}>
            {code ? (
              <Invitacion code={code} onChanged={() => void load()} />
            ) : (
              <button
                className="primary"
                onClick={async () => {
                  const created = await api.invite();
                  setCode(created.code);
                }}
              >
                Generar invitación
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Fondo de contingencia</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Porcentaje extra sobre el gasto estimado que cada uno aporta —en su misma proporción— para imprevistos.
          Se acumula en la cuenta del hogar y no cuenta como gasto, así que no altera la liquidación del mes.
        </p>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Contingencia: {household.contingencyPct}%</span>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            defaultValue={household.contingencyPct}
            onChange={(e) => setHousehold({ ...household, contingencyPct: Number(e.target.value) })}
            onMouseUp={(e) => void save({ contingencyPct: Number((e.target as HTMLInputElement).value) })}
            onTouchEnd={(e) => void save({ contingencyPct: Number((e.target as HTMLInputElement).value) })}
          />
          <em className="muted">
            Con 10%, si el gasto estimado del mes es $1.000.000 se juntan $1.100.000 y quedan $100.000 de reserva.
          </em>
        </label>
      </div>

      <PanelCorreo household={household} onSave={save} />

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

      <PanelVersion />
    </>
  );
}

/**
 * Qué versión está corriendo. Con despliegue automático es la forma directa de
 * saber si un cambio ya llegó, sin tener que entrar al panel del servidor.
 */
function PanelVersion() {
  const [salud, setSalud] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [refrescando, setRefrescando] = useState(false);

  const consultar = () => api.health().then(setSalud).catch(() => setSalud(null));

  useEffect(() => {
    void consultar();
  }, []);

  if (!salud) return null;

  const desde = new Date(salud.desde);
  const minutos = Math.round((Date.now() - desde.getTime()) / 60000);
  const antiguedad =
    minutos < 60
      ? `hace ${minutos} min`
      : minutos < 60 * 24
        ? `hace ${Math.round(minutos / 60)} h`
        : `hace ${Math.round(minutos / 1440)} días`;

  return (
    <div className="card">
      <h2>Versión</h2>
      <div className="list">
        <div className="item">
          <div className="body">
            <div className="title">Versión publicada</div>
            <div className="meta">
              Compilada el {new Date(salud.compiladoEn).toLocaleDateString('es-CL')} · el servidor se reinició{' '}
              {antiguedad}
            </div>
          </div>
          <span className="pill num">{salud.build}</span>
        </div>
        <div className="item">
          <div className="body"><div className="title">Lectura de Gmail</div></div>
          <span className={`pill ${salud.gmail ? 'good' : ''}`}>{salud.gmail ? '● activa' : '○ sin configurar'}</span>
        </div>
        <div className="item">
          <div className="body"><div className="title">Envío de correo</div></div>
          <span className={`pill ${salud.correo ? 'good' : ''}`}>{salud.correo ? '● activo' : '○ sin configurar'}</span>
        </div>
      </div>

      <button
        className="small"
        style={{ marginTop: 10 }}
        disabled={refrescando}
        onClick={async () => {
          setRefrescando(true);
          await consultar();
          // Limpia la copia local del service worker y recarga, por si el
          // teléfono sigue mostrando una versión guardada.
          if ('serviceWorker' in navigator) {
            const registros = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registros.map((r) => r.update()));
          }
          window.location.reload();
        }}
      >
        {refrescando ? 'Buscando…' : 'Buscar actualizaciones'}
      </button>
    </div>
  );
}

/** Estado del correo y el resumen mensual automático. */
function PanelCorreo({
  household,
  onSave,
}: {
  household: Household;
  onSave: (patch: CambiosHogar) => Promise<void>;
}) {
  const [estado, setEstado] = useState<{ configured: boolean; from: string | null } | null>(null);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    void api.emailStatus().then(setEstado).catch(() => setEstado({ configured: false, from: null }));
  }, []);

  async function accion(fn: () => Promise<{ enviadoA: string }>, exito: (a: string) => string) {
    setOcupado(true);
    setAviso(null);
    try {
      const r = await fn();
      setAviso({ ok: true, texto: exito(r.enviadoA) });
    } catch (err) {
      setAviso({ ok: false, texto: (err as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  if (!estado) return null;

  return (
    <div className="card">
      <h2>Correo</h2>

      {!estado.configured ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            El servidor todavía no puede enviar correos, así que la invitación se comparte con el link o el QR, y no
            hay resumen mensual automático.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Para activarlo hay que definir <code>SMTP_HOST</code> y sus credenciales en el servidor. Los pasos están
            en el archivo <code>DEPLOY.md</code> del proyecto.
          </p>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Los correos salen desde <strong>{estado.from}</strong>.
          </p>

          {aviso && <div className={aviso.ok ? 'ok' : 'error'}>{aviso.texto}</div>}

          <label className="row" style={{ justifyContent: 'flex-start', gap: 10, margin: '12px 0' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={household.sendMonthlyReport === 1}
              onChange={(e) => void onSave({ sendMonthlyReport: e.target.checked })}
            />
            <span>
              <strong>Resumen mensual automático</strong>
              <div className="muted">
                A los primeros días de cada mes, les llega a ambos cómo cerró el mes anterior: gastos, quién puso
                cuánto, presupuestos excedidos y el fondo de reserva.
              </div>
            </span>
          </label>

          <div className="wrap">
            <button
              disabled={ocupado}
              onClick={() => void accion(() => api.sendTestEmail(), (a) => `Correo de prueba enviado a ${a}.`)}
            >
              Enviar correo de prueba
            </button>
            <button
              disabled={ocupado}
              onClick={() =>
                void accion(
                  () => api.sendTestReport(),
                  (a) => `Resumen del mes pasado enviado a ${a}. Así lo van a recibir.`,
                )
              }
            >
              Verme el resumen mensual
            </button>
          </div>
        </>
      )}
    </div>
  );
}

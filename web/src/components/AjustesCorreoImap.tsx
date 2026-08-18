import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type CuentaImap, type SyncResult } from '../lib/api';
import { useSession } from '../lib/session';
import ResultadoSincronizacion from './ResultadoSincronizacion';

/**
 * Conectar el buzón con una contraseña de aplicación.
 *
 * Es la forma recomendada de leer el correo del banco: a diferencia del permiso
 * de Google, no caduca a los siete días, y con la conexión abierta los gastos
 * entran apenas llega el aviso en vez de cuando uno se acuerda de sincronizar.
 */
export default function AjustesCorreoImap() {
  const currency = useSession().household?.currency ?? 'CLP';
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.imapStatus>> | null>(null);
  const [form, setForm] = useState({ email: '', secreto: '', avanzado: false, host: '', port: '', carpeta: '' });
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  async function load() {
    try {
      setStatus(await api.imapStatus());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function conectar(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAviso(null);
    try {
      const r = await api.conectarImap({
        email: form.email.trim(),
        secreto: form.secreto,
        host: form.host.trim() || undefined,
        port: form.port ? Number(form.port) : undefined,
        carpeta: form.carpeta.trim() || undefined,
      });
      setAviso(`Cuenta conectada. El buzón ${r.carpeta} tiene ${r.mensajes} correos.`);
      setForm({ email: '', secreto: '', avanzado: false, host: '', port: '', carpeta: '' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sincronizar(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.imapSync(dryRun));
      if (!dryRun) await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function desconectar(cuenta: CuentaImap) {
    if (!confirm(`¿Desconectar ${cuenta.email}? Los movimientos ya importados se quedan.`)) return;
    await api.desconectarImap(cuenta.id);
    await load();
  }

  const hayCuentas = (status?.accounts.length ?? 0) > 0;

  return (
    <>
      {aviso && <div className="ok">{aviso}</div>}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Leer el correo del banco</h2>
          {status?.tiempoReal && <span className="pill good">tiempo real</span>}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Con una <strong>contraseña de aplicación</strong> la app queda escuchando el buzón y los avisos de compra
          se convierten en movimientos apenas llegan. No caduca, a diferencia del permiso de Google.
        </p>

        <div className="list">
          {status?.accounts.map((cuenta) => (
            <div className="item" key={cuenta.id}>
              <div className="body">
                <div className="title">
                  {cuenta.email}
                  {cuenta.escuchando && <span className="pill good" style={{ marginLeft: 6 }}>escuchando</span>}
                </div>
                <div className="meta">
                  {cuenta.lastSyncAt ? `Última sincronización: ${cuenta.lastSyncAt}` : 'Nunca sincronizada'}
                  {cuenta.host !== 'imap.gmail.com' && ` · ${cuenta.host}:${cuenta.port}`}
                </div>
              </div>
              <button className="small danger ghost" onClick={() => void desconectar(cuenta)}>
                Desconectar
              </button>
            </div>
          ))}
          {status && !hayCuentas && <p className="muted">No hay ninguna cuenta conectada todavía.</p>}
        </div>

        {hayCuentas && (
          <div className="wrap" style={{ marginTop: 12 }}>
            <button disabled={busy} onClick={() => void sincronizar(true)}>
              {busy ? 'Procesando…' : 'Simular (sin guardar)'}
            </button>
            <button disabled={busy} onClick={() => void sincronizar(false)}>
              Sincronizar ahora
            </button>
          </div>
        )}

        {hayCuentas && status?.tiempoReal && (
          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
            No hace falta sincronizar a mano: los correos entran solos. Estos botones sirven para traer lo que ya
            estaba en el buzón o para probar una regla recién ajustada.
          </p>
        )}
      </div>

      <div className="card">
        <h2>{hayCuentas ? 'Conectar otra cuenta' : 'Conectar la cuenta'}</h2>

        <ol className="muted" style={{ paddingLeft: 20, marginTop: 0 }}>
          <li>
            En tu cuenta de Google, activa la <strong>verificación en dos pasos</strong> si no la tienes.
          </li>
          <li>
            Entra a{' '}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>{' '}
            y genera una contraseña de aplicación.
          </li>
          <li>Pégala acá abajo. Son 16 letras; los espacios da lo mismo.</li>
        </ol>

        <form onSubmit={conectar}>
          <label className="field">
            <span>Correo</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="tucorreo@gmail.com"
              autoComplete="username"
              required
            />
          </label>

          <label className="field">
            <span>Contraseña de aplicación</span>
            <input
              type="password"
              value={form.secreto}
              onChange={(e) => setForm({ ...form, secreto: e.target.value })}
              placeholder="abcd efgh ijkl mnop"
              autoComplete="new-password"
              required
            />
          </label>

          <p className="muted" style={{ marginTop: 0 }}>
            No es la contraseña de tu cuenta. Se guarda cifrada y sólo se usa para leer el buzón.
          </p>

          {!form.avanzado ? (
            <button type="button" className="small ghost" onClick={() => setForm({ ...form, avanzado: true })}>
              No uso Gmail
            </button>
          ) : (
            <div className="grid2">
              <label className="field">
                <span>Servidor IMAP</span>
                <input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder={status?.porDefecto.host ?? 'imap.gmail.com'}
                />
              </label>
              <label className="field">
                <span>Puerto</span>
                <input
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  inputMode="numeric"
                  placeholder={String(status?.porDefecto.port ?? 993)}
                />
              </label>
              <label className="field">
                <span>Carpeta</span>
                <input
                  value={form.carpeta}
                  onChange={(e) => setForm({ ...form, carpeta: e.target.value })}
                  placeholder={status?.porDefecto.carpeta ?? 'INBOX'}
                />
              </label>
            </div>
          )}

          <button className="primary" disabled={busy} style={{ width: '100%', marginTop: 10 }}>
            {busy ? 'Probando la conexión…' : 'Conectar'}
          </button>
        </form>

        <p className="muted" style={{ marginBottom: 0 }}>
          La contraseña se prueba contra el servidor antes de guardarla, así que si algo está mal te enteras acá.
        </p>
      </div>

      {result && <ResultadoSincronizacion result={result} currency={currency} />}

      {hayCuentas && (
        <div className="card">
          <h2>Y ahora, las reglas</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Conectar el buzón no basta: falta decirle qué correos leer. En{' '}
            <Link to="/ajustes/reglas">Reglas de correo</Link> activas la plantilla de tu banco y la pruebas con un
            correo real.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Cada movimiento queda amarrado al identificador del correo, así que sincronizar de nuevo nunca duplica.
          </p>
        </div>
      )}
    </>
  );
}

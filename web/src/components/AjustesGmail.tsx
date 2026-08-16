import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SyncResult } from '../lib/api';

export default function AjustesGmail() {
  const [params] = useSearchParams();
  const justConnected = params.get('conectado');
  const [status, setStatus] = useState<{
    configured: boolean;
    accounts: { id: string; email: string; lastSyncAt: string | null }[];
    pendingReview: number;
  } | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setStatus(await api.gmailStatus());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect() {
    setError(null);
    try {
      const { url } = await api.gmailAuthUrl();
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sync() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.gmailSync());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {justConnected && <div className="ok">Cuenta {justConnected} conectada.</div>}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2>Correos del banco</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          La app lee la bandeja de entrada <strong>sólo de lectura</strong> y únicamente los correos que calzan con las
          reglas que definas. Con eso arma los movimientos de la cuenta y las tarjetas del hogar.
        </p>

        {status && !status.configured && (
          <div className="error">
            El servidor no tiene credenciales de Google configuradas. Hay que definir <code>GOOGLE_CLIENT_ID</code> y{' '}
            <code>GOOGLE_CLIENT_SECRET</code> en <code>server/.env</code> (los pasos están en el README).
          </div>
        )}

        <div className="list">
          {status?.accounts.map((account) => (
            <div className="item" key={account.id}>
              <div className="body">
                <div className="title">{account.email}</div>
                <div className="meta">
                  {account.lastSyncAt ? `Última sincronización: ${account.lastSyncAt}` : 'Nunca sincronizada'}
                </div>
              </div>
              <button
                className="small danger ghost"
                onClick={async () => {
                  if (!confirm(`¿Desconectar ${account.email}?`)) return;
                  await api.disconnectGmail(account.id);
                  await load();
                }}
              >
                Desconectar
              </button>
            </div>
          ))}
          {status?.accounts.length === 0 && <p className="muted">No hay cuentas conectadas todavía.</p>}
        </div>

        <div className="wrap" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void connect()} disabled={!status?.configured}>
            Conectar una cuenta de Gmail
          </button>
          <button onClick={() => void sync()} disabled={busy || !status?.accounts.length}>
            {busy ? 'Sincronizando…' : 'Sincronizar ahora'}
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <h2>Resultado de la sincronización</h2>
          <div className="list">
            <div className="item">
              <div className="body"><div className="title">Correos revisados</div></div>
              <div className="amount">{result.scanned}</div>
            </div>
            <div className="item">
              <div className="body"><div className="title">Movimientos nuevos</div></div>
              <div className="amount">{result.imported}</div>
            </div>
            <div className="item">
              <div className="body">
                <div className="title">Omitidos</div>
                <div className="meta">Repetidos o que no calzaron con ninguna regla</div>
              </div>
              <div className="amount">{result.skipped}</div>
            </div>
          </div>

          {Object.keys(result.byRule).length > 0 && (
            <table className="data" style={{ marginTop: 10 }}>
              <thead><tr><th>Regla</th><th>Importados</th></tr></thead>
              <tbody>
                {Object.entries(result.byRule).map(([rule, count]) => (
                  <tr key={rule}><td>{rule}</td><td className="num">{count}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          {result.errors.length > 0 && (
            <div className="error" style={{ marginTop: 10 }}>
              <strong>Avisos:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {result.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            </div>
          )}

          {result.imported > 0 && (
            <p style={{ marginBottom: 0 }}>
              <Link to="/movimientos?pendientes=1">Revisar los {result.imported} movimientos importados →</Link>
            </p>
          )}
        </div>
      )}

      {status && status.pendingReview > 0 && (
        <div className="card">
          <div className="row">
            <span>{status.pendingReview} movimientos importados esperan revisión.</span>
            <Link to="/movimientos?pendientes=1"><button className="small">Revisar</button></Link>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Cómo funciona</h2>
        <ol style={{ paddingLeft: 20, margin: 0 }} className="muted">
          <li>Conecta la cuenta de Gmail donde llegan los avisos del banco.</li>
          <li>En «Reglas de correo» activas la de tu banco y la ajustas con un correo real de ejemplo.</li>
          <li>Sincronizas: cada correo que calza se transforma en un movimiento, ya categorizado si hay regla.</li>
          <li>Revisas lo importado y confirmas qué es común y qué es personal.</li>
        </ol>
        <p className="muted" style={{ marginBottom: 0 }}>
          Los correos ya importados no se duplican: cada movimiento queda amarrado al id del mensaje.
        </p>
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SyncResult } from '../lib/api';
import ResultadoSincronizacion from './ResultadoSincronizacion';
import { useSession } from '../lib/session';
import { money } from '../lib/format';

export default function AjustesGmail() {
  const currency = useSession().household?.currency ?? 'CLP';
  const [params] = useSearchParams();
  const justConnected = params.get('conectado');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.gmailStatus>> | null>(null);
  const [copiada, setCopiada] = useState(false);
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

  async function sync(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.gmailSync(dryRun));
      if (!dryRun) await load();
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
          <>
            <div className="error">
              Todavía no están las credenciales de Google. Se configuran en el servidor: si la app está publicada, en
              el panel del proveedor (en Render: pestaña <strong>Environment</strong>); si corre en tu computador, en{' '}
              <code>server/.env</code>. El paso a paso está en <code>CORREO.md</code>.
            </div>

            <div className="card" style={{ background: 'var(--plane)', boxShadow: 'none' }}>
              <div className="label" style={{ marginBottom: 6 }}>URI de redirección</div>
              <p className="muted" style={{ marginTop: 0 }}>
                Pega exactamente esto en Google Cloud, en «URI de redirección autorizados». Un carácter distinto y
                Google rechaza la autorización.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <code style={{ fontSize: '0.76rem', wordBreak: 'break-all', flex: 1 }}>{status.redirectUri}</code>
                <button
                  className="small"
                  style={{ flex: 'none' }}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(status.redirectUri);
                      setCopiada(true);
                      setTimeout(() => setCopiada(false), 2000);
                    } catch {
                      window.prompt('Copia esta dirección:', status.redirectUri);
                    }
                  }}
                >
                  {copiada ? '✓' : 'Copiar'}
                </button>
              </div>
            </div>
          </>
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
          <button onClick={() => void sync(true)} disabled={busy || !status?.accounts.length}>
            {busy ? 'Procesando…' : 'Simular (sin guardar)'}
          </button>
          <button onClick={() => void sync(false)} disabled={busy || !status?.accounts.length}>
            Sincronizar de verdad
          </button>
        </div>
        {status && status.accounts.length > 0 && (
          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
            La primera vez conviene <strong>simular</strong>: procesa los correos y te muestra qué crearía, sin
            escribir nada en la app.
          </p>
        )}
      </div>

      {result && <ResultadoSincronizacion result={result} currency={currency} />}

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

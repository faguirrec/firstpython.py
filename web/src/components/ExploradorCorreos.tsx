import { useState } from 'react';
import { api, type MessagePreview } from '../lib/api';
import Sheet from './Sheet';

/**
 * Buscador sobre la bandeja conectada. Sirve para el paso más difícil de
 * configurar: descubrir de qué dirección y con qué asunto llegan realmente los
 * avisos del banco, y llevarse el texto de uno al probador de reglas.
 */
export default function ExploradorCorreos({
  onUseMessage,
  onClose,
}: {
  onUseMessage: (body: string, subject: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('newer_than:30d (compra OR cargo OR transferencia)');
  const [messages, setMessages] = useState<MessagePreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const SUGGESTIONS = [
    { label: 'Últimos 30 días con montos', q: 'newer_than:30d (compra OR cargo OR transferencia)' },
    { label: 'Sólo Banco de Chile', q: 'from:bancochile.cl newer_than:60d' },
    { label: 'Sólo Santander', q: 'from:santander.cl newer_than:60d' },
    { label: 'Sólo BCI', q: 'from:bci.cl newer_than:60d' },
    { label: 'Sólo BancoEstado', q: 'from:bancoestado.cl newer_than:60d' },
    { label: 'Transferencias recibidas', q: 'subject:(transferencia OR abono) newer_than:60d' },
  ];

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.gmailSearch(query, 15);
      setMessages(result.messages);
      if (result.errors.length > 0) setError(result.errors.join(' · '));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function use(message: MessagePreview) {
    setLoadingId(message.id);
    setError(null);
    try {
      const full = await api.gmailMessage(message.id);
      onUseMessage(full.body, full.subject);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <Sheet title="Explorar correos" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Busca en la cuenta conectada para ver de qué dirección llegan los avisos de tu banco. Después toca
        «Usar este» y su texto se carga en el probador de reglas.
      </p>

      <label className="field">
        <span>Búsqueda de Gmail</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      <div className="wrap" style={{ marginBottom: 10 }}>
        {SUGGESTIONS.map((s) => (
          <button key={s.label} className="small ghost" onClick={() => setQuery(s.q)}>
            {s.label}
          </button>
        ))}
      </div>

      <button className="primary" onClick={() => void search()} disabled={busy}>
        {busy ? 'Buscando…' : 'Buscar'}
      </button>

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      {messages && (
        <div style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>{messages.length} correos encontrados</h3>
          </div>
          {messages.length === 0 && (
            <p className="muted">
              Sin resultados. Prueba ampliando el rango (<code>newer_than:90d</code>) o quitando filtros.
            </p>
          )}
          <div className="list">
            {messages.map((m) => (
              <div className="item" key={m.id}>
                <div className="body">
                  <div className="title">{m.subject || '(sin asunto)'}</div>
                  <div className="meta una-linea">{m.from}</div>
                  <div className="meta una-linea">{m.snippet}</div>
                  {m.alreadyImported && <span className="pill good">ya importado</span>}
                </div>
                <div className="actions">
                  <button className="small" onClick={() => void use(m)} disabled={loadingId === m.id}>
                    {loadingId === m.id ? '…' : 'Usar este'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}

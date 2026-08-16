import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export default function Acceso() {
  const { refresh } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await api.login(email, password);
      else await api.register(email, password, name);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div style={{ height: 24 }} />
      <h1>Cuentas del Hogar</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 18 }}>
        Los gastos comunes repartidos según lo que gana cada uno.
      </p>

      <div className="card">
        <div className="tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Entrar
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Crear cuenta
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={submit}>
          {mode === 'register' && (
            <label className="field">
              <span>Tu nombre</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana" autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span>Correo</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              inputMode="email"
            />
          </label>
          <label className="field">
            <span>Contraseña {mode === 'register' && <em className="muted">(mínimo 8 caracteres)</em>}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          <button className="primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>
        </form>
      </div>

      <p className="muted">
        En el iPhone: abre esta página en Safari, toca Compartir y luego «Agregar a pantalla de inicio» para usarla
        como app.
      </p>
    </div>
  );
}

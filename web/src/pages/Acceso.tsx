import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Logo } from '../components/Icons';

export default function Acceso() {
  const { refresh } = useSession();
  const { code: codeFromUrl } = useParams<{ code: string }>();

  // Quien llega por un link de invitación viene a crear cuenta, no a entrar.
  const [mode, setMode] = useState<'login' | 'register'>(codeFromUrl ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState(codeFromUrl?.toUpperCase() ?? '');
  const [invite, setInvite] = useState<{ householdName: string; invitedBy: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Con un código en la URL se muestra a qué hogar invitan, antes de pedir datos.
  useEffect(() => {
    if (!codeFromUrl) return;
    void api
      .invitePreview(codeFromUrl)
      .then(setInvite)
      .catch((err: Error) => setInviteError(err.message));
  }, [codeFromUrl]);

  const weak = mode === 'register' && password.length > 0 && password.length < 8;
  const mismatch = mode === 'register' && confirm.length > 0 && password !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (mode === 'register' && password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'login') {
        await api.login(email, password);
      } else {
        await api.register({
          email,
          password,
          name: name.trim(),
          inviteCode: inviteCode.trim() || undefined,
        });
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div style={{ display: 'grid', placeItems: 'center', gap: 12, padding: '32px 0 20px' }}>
        <Logo size={68} />
        <h1 style={{ textAlign: 'center' }}>MyHaus</h1>
        <p className="muted" style={{ margin: 0, textAlign: 'center', maxWidth: '30ch' }}>
          Los gastos de la casa repartidos según lo que gana cada uno.
        </p>
      </div>

      {invite && (
        <div className="ok">
          <strong>{invite.invitedBy}</strong> te invitó a administrar <strong>{invite.householdName}</strong>.
          Crea tu cuenta y quedan conectados.
        </div>
      )}
      {inviteError && (
        <div className="error">
          {inviteError}. Puedes crear tu cuenta igual y pedirle un código nuevo.
        </div>
      )}

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
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ana"
                autoComplete="name"
                required
              />
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
            <span>Contraseña</span>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                style={{ paddingRight: 64 }}
              />
              <button
                type="button"
                className="ghost small"
                onClick={() => setShowPassword((v) => !v)}
                style={{ position: 'absolute', right: 4, top: 3, minHeight: 34, border: 'none' }}
              >
                {showPassword ? 'ocultar' : 'ver'}
              </button>
            </div>
            {weak && <em className="muted">Faltan {8 - password.length} caracteres para el mínimo.</em>}
          </label>

          {mode === 'register' && (
            <>
              <label className="field">
                <span>Repite la contraseña</span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                {mismatch && <em style={{ color: 'var(--critical)', fontSize: '0.78rem' }}>No coinciden.</em>}
              </label>

              {!codeFromUrl && (
                <label className="field">
                  <span>Código de invitación <em className="muted">(si te invitaron)</em></span>
                  <input
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="AB12CD"
                    maxLength={8}
                    autoCapitalize="characters"
                  />
                </label>
              )}
            </>
          )}

          <button className="primary" style={{ width: '100%' }} disabled={busy || mismatch}>
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

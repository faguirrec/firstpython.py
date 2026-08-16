import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

/** Onboarding: el primero crea el hogar, el segundo entra con el código. */
export default function Hogar() {
  const { user, refresh, signOut } = useSession();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('Nuestra casa');
  const [currency, setCurrency] = useState('CLP');
  const [officialAccount, setOfficialAccount] = useState('Cuenta del hogar');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'create') await api.createHousehold({ name, currency, officialAccount });
      else await api.joinHousehold(code);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>Hola, {user?.name}</h1>
          <div className="sub">Falta un paso: tu hogar.</div>
        </div>
        <button className="ghost small" onClick={() => void signOut()}>Salir</button>
      </div>

      <div className="card">
        <div className="tabs">
          <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>
            Crear hogar
          </button>
          <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
            Unirme con código
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={submit}>
          {mode === 'create' ? (
            <>
              <label className="field">
                <span>Nombre del hogar</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="field">
                <span>Cuenta oficial: de dónde salen los gastos comunes</span>
                <input
                  value={officialAccount}
                  onChange={(e) => setOfficialAccount(e.target.value)}
                  placeholder="Cuenta corriente Banco de Chile ****1234"
                />
              </label>
              <label className="field">
                <span>Moneda</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="CLP">CLP — peso chileno</option>
                  <option value="ARS">ARS — peso argentino</option>
                  <option value="COP">COP — peso colombiano</option>
                  <option value="MXN">MXN — peso mexicano</option>
                  <option value="PEN">PEN — sol peruano</option>
                  <option value="USD">USD — dólar</option>
                  <option value="EUR">EUR — euro</option>
                </select>
              </label>
              <p className="muted" style={{ marginTop: 0 }}>
                Después vas a poder invitar a la otra persona con un código de 6 caracteres.
              </p>
            </>
          ) : (
            <label className="field">
              <span>Código de invitación</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="AB12CD"
                maxLength={8}
                autoCapitalize="characters"
                required
              />
            </label>
          )}

          <button className="primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Un momento…' : mode === 'create' ? 'Crear hogar' : 'Unirme'}
          </button>
        </form>
      </div>
    </div>
  );
}

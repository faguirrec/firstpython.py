import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Reserve, type Settlement } from '../lib/api';
import { money, monthLabel } from '../lib/format';

/**
 * Cuánta plata debería haber en la cuenta del hogar.
 *
 * Es el número con el que se cuadra contra la cartola del banco, y no estaba en
 * ninguna parte: existía como "fondo de reserva", que se lee como un ahorro y no
 * como un saldo, y como una línea gris al pie de la liquidación.
 *
 * Acá se dice primero el hecho —esto debería estar en el banco— y después su
 * interpretación: cuánto de eso está prometido como crédito, cuánto queda libre
 * y cuántos meses cubre. El orden importa: si el saldo no cuadra con el banco,
 * lo primero es saberlo, no saber cuántos meses de colchón hay.
 */
export default function SaldoCuenta({
  reserve,
  settlement,
  month,
  currency,
  cuenta,
  compacto = false,
  onCuadrado,
}: {
  reserve: Reserve;
  settlement: Settlement | null;
  month: string;
  currency: string;
  cuenta: string;
  compacto?: boolean;
  /** Se llama tras cuadrar, para que la pantalla recargue sus cifras. */
  onCuadrado?: () => void;
}) {
  const [saldoReal, setSaldoReal] = useState('');
  const [cuadrando, setCuadrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const declarado = Number(saldoReal.replace(/[^\d.-]/g, ''));
  const hayCifra = saldoReal.trim() !== '' && Number.isFinite(declarado);
  const diferencia = hayCifra ? declarado - reserve.balance : 0;
  const delMes = reserve.history.find((h) => h.month === month);
  const entro = delMes?.contributed ?? 0;
  const salio = delMes?.spent ?? 0;
  // Lo que traía antes de este mes: el saldo de hoy menos lo que se movió acá.
  const anterior = reserve.balance - (entro - salio);

  if (compacto) {
    return (
      <div className="card">
        <div className="card-head">
          {/* El nombre de la cuenta va en el texto y no en el título: quedaba
              "En Cuenta corriente del hogar", con una mayúscula a mitad de
              frase que se lee como un error. */}
          <h2>La cuenta del hogar</h2>
          <Link to="/liquidacion" className="muted">Ver detalle →</Link>
        </div>
        <div className="cifra-md num">{money(reserve.balance, currency)}</div>
        <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
          Lo que debería haber en {cuenta}: todo lo depositado menos todo lo pagado con ella.
          {reserve.committed > 0 && (
            <> De eso, {money(reserve.committed, currency)} están prometidos como crédito.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>La cuenta del hogar</h2>
        {reserve.monthsCovered > 0 && (
          <span className={`pill ${reserve.monthsCovered >= 1 ? 'good' : 'warn'}`}>
            {reserve.monthsCovered} {reserve.monthsCovered === 1 ? 'mes' : 'meses'} de gastos
          </span>
        )}
      </div>

      <div className="label">Debería tener hoy</div>
      <div className="hero num">{money(reserve.balance, currency)}</div>
      <p className="muted" style={{ marginTop: 4 }}>
        Todo lo depositado en {cuenta} menos todo lo que se pagó con ella. Es el número que tiene
        que cuadrar con la cartola.
      </p>

      <div className="cuenta-detalle">
        {reserve.adjustment !== 0 && (
          <div>
            <span>Ya estaba en la cuenta al empezar</span>
            <strong className="num">{money(reserve.adjustment, currency)}</strong>
          </div>
        )}
        <div>
          <span>Venía de antes de {monthLabel(month, true)}</span>
          <strong className="num">{money(anterior, currency)}</strong>
        </div>
        <div>
          <span>Entró en {monthLabel(month, true)}</span>
          <strong className="num" style={{ color: 'var(--good-text)' }}>+{money(entro, currency)}</strong>
        </div>
        <div>
          <span>Salió en {monthLabel(month, true)}</span>
          {/* Sin rojo: que salga plata de la cuenta del hogar es para lo que
              está la cuenta. El signo menos ya dice todo lo que hay que decir. */}
          <strong className="num">−{money(salio, currency)}</strong>
        </div>
      </div>

      {reserve.committed > 0 && (
        <div className="cuenta-detalle" style={{ marginTop: 12 }}>
          <div>
            <span>Prometido como crédito</span>
            <strong className="num">−{money(reserve.committed, currency)}</strong>
          </div>
          <div>
            <span>Libre para metas de ahorro</span>
            <strong className="num">{money(reserve.free, currency)}</strong>
          </div>
        </div>
      )}

      {/*
        * Cuadrar contra la cartola.
        *
        * La app suma desde cero el día que el hogar empezó a usarla, así que si
        * la cuenta ya tenía plata, el número queda corrido para siempre y no
        * había dónde decirlo. Esto guarda la diferencia como ajuste; no es
        * aporte de nadie y no toca la liquidación.
        */}
      <details className="plegable" style={{ marginTop: 16 }}>
        <summary>
          <strong>Cuadrar con el banco</strong>
          <span className="resumen-dato">
            {reserve.adjustment !== 0
              ? ` · ajustado en ${money(reserve.adjustment, currency)}`
              : ' · nunca se ha cuadrado'}
          </span>
        </summary>

        <p className="muted" style={{ marginTop: 8 }}>
          Entra a tu banco y escribe el saldo que aparece ahí. La diferencia queda anotada como
          ajuste, para que de aquí en adelante los dos números coincidan.
        </p>

        <label className="field">
          <span>¿Cuánto dice el banco?</span>
          <input
            inputMode="decimal"
            value={saldoReal}
            onChange={(e) => setSaldoReal(e.target.value)}
            placeholder="131000"
          />
        </label>

        {hayCifra && Math.abs(diferencia) >= 1 && (
          <p className="muted" style={{ marginTop: 0 }}>
            Faltan {money(Math.abs(diferencia), currency)}{' '}
            {diferencia > 0 ? 'por sumar' : 'por restar'}. Lo más común es que sean movimientos que
            todavía no entraron —las compras con tarjeta, si el correo del banco no se está
            leyendo— o plata que ya estaba en la cuenta antes de usar la app.
          </p>
        )}

        {error && <div className="error">{error}</div>}

        <button
          className="small"
          disabled={!hayCifra || cuadrando}
          onClick={async () => {
            setCuadrando(true);
            setError(null);
            try {
              await api.cuadrarCuenta(declarado);
              setSaldoReal('');
              onCuadrado?.();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setCuadrando(false);
            }
          }}
        >
          {cuadrando ? 'Cuadrando…' : 'Anotar la diferencia'}
        </button>

        {reserve.adjustment !== 0 && (
          <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Hoy hay {money(reserve.adjustment, currency)} de ajuste
            {reserve.adjustedAt && `, anotados el ${reserve.adjustedAt.slice(0, 10)}`}. Se suma al
            saldo pero no le cuenta a ninguno de los dos en el reparto.
          </p>
        )}
      </details>

      {settlement && Math.abs(settlement.officialAccountBalance) >= 1 && (
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          {settlement.officialAccountBalance > 0
            ? `En ${monthLabel(month, true)} entró ${money(settlement.officialAccountBalance, currency)} más de lo que salió.`
            : `En ${monthLabel(month, true)} salió ${money(-settlement.officialAccountBalance, currency)} más de lo que entró: se usó saldo de meses anteriores.`}
        </p>
      )}
    </div>
  );
}

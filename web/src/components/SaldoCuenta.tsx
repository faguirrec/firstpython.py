import { Link } from 'react-router-dom';
import { money, monthLabel } from '../lib/format';
import type { Reserve, Settlement } from '../lib/api';

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
}: {
  reserve: Reserve;
  settlement: Settlement | null;
  month: string;
  currency: string;
  cuenta: string;
  compacto?: boolean;
}) {
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
          <strong className="num" style={{ color: salio > 0 ? 'var(--critical)' : undefined }}>
            −{money(salio, currency)}
          </strong>
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

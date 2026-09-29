import { Link } from 'react-router-dom';
import { type SyncResult } from '../lib/api';
import { money } from '../lib/format';

/**
 * El resultado de una sincronización de correo.
 *
 * Es el mismo panel para las dos formas de leer el buzón —IMAP y la API de
 * Gmail—, porque lo que se muestra no depende de por dónde llegaron los
 * correos: cuántos se revisaron, qué se crearía y con qué regla.
 */
export default function ResultadoSincronizacion({
  result,
  currency,
}: {
  result: SyncResult;
  currency: string;
}) {
  return (
      <div className="card">
        <div className="card-head">
          <h2>{result.dryRun ? 'Simulación' : 'Resultado de la sincronización'}</h2>
          {result.dryRun && <span className="pill warn">no se guardó nada</span>}
        </div>
        <div className="list">
          <div className="item">
            <div className="body"><div className="title">Correos revisados</div></div>
            <div className="amount">{result.scanned}</div>
          </div>
          <div className="item">
            <div className="body">
              <div className="title">{result.dryRun ? 'Se crearían' : 'Movimientos nuevos'}</div>
            </div>
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

        {result.preview.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h3>Qué se crearía</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Revisa que los montos y comercios estén bien. Si algo sale mal, ajusta la regla antes de sincronizar
              de verdad.
            </p>
            <div className="list">
              {result.preview.slice(0, 40).map((p, i) => (
                <div className="item" key={`${p.subject}-${i}`}>
                  <div className="body">
                    <div className="title">
                      {p.merchant ?? <em className="muted">sin comercio detectado</em>}
                      {p.duplicate && <span className="pill" style={{ marginLeft: 6 }}>ya existe</span>}
                    </div>
                    <div className="meta">{p.occurredOn} · {p.rule}</div>
                    <div className="meta">{p.subject}</div>
                  </div>
                  <div className="amount">{money(p.amount, currency)}</div>
                </div>
              ))}
            </div>
            {result.preview.length > 40 && (
              <p className="muted">…y {result.preview.length - 40} más.</p>
            )}
          </div>
        )}

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

        {result.dryRun ? (
          <p style={{ marginBottom: 0, marginTop: 10 }}>
            Si el resultado se ve bien, usa <strong>Sincronizar de verdad</strong> para guardarlos.
          </p>
        ) : (
          result.imported > 0 && (
            <p style={{ marginBottom: 0 }}>
              <Link to="/movimientos?pendientes=1">Revisar los {result.imported} movimientos importados →</Link>
            </p>
          )
        )}
      </div>
  );
}

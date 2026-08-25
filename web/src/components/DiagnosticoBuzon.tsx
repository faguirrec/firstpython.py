import { useState } from 'react';
import { api, type DiagnosticoBuzon as Diagnostico } from '../lib/api';

/**
 * "¿Por qué no entra nada?", contestado correo por correo.
 *
 * La sincronización decía "0 movimientos" y ahí se acababa la conversación,
 * con cuatro causas posibles detrás del mismo síntoma: el buzón que no conecta,
 * la búsqueda de la regla que no alcanza el correo, un filtro de texto que lo
 * descarta, o la expresión del monto que no encuentra el número. Esto las
 * separa.
 *
 * Mira los últimos correos del buzón **sin** filtrar por la búsqueda de ninguna
 * regla, justamente porque esa búsqueda puede ser el problema.
 */
export default function DiagnosticoBuzon() {
  const [datos, setDatos] = useState<Diagnostico | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revisar() {
    setCargando(true);
    setError(null);
    try {
      setDatos(await api.imapDiagnostico());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="card">
      <h3>¿Por qué no entra nada?</h3>
      <p className="muted" style={{ marginTop: 4 }}>
        Revisa los últimos correos del buzón y dice, uno por uno, qué hizo cada regla activa con
        él. No guarda ni modifica nada.
      </p>

      <button onClick={() => void revisar()} disabled={cargando}>
        {cargando ? 'Revisando el buzón…' : 'Revisar'}
      </button>

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      {datos && (
        <div style={{ marginTop: 12 }}>
          {datos.errores.map((e) => (
            <div className="error" key={e}>{e}</div>
          ))}

          <p className="muted">
            {datos.cuentas.length > 0
              ? `Buzón: ${datos.cuentas.join(', ')}.`
              : 'Ninguna cuenta de correo conectada.'}{' '}
            {datos.reglasActivas.length > 0
              ? `${datos.reglasActivas.length} regla(s) activa(s).`
              : 'Ninguna regla activa: aunque el buzón esté conectado, no hay nada que interprete los correos.'}
            {datos.reglasInactivas.length > 0 && ` ${datos.reglasInactivas.length} apagada(s).`}
          </p>

          {datos.correos.length === 0 && datos.cuentas.length > 0 && (
            <p className="muted">
              No hay correos de los últimos 30 días en la carpeta que la app está mirando. Si tus
              avisos llegan a otra carpeta o con una etiqueta, hay que cambiarla al conectar la
              cuenta.
            </p>
          )}

          <div className="list">
            {datos.correos.map((correo) => {
              const tomado = correo.reglas.find((r) => r.resultado === 'calza');
              return (
                <details className="plegable" key={`${correo.date}${correo.subject}`}>
                  <summary>
                    <strong>{correo.subject || '(sin asunto)'}</strong>
                    <span className="resumen-dato">
                      {tomado
                        ? correo.yaImportado
                          ? ` · lo toma «${tomado.regla}», ya está importado`
                          : ` · lo tomaría «${tomado.regla}»`
                        : ' · ninguna regla lo toma'}
                    </span>
                  </summary>

                  <p className="muted" style={{ margin: '4px 0 8px' }}>
                    De {correo.from} · {correo.date.slice(0, 10)}
                  </p>

                  {correo.reglas.length === 0 && <p className="muted">No hay reglas activas.</p>}

                  <ul className="motivos">
                    {correo.reglas.map((r) => (
                      <li key={r.regla} className={r.resultado}>
                        <strong>{r.regla}</strong>
                        {r.resultado === 'calza' ? ' — lo toma.' : ` — ${r.motivo}`}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

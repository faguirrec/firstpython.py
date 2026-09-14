import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CierreDelMes } from '../lib/api';
import { useSession } from '../lib/session';
import { useVersionDatos } from '../lib/datos';
import { diaLargo, money, monthLabel } from '../lib/format';
import { verCategoria } from '../lib/verCategoria';
import { Avatar, FichaCategoria } from './Fichas';
import Sheet from './Sheet';

/**
 * El mes, para leerlo de a dos antes de cerrarlo.
 *
 * Cerrar el mes era un botón que congelaba un número. Pero ese momento —dos
 * personas sentadas mirando la plata de los dos— es el único del ciclo que la
 * app no estaba aprovechando, y es justo donde las apps de pareja que funcionan
 * ponen su mejor carta: Zeta lo llama "money date" y hasta le pone guía de
 * conversación.
 *
 * Acá no hay dato nuevo: todo esto ya estaba en Análisis, repartido en cuatro
 * pantallas de gráficos que hay que ir a buscar. Lo que cambia es que se lee
 * de corrido, en frases, y termina en la única pregunta que importa —¿lo
 * cerramos?—.
 *
 * Deliberadamente no recomienda nada. No dice "podrían gastar menos en
 * supermercado": dice cuánto fue y cuánto era antes. La conversación es de
 * ellos; la app pone los datos sobre la mesa y se calla.
 */
export default function CitaDelMes({
  month,
  onClose,
  onCerrar,
}: {
  month: string;
  onClose: () => void;
  /** Llevar al paso de cerrar, que sigue siendo una decisión aparte. */
  onCerrar: () => void;
}) {
  const { user, household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const version = useVersionDatos();
  const [datos, setDatos] = useState<CierreDelMes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .cierreDelMes(month)
      .then(setDatos)
      .catch((err: Error) => setError(err.message));
  }, [month, version]);

  /** Contra qué se compara, dicho como lo diría una persona. */
  const contra =
    datos == null
      ? ''
      : datos.mesesDeHistoria === 1
        ? monthLabel(datos.previousMonth)
        : `el promedio de los últimos ${datos.mesesDeHistoria} meses`;

  return (
    <Sheet title={`El mes de ${monthLabel(month)}`} onClose={onClose}>
      {error && <div className="error">{error}</div>}
      {!datos && !error && <p className="muted">Armando el resumen del mes…</p>}

      {datos && (
        <div className="cita">
          {/* Lo que costó, y contra qué se compara. Es la primera pregunta que
              se hacen los dos y merece el tamaño que tiene. */}
          <section className="cita-bloque">
            <p className="label">El mes costó</p>
            <p className="hero num">{money(datos.total, currency)}</p>
            {datos.mesesDeHistoria > 0 ? (
              <p className="muted">
                {/* Con un solo mes atrás no hay "promedio de los últimos 1 meses":
                    hay el mes anterior, y hay que decirlo así. */}
                {Math.abs(datos.contraPromedio) < datos.promedio * 0.03 ? (
                  <>Casi lo mismo que {contra}.</>
                ) : datos.contraPromedio > 0 ? (
                  <>{money(datos.contraPromedio, currency)} más que {contra}.</>
                ) : (
                  <>{money(-datos.contraPromedio, currency)} menos que {contra}.</>
                )}
              </p>
            ) : (
              <p className="muted">Es el primer mes con datos, así que todavía no hay con qué compararlo.</p>
            )}
          </section>

          {/* Qué se movió. Sólo si el movimiento es real: nombrar una variación
              de mil pesos convierte el resumen en ruido. */}
          {(datos.subio || datos.bajo) && (
            <section className="cita-bloque">
              <h3>Qué cambió</h3>
              <div className="list">
                {/* Se puede entrar a ver de qué se trató: leer "subió $40.000
                    en supermercado" y no poder mirarlo deja la frase colgando. */}
                {datos.subio && (
                  <Link
                    className="item"
                    to={verCategoria({ categoryId: datos.subio.categoryId, month, scope: 'comun' })}
                    onClick={onClose}
                  >
                    <FichaCategoria emoji={datos.subio.emoji} color={null} />
                    <div className="body">
                      <div className="title">{datos.subio.category}</div>
                      <div className="meta">contra {monthLabel(datos.previousMonth, true)}</div>
                    </div>
                    <div className="amount">+{money(datos.subio.delta, currency)}</div>
                  </Link>
                )}
                {datos.bajo && (
                  <Link
                    className="item"
                    to={verCategoria({ categoryId: datos.bajo.categoryId, month, scope: 'comun' })}
                    onClick={onClose}
                  >
                    <FichaCategoria emoji={datos.bajo.emoji} color={null} />
                    <div className="body">
                      <div className="title">{datos.bajo.category}</div>
                      <div className="meta">contra {monthLabel(datos.previousMonth, true)}</div>
                    </div>
                    <div className="amount" style={{ color: 'var(--good-text)' }}>
                      −{money(-datos.bajo.delta, currency)}
                    </div>
                  </Link>
                )}
              </div>
            </section>
          )}

          {/* El gasto que llamó la atención, sin los fijos: el arriendo siempre
              gana y nombrarlo no dice nada. */}
          {datos.elGrande && datos.elGrande.amount > 0 && (
            <section className="cita-bloque">
              <h3>El más grande del mes</h3>
              <div className="item">
                <FichaCategoria emoji={datos.elGrande.categoryEmoji ?? '❓'} color={null} />
                <div className="body">
                  <div className="title">
                    {datos.elGrande.merchant ?? datos.elGrande.description ?? 'Un movimiento'}
                  </div>
                  <div className="meta">
                    {diaLargo(datos.elGrande.occurredOn)}
                    {datos.elGrande.categoryName && ` · ${datos.elGrande.categoryName}`}
                  </div>
                </div>
                <div className="amount">{money(datos.elGrande.amount, currency)}</div>
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                Sin contar los gastos fijos, que ya se sabían al empezar el mes.
              </p>
            </section>
          )}

          {/* Cómo quedó cada uno. En una app de dos, es el dato que decide si la
              conversación termina bien o mal, así que va sin adjetivos. */}
          <section className="cita-bloque">
            <h3>Cómo quedó cada uno</h3>
            <div className="cita-personas">
              {datos.personas.map((p, i) => (
                <div className="cita-persona" key={p.userId}>
                  <Avatar nombre={p.name} indice={i} size={30} />
                  <div>
                    <strong>
                      {p.name}
                      {p.userId === user?.id && <span className="muted"> · tú</span>}
                    </strong>
                    <div className="meta">
                      Puso {money(p.contributed, currency)} de {money(p.fairShare, currency)}
                    </div>
                  </div>
                  <span className="num cita-saldo">
                    {p.deviation >= -0.5 ? (
                      <span style={{ color: 'var(--good-text)' }}>al día</span>
                    ) : (
                      <>falta {money(-p.deviation, currency)}</>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Cuánto trabajo se ahorraron. Es la única métrica de la app sobre la
              app, y va acá porque es el mes el que la hace verdadera. */}
          {datos.automaticos.total > 0 && (
            <section className="cita-bloque">
              <h3>Lo que no tuvieron que anotar</h3>
              <p className="muted" style={{ marginBottom: 0 }}>
                {datos.automaticos.porCorreo === 0 ? (
                  <>
                    Los {datos.automaticos.total} movimientos del mes los anotaron a mano. Conectando el
                    correo del banco entrarían solos.
                  </>
                ) : (
                  <>
                    {datos.automaticos.porCorreo} de {datos.automaticos.total} movimientos entraron solos
                    desde el correo del banco.
                  </>
                )}
              </p>
            </section>
          )}

          {/* Y qué se viene, que es lo que convierte la lectura en una decisión
              y no en un recuerdo. */}
          <section className="cita-bloque">
            <h3>Lo que viene en {monthLabel(datos.nextMonth)}</h3>
            {datos.loQueViene.fijos > 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                {datos.loQueViene.fijos} {datos.loQueViene.fijos === 1 ? 'gasto fijo' : 'gastos fijos'} por{' '}
                {money(datos.loQueViene.total, currency)} antes de gastar en nada más.
              </p>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>
                No hay gastos fijos declarados, así que el mes que viene se estima con el promedio.
              </p>
            )}
          </section>

          <div className="pie-hoja">
            <button className="primary" onClick={onCerrar} style={{ minHeight: 50, fontSize: 'var(--t-lg)' }}>
              Cerrar {monthLabel(month)}
            </button>
            <button className="ghost" onClick={onClose}>Leerlo después</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

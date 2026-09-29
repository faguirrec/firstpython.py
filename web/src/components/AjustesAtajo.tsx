import { useCallback, useEffect, useState } from 'react';
import { api, type ClaveAtajo, type SenalAtajo } from '../lib/api';
import { useSession } from '../lib/session';
import { avisar, avisarError } from '../lib/aviso';
import { diaLargo, money } from '../lib/format';

/**
 * Capturar las compras desde el iPhone, cuando el banco no manda correo.
 *
 * Banco Falabella avisa las transferencias por correo pero **no las compras con
 * tarjeta**: ésas sólo llegan como notificación push, y ninguna app de iOS puede
 * leer las notificaciones de otra. Lo que sí se puede es engancharse al momento
 * del pago: al pagar con una tarjeta de Apple Wallet, iOS dispara una
 * automatización de Atajos que entrega el monto y el comercio.
 *
 * Esta pantalla entrega la llave y el paso a paso. Lo que no hace es prometer
 * que esto reemplaza a la cartola: el disparador de iOS pierde eventos en
 * silencio y sólo ve lo que se paga acercando el teléfono. Está dicho en
 * pantalla, porque una persona que cree que esto captura todo va a cuadrar mal
 * el mes y no va a entender por qué.
 */
export default function AjustesAtajo() {
  const [claves, setClaves] = useState<ClaveAtajo[]>([]);
  const [senales, setSenales] = useState<SenalAtajo[]>([]);
  const [nombre, setNombre] = useState('');
  const [reciencreada, setRecienCreada] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.clavesAtajo(), api.senalesAtajo()]);
      setClaves(c.claves);
      setSenales(s.senales);
    } catch (err) {
      avisarError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /*
   * Volver a mirar cuando se vuelve a la app.
   *
   * El atajo se ejecuta en el mismo teléfono en el que está la app, así que
   * nadie puede mirar las dos cosas a la vez: se sale a Atajos, se dispara, y
   * se vuelve. Refrescar en ese momento es lo que hace que la señal ya esté
   * cuando uno vuelve, sin botones ni esperas. Un sondeo cada tantos segundos
   * pediría lo mismo decenas de veces para el único momento que importa.
   */
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === 'visible') void cargar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [cargar]);

  const vivas = claves.filter((c) => !c.revocadaAt);
  const base = typeof window !== 'undefined' ? window.location.origin : '';

  async function crear() {
    setCreando(true);
    try {
      const { clave } = await api.crearClaveAtajo(nombre);
      setRecienCreada(clave);
      setNombre('');
      await cargar();
    } catch (err) {
      avisarError((err as Error).message);
    } finally {
      setCreando(false);
    }
  }

  async function copiar(texto: string, que: string) {
    try {
      await navigator.clipboard.writeText(texto);
      avisar(`${que} copiada.`);
    } catch {
      // Safari sólo permite copiar desde un gesto del usuario y a veces igual
      // falla. Decirlo es mejor que un botón que no hace nada.
      avisarError('No pude copiar. Mantén apretado el texto y cópialo a mano.');
    }
  }

  return (
    <div className="card">
      <h2>Compras con Apple Pay</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Banco Falabella avisa las transferencias por correo, pero las compras con tarjeta sólo
        llegan como notificación al teléfono, y ninguna app puede leer las notificaciones de otra.
        Lo que sí se puede es enganchar el momento del pago: cuando pagas acercando el iPhone,
        iOS puede avisarle a MyHaus.
      </p>

      {/* Lo que esto no hace, antes de que alguien lo arme y se confíe. */}
      <div className="aviso-inline">
        <strong>Esto es un adelanto, no la cuenta final.</strong>
        <span>
          Ve sólo lo que pagas acercando el teléfono —una compra por internet con el número de
          la tarjeta no pasa por acá— y a veces iOS se salta el aviso. Todo lo que entre así
          queda <em>por revisar</em> y hay que cuadrarlo contra la cartola.
        </span>
      </div>

      {vivas.length === 0 ? (
        <div className="stack" style={{ marginTop: 16 }}>
          <label className="field">
            <span>Nombre de la llave</span>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="iPhone de Francisco"
              maxLength={60}
            />
            <em className="muted">Sólo para reconocerla después si tienen más de una.</em>
          </label>
          <button className="primary" onClick={crear} disabled={creando}>
            {creando ? 'Creando…' : 'Crear la llave'}
          </button>
        </div>
      ) : (
        <div className="list" style={{ marginTop: 16 }}>
          {vivas.map((c) => (
            <div className="item" key={c.id}>
              <div className="body">
                <div className="title">{c.nombre}</div>
                <div className="meta">
                  Termina en {c.cola} ·{' '}
                  {c.lastUsedAt ? `usada por última vez el ${diaLargo(c.lastUsedAt.slice(0, 10))}` : 'todavía sin usar'}
                </div>
              </div>
              <button
                className="small danger"
                onClick={async () => {
                  if (!confirm(`¿Revocar «${c.nombre}»? El atajo de ese teléfono deja de funcionar.`)) return;
                  await api.revocarClaveAtajo(c.id);
                  avisar('Llave revocada.');
                  await cargar();
                }}
              >
                Revocar
              </button>
            </div>
          ))}
        </div>
      )}

      {/*
        * La llave entera, una sola vez.
        *
        * El servidor guarda el hash, así que esto no se puede volver a mostrar.
        * Se dice en pantalla para que nadie cierre esta tarjeta pensando que
        * podrá volver a buscarla.
        */}
      {reciencreada && (
        <div className="llave-nueva">
          <strong>Cópiala ahora</strong>
          <p className="muted">
            Es la única vez que se va a ver: el servidor sólo guarda una huella de ella. Si se
            pierde, se revoca y se crea otra.
          </p>
          <code className="llave-texto">{reciencreada}</code>
          <div className="hero-acciones">
            <button className="primary" onClick={() => copiar(reciencreada, 'La llave')}>Copiar la llave</button>
            <button className="ghost" onClick={() => setRecienCreada(null)}>Ya la copié</button>
          </div>
        </div>
      )}

      {vivas.length > 0 && (
        <details className="plegable" style={{ marginTop: 16 }}>
          <summary>
            <strong>Cómo armar el atajo en el iPhone</strong>
            <span className="muted">Una vez, cinco minutos</span>
          </summary>

          <ol className="pasos-atajo">
            <li>
              Agrega la tarjeta a <strong>Wallet</strong>, si no está. Esto sólo funciona pagando
              con Apple Pay.
            </li>
            <li>
              Abre <strong>Atajos</strong> → pestaña <strong>Automatización</strong> →{' '}
              <strong>+</strong> → busca <strong>Wallet</strong> (en iOS 17 se llama{' '}
              <strong>Transacción</strong>).
            </li>
            <li>
              Elige <strong>Cuando toco</strong> y marca la tarjeta. Abajo, activa{' '}
              <strong>Ejecutar inmediatamente</strong> — sin eso te va a pedir confirmación en
              cada compra y no sirve.
            </li>
            <li>
              Agrega la acción <strong>Obtener contenido de URL</strong> y ponle esta dirección:
              <div className="copiable">
                <code>{base}/api/atajo/movimiento</code>
                <button className="small ghost" onClick={() => copiar(`${base}/api/atajo/movimiento`, 'La dirección')}>
                  Copiar
                </button>
              </div>
            </li>
            <li>
              Despliega <strong>Mostrar más</strong>: método <strong>POST</strong>. En{' '}
              <strong>Encabezados</strong> agrega uno con clave <code>Authorization</code> y valor{' '}
              <code>Bearer</code> seguido de tu llave.
            </li>
            <li>
              En <strong>Cuerpo de la petición</strong> elige <strong>JSON</strong> y arma tres
              campos de texto, poniendo en cada valor la variable de la transacción:
              <table className="tabla-campos">
                <tbody>
                  <tr><td><code>monto</code></td><td>variable <strong>Amount</strong></td></tr>
                  <tr><td><code>comercio</code></td><td>variable <strong>Merchant</strong></td></tr>
                  <tr><td><code>tarjeta</code></td><td>variable <strong>Card</strong></td></tr>
                </tbody>
              </table>
            </li>
            <li>
              Guarda y prueba con una compra chica. Debería aparecer en Movimientos en segundos,
              marcada <em>por revisar</em>.
            </li>
          </ol>

          <p className="muted" style={{ marginBottom: 0 }}>
            Si no aparece: revisa que <strong>Ejecutar inmediatamente</strong> esté activado y que
            el encabezado diga <code>Bearer</code> y un espacio antes de la llave.
          </p>
        </details>
      )}

      {/*
        * Lo que llegó del teléfono, al final y no antes del instructivo.
        *
        * En la primera visita esto se lee de arriba abajo —crear la llave, cómo
        * armarlo, qué llegó— y esa es la secuencia real. Después, con el
        * instructivo plegado en una línea, igual queda a la vista.
        */}
      {vivas.length > 0 && <Senales senales={senales} onRecargar={cargar} />}
    </div>
  );
}

/**
 * Lo que mandó el teléfono, tal cual.
 *
 * Esta es la pieza que evita la pregunta imposible: "no apareció, ¿por qué?".
 * El formato con que iOS entrega el monto es la única incógnita real de todo el
 * camino —lo manda según la región del teléfono, y confundir el separador de
 * miles con el decimal convierte $38.450 en $38—, así que acá se muestra el
 * texto crudo al lado de en cuánto quedó. Si no calzan, se ve.
 *
 * Los que no se pudieron leer salen primero en rojo, porque son los únicos que
 * piden hacer algo.
 */
function Senales({ senales, onRecargar }: { senales: SenalAtajo[]; onRecargar: () => Promise<void> }) {
  const currency = useSession().household?.currency ?? 'CLP';
  const [recargando, setRecargando] = useState(false);

  async function recargar() {
    setRecargando(true);
    try {
      await onRecargar();
    } finally {
      setRecargando(false);
    }
  }

  if (senales.length === 0) {
    return (
      <div className="card senales">
        <h2>Esperando la primera señal</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Todavía no llega nada desde el teléfono. Arma el atajo, dispáralo, y al volver acá vas a ver
          exactamente qué mandó iOS y cómo lo entendió la app.
        </p>
        <button className="ghost small" onClick={() => void recargar()} disabled={recargando}>
          {recargando ? 'Mirando…' : 'Mirar de nuevo'}
        </button>
      </div>
    );
  }

  const ilegibles = senales.filter((s) => s.resultado === 'no-pude-leer');

  return (
    <div className="card senales">
      <div className="card-head">
        <h2>Lo que mandó el teléfono</h2>
        <button className="ghost small" onClick={() => void recargar()} disabled={recargando}>
          {recargando ? 'Mirando…' : 'Actualizar'}
        </button>
      </div>

      {ilegibles.length > 0 ? (
        <div className="aviso-inline malo">
          <strong>Hay {ilegibles.length} que no pude leer.</strong>
          <span>
            Casi siempre es el formato del monto. Mándame el texto que aparece abajo en gris y lo arreglo.
          </span>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          A la izquierda va el texto tal cual lo mandó iOS; a la derecha, en cuánto quedó. Si no calzan, avísame.
        </p>
      )}

      <div className="list">
        {senales.map((s) => (
          <div className="item" key={s.id}>
            <div className="body">
              <div className="title">{s.comercioCrudo ?? 'Sin comercio'}</div>
              <div className="meta">
                <code className="senal-crudo">{s.montoCrudo ?? '(sin monto)'}</code>
                {' → '}
                {s.montoLeido != null ? money(s.montoLeido, currency) : 'no pude leerlo'}
              </div>
              <div className="meta">{cuando(s.recibidaAt)}</div>
            </div>
            <span className={`pill ${etiqueta(s).clase}`}>{etiqueta(s).texto}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function etiqueta(s: SenalAtajo): { texto: string; clase: string } {
  // La píldora dice la consecuencia y la línea de arriba dice la causa. Poner
  // "no pude leerlo" en las dos no agrega nada: lo que falta saber es que esa
  // compra quedó sin anotar.
  if (s.resultado === 'no-pude-leer') return { texto: 'sin anotar', clase: 'alert' };
  // Repetido no es un error: la automatización de iOS a veces se ejecuta de
  // más, y que no se haya anotado dos veces es justamente lo correcto.
  if (s.resultado === 'duplicado') return { texto: 'repetido', clase: '' };
  return { texto: 'anotado', clase: 'good' };
}

/** La hora, que es lo que uno acaba de hacer, y la fecha sólo si es de antes. */
function cuando(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const hora = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date().toDateString() === d.toDateString();
  return hoy ? `Hoy a las ${hora}` : `${diaLargo(d.toISOString().slice(0, 10))} a las ${hora}`;
}

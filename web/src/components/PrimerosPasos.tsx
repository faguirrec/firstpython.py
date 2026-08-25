import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EstadoFijos, Settlement } from '../lib/api';

/**
 * Los tres pasos que hacen que la app sirva, para un hogar recién creado.
 *
 * Sin esto, quien entra por primera vez ve un resumen lleno de ceros y ninguna
 * pista de qué hacer: el reparto necesita los sueldos, la proyección necesita
 * los gastos fijos, y que los gastos entren solos necesita el buzón conectado.
 * Los tres están en pantallas distintas y no había nada que los ordenara.
 *
 * Desaparece entero cuando los tres están hechos, y cada paso se marca solo:
 * no hay que decirle a la app que uno ya lo hizo.
 *
 * Mientras no haya ninguno hecho no se puede cerrar —un hogar en cero no puede
 * usar la app para nada—, pero apenas hay uno aparece la salida: alguien puede
 * no querer declarar gastos fijos nunca, y dejarle el cartel para siempre sería
 * castigarlo por una decisión suya.
 */

const CLAVE_OCULTO = 'hogar:pasos-ocultos';
export type Paso = {
  clave: string;
  titulo: string;
  detalle: string;
  a: string;
  accion: string;
  listo: boolean;
};

export function pasosPendientes(
  settlement: Settlement | null,
  fijos: EstadoFijos | null,
  buzones: number,
): Paso[] {
  // Mientras no haya llegado la respuesta no se muestra nada: encender los tres
  // pasos y apagarlos medio segundo después se ve como un parpadeo de error.
  if (!settlement) return [];

  return [
    {
      clave: 'sueldos',
      titulo: 'Declaren cuánto gana cada uno',
      detalle: 'Es lo que decide la proporción del reparto. Sin esto se divide mitad y mitad.',
      a: '/liquidacion',
      accion: 'Cargar sueldos',
      listo: settlement.members.length > 0 && settlement.members.every((m) => m.income > 0),
    },
    {
      clave: 'fijos',
      titulo: 'Anoten los gastos fijos',
      detalle: 'Arriendo, cuentas, internet. Con eso la app estima el mes antes de que empiece.',
      a: '/reportes?vista=fijos',
      accion: 'Anotar los fijos',
      listo: (fijos?.all.length ?? 0) > 0,
    },
    {
      clave: 'buzon',
      titulo: 'Conecten el correo del banco',
      detalle: 'Los avisos que ya les llegan se convierten en movimientos, sin anotar nada.',
      a: '/ajustes/gmail',
      accion: 'Conectar el buzón',
      listo: buzones > 0,
    },
  ];
}

export default function PrimerosPasos({ pasos }: { pasos: Paso[] }) {
  const [oculto, setOculto] = useState(() => {
    try {
      return localStorage.getItem(CLAVE_OCULTO) === '1';
    } catch {
      return false;
    }
  });

  const hechos = pasos.filter((p) => p.listo).length;
  if (pasos.length === 0 || hechos === pasos.length) return null;
  if (oculto && hechos > 0) return null;

  // El primero que falta es el único con botón: tres botones a la vez no dicen
  // por dónde empezar, y el orden importa —el reparto se apoya en los sueldos—.
  const siguiente = pasos.find((p) => !p.listo);

  return (
    <div className="card primeros-pasos">
      <div className="card-head">
        <h2>Para que esto empiece a servir</h2>
        <span className="muted num" style={{ whiteSpace: 'nowrap' }}>{hechos} de {pasos.length}</span>
      </div>

      <div className="pasos-progreso" aria-hidden="true">
        {pasos.map((p) => (
          <span key={p.clave} className={p.listo ? 'listo' : ''} />
        ))}
      </div>

      <ol className="pasos">
        {pasos.map((p) => (
          <li key={p.clave} className={p.listo ? 'listo' : ''}>
            <span className="marca" aria-hidden="true">{p.listo ? '✓' : ''}</span>
            <div>
              <div className="title">{p.titulo}</div>
              {!p.listo && <div className="meta">{p.detalle}</div>}
              {p.clave === siguiente?.clave && (
                <Link to={p.a} style={{ display: 'inline-block', marginTop: 8 }}>
                  {/* El botón va dentro del enlace: los estilos de botón están
                      escritos para <button>, y un <Link> con la clase se vería
                      como texto subrayado. */}
                  <button className="primary small">{p.accion}</button>
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      {hechos > 0 && (
        <button
          className="ghost small"
          style={{ marginTop: 12 }}
          onClick={() => {
            try {
              localStorage.setItem(CLAVE_OCULTO, '1');
            } catch {
              /* sin almacenamiento vuelve a aparecer la próxima vez */
            }
            setOculto(true);
          }}
        >
          No mostrar más
        </button>
      )}
    </div>
  );
}

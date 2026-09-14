import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { money, monthLabel } from '../lib/format';
import { cambiarMes, useMes } from '../lib/mes';
import { MODO_PERSONAL_VISIBLE } from '../lib/modo';
import { useDeslizarMes } from '../lib/deslizar';
import { datosCambiaron, useVersionDatos } from '../lib/datos';
import { avisar, avisarError } from '../lib/aviso';
import { CategoryBars, TrendChart, type CategorySlice, type TrendPoint } from '../components/Charts';
import { verCategoria } from '../lib/verCategoria';
import PorArreglar from '../components/PorArreglar';
import Cabecera from '../components/Cabecera';
import Presupuesto from '../components/Presupuesto';
import Comparacion from '../components/Comparacion';
import GastosFijos from '../components/GastosFijos';
import { usePrivacidad } from '../lib/privacidad';

const VISTAS = [
  { key: 'presupuesto', label: 'Presupuesto' },
  // Los gastos fijos viven acá y no en Ajustes: no son una configuración de la
  // app, son plata que sale todos los meses, y la pregunta que contestan —qué
  // falta por pagar— es la misma que se viene a hacer a esta pantalla. Además
  // el presupuesto por categoría estaba pidiendo lo mismo dos veces, en dos
  // lugares que no se conocían entre sí.
  { key: 'fijos', label: 'Gastos fijos' },
  { key: 'comparacion', label: 'Comparación' },
  { key: 'tendencia', label: 'Tendencia' },
] as const;

type Vista = (typeof VISTAS)[number]['key'];

export default function Reportes() {
  // La vista va en la dirección para que se pueda enlazar desde fuera: el
  // Resumen manda a los gastos fijos, y /ajustes/fijos redirige acá.
  const [params, setParams] = useSearchParams();
  const pedida = params.get('vista') as Vista | null;
  const vista: Vista = VISTAS.some((v) => v.key === pedida) ? pedida! : 'presupuesto';
  const setVista = (v: Vista) => setParams(v === 'presupuesto' ? {} : { vista: v }, { replace: true });
  const month = useMes();
  // Deslizar de lado cambia de mes, para no obligar a estirar el pulgar
  // hasta las flechas de la cabecera.
  useDeslizarMes(month, vista !== 'tendencia');

  return (
    <>
      <Cabecera
        hogar="Análisis"
        month={vista !== 'tendencia' ? month : undefined}
        onMonthChange={vista !== 'tendencia' ? cambiarMes : undefined}
      />

      <div className="tabs">
        {VISTAS.map((v) => (
          <button key={v.key} className={vista === v.key ? 'active' : ''} onClick={() => setVista(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {/* Antes de cualquier gráfico: lo que hay que ordenar para que los
          gráficos digan la verdad. */}
      {vista !== 'tendencia' && <PorArreglar month={month} />}

      {vista === 'presupuesto' && <Presupuesto month={month} />}
      {vista === 'fijos' && <GastosFijos month={month} />}
      {vista === 'comparacion' && <Comparacion month={month} />}
      {vista === 'tendencia' && <Tendencia />}
    </>
  );
}

function Tendencia() {
  const { household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const privado = usePrivacidad();
  const [range, setRange] = useState(12);
  const version = useVersionDatos();
  const [months, setMonths] = useState<(TrendPoint & { income: number; personal: number })[]>([]);
  const [categories, setCategories] = useState<CategorySlice[]>([]);
  const [guardandoEstimado, setGuardandoEstimado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tendencia mira el historial completo y no tiene selector de mes propio: el
  // estimado se guarda para el mes en que uno está parado.
  const mesActual = useMes();

  useEffect(() => {
    void (async () => {
      try {
        const [m, c] = await Promise.all([api.monthlyReport(range), api.byCategory(undefined, 'comun')]);
        setMonths(m.months);
        setCategories(c.categories);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [range, version]);

  const totalShared = months.reduce((a, b) => a + b.shared, 0);
  const average = months.length ? totalShared / months.length : 0;
  const last = months[months.length - 1];
  const previous = months[months.length - 2];
  const delta = last && previous && previous.shared > 0 ? (last.shared - previous.shared) / previous.shared : null;

  return (
    <>
      <div className="tabs">
        {[6, 12, 24].map((r) => (
          <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
            {r} meses
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="label">Promedio mensual de gastos comunes</div>
        <div className="hero num">{money(average, currency)}</div>
        {last && (
          <div className="muted">
            {monthLabel(last.month)}: {money(last.shared, currency)}
            {delta != null && (
              <span style={{ color: delta > 0 ? 'var(--text-primary)' : 'var(--good-text)' }}>
                {' '}· {delta > 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% vs. el mes anterior
              </span>
            )}
          </div>
        )}
        {/*
          * La única decisión que este número permite tomar.
          *
          * El promedio de los últimos meses es la mejor estimación de lo que va
          * a costar el que viene, y Reparto la usa para decir cuánto transferir.
          * Hasta acá había que mirarla, memorizarla e ir a escribirla a mano en
          * otra pantalla.
          */}
        {average > 0 && (
          <div className="hero-acciones">
            <button
              className="primary"
              disabled={guardandoEstimado}
              onClick={async () => {
                setGuardandoEstimado(true);
                try {
                  await api.guardarGastoEstimado({ month: mesActual, amount: Math.round(average) });
                  avisar(`Estimado de ${monthLabel(mesActual)}: ${money(Math.round(average), currency)}.`);
                  datosCambiaron();
                } catch (err) {
                  avisarError((err as Error).message);
                } finally {
                  setGuardandoEstimado(false);
                }
              }}
            >
              Usarlo como estimado del mes
            </button>
            <Link to="/liquidacion"><button className="ghost">Ver el reparto</button></Link>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Gastos y aportes por mes</h2>
        <TrendChart data={months} currency={currency} />
      </div>

      <div className="card">
        <h2>Gasto común acumulado por categoría</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Todo el historial registrado, sólo con lo que se reparte entre los dos.
        </p>
        <CategoryBars
          data={categories}
          currency={currency}
          limit={12}
          enlace={(row) =>
            row.categoryId === undefined
              ? null
              : verCategoria({ categoryId: row.categoryId, scope: 'comun' })
          }
        />
      </div>

      <div className="card">
        <h2>Detalle mensual</h2>
        {/* Cuatro columnas de plata no caben en 320px. La tabla se desliza
            dentro de su tarjeta en vez de correr la página entera. */}
        <div className="tabla-ancha">
        <table className="data">
          <thead>
            <tr>
              <th>Mes</th>
              <th>Comunes</th>
              {/* La columna de lo personal era el resumen del otro bolsillo:
                  sin ese modo no hay dónde ir a mirarlo en detalle, así que
                  mostrar el total suelto sería una cifra sin pantalla detrás.
                  La plata no se pierde —los movimientos siguen en la base y en
                  la lista de Movimientos—, deja de tener columna propia. */}
              {MODO_PERSONAL_VISIBLE && <th>Personales</th>}
              <th>Ingreso</th>
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td>
                <td className="num">{money(m.shared, currency)}</td>
                {MODO_PERSONAL_VISIBLE && <td className="num">{money(m.personal, currency)}</td>}
                <td className="num">
                  {m.income ? (privado ? '•••••' : money(m.income, currency)) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {months.length === 0 && <p className="muted">Todavía no hay datos suficientes.</p>}
      </div>
    </>
  );
}

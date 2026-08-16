import { useState } from 'react';
import { money, moneyShort, monthLabel } from '../lib/format';

/** Rectángulo con las esquinas superiores redondeadas, anclado a la línea base. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.min(r, w / 2, Math.max(h, 0));
  if (h <= 0) return '';
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

export type TrendPoint = { month: string; shared: number; contributions: number };

/**
 * Gastos comunes vs. aportes, mes a mes. Dos series de la misma unidad y un
 * solo eje: nunca dos escalas en el mismo gráfico.
 */
export function TrendChart({ data, currency }: { data: TrendPoint[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) return <p className="muted">Todavía no hay meses con movimientos.</p>;

  const H = 210;
  const padTop = 12;
  const padBottom = 26;
  const padLeft = 46;
  const groupWidth = 54;
  const W = Math.max(320, padLeft + data.length * groupWidth + 12);
  const plotHeight = H - padTop - padBottom;

  const max = niceMax(Math.max(...data.flatMap((d) => [d.shared, d.contributions]), 1));
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const scale = (value: number) => plotHeight - (value / max) * plotHeight;
  const barWidth = 20;
  const point = hover != null ? data[hover] : null;

  return (
    <div>
      <div className="legend">
        <span><i className="dot" style={{ background: 'var(--series-1)' }} /> Gastos comunes</span>
        <span><i className="dot" style={{ background: 'var(--series-2)' }} /> Aportes al hogar</span>
      </div>

      <div className="chart-scroll">
        <svg width={W} height={H} role="img" aria-label="Gastos comunes y aportes por mes">
          <g transform={`translate(${padLeft} ${padTop})`}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={-8} x2={W - padLeft} y1={scale(tick)} y2={scale(tick)}
                  stroke={tick === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1}
                />
                <text x={-12} y={scale(tick) + 4} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                  {moneyShort(tick, currency)}
                </text>
              </g>
            ))}

            {data.map((d, i) => {
              const x = i * groupWidth + 4;
              return (
                <g
                  key={d.month}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onTouchStart={() => setHover(i)}
                >
                  {/* Zona sensible más ancha que las barras, para el dedo. */}
                  <rect x={x - 4} y={0} width={groupWidth} height={plotHeight} fill="transparent" />
                  {hover === i && (
                    <rect x={x - 4} y={0} width={groupWidth} height={plotHeight}
                      fill="var(--text-primary)" opacity={0.05} />
                  )}
                  {/* 2px de aire entre barras vecinas. */}
                  <path d={barPath(x, scale(d.shared), barWidth, plotHeight - scale(d.shared))} fill="var(--series-1)" />
                  <path
                    d={barPath(x + barWidth + 2, scale(d.contributions), barWidth, plotHeight - scale(d.contributions))}
                    fill="var(--series-2)"
                  />
                  <text
                    x={x + barWidth + 1} y={plotHeight + 16} textAnchor="middle"
                    fontSize={10} fill="var(--text-muted)"
                  >
                    {monthLabel(d.month, true)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="muted" style={{ minHeight: 22 }}>
        {point ? (
          <>
            <strong style={{ color: 'var(--text-primary)' }}>{monthLabel(point.month)}</strong>
            {' · '}gastos {money(point.shared, currency)} · aportes {money(point.contributions, currency)}
          </>
        ) : (
          'Toca un mes para ver el detalle.'
        )}
      </div>

      <details className="table-view">
        <summary>Ver como tabla</summary>
        <table className="data">
          <thead>
            <tr><th>Mes</th><th>Gastos comunes</th><th>Aportes</th></tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.month}>
                <td>{monthLabel(d.month)}</td>
                <td className="num">{money(d.shared, currency)}</td>
                <td className="num">{money(d.contributions, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export type CategorySlice = { category: string; color: string; total: number; count: number };

/**
 * Desglose por categoría: barras horizontales ordenadas por monto y etiquetadas
 * directamente. Un solo tono — el largo de la barra ya codifica la magnitud, y
 * el color de la categoría queda como punto de identidad junto al nombre.
 */
export function CategoryBars({
  data,
  currency,
  limit = 10,
}: {
  data: CategorySlice[];
  currency: string;
  limit?: number;
}) {
  if (data.length === 0) return <p className="muted">Sin gastos en este período.</p>;

  const sorted = [...data].sort((a, b) => b.total - a.total);
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const rows = rest.length
    ? [...head, { category: 'Otras', color: '#898781', total: rest.reduce((a, b) => a + b.total, 0), count: rest.length }]
    : head;

  const max = Math.max(...rows.map((r) => r.total), 1);
  const grandTotal = sorted.reduce((a, b) => a + b.total, 0);

  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((row) => (
        <div key={row.category}>
          <div className="row" style={{ marginBottom: 3 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <i className="dot" style={{ background: row.color }} />
              <span style={{ fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.category}
              </span>
            </span>
            <span className="num" style={{ fontSize: '0.86rem', whiteSpace: 'nowrap' }}>
              {money(row.total, currency)}
              <span className="muted"> · {Math.round((row.total / grandTotal) * 100)}%</span>
            </span>
          </div>
          <div style={{ height: 8, background: 'var(--grid)', borderRadius: 4 }}>
            <div
              style={{
                width: `${Math.max((row.total / max) * 100, 2)}%`,
                height: '100%',
                background: 'var(--seq-450)',
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Barra que muestra cómo se parte el total entre las dos personas.
 * Las dos series llevan etiqueta directa: el color no carga solo el significado.
 */
export function SplitBar({
  parts,
}: {
  parts: { name: string; share: number; color: string }[];
}) {
  return (
    <div>
      <div style={{ display: 'flex', height: 26, borderRadius: 8, overflow: 'hidden', gap: 2 }}>
        {parts.map((part) => (
          <div
            key={part.name}
            style={{
              width: `${Math.max(part.share * 100, 4)}%`,
              background: part.color,
              display: 'grid',
              placeItems: 'center',
              fontSize: '0.7rem',
              color: '#fff',
              fontWeight: 600,
            }}
          >
            {Math.round(part.share * 100)}%
          </div>
        ))}
      </div>
      <div className="legend" style={{ marginTop: 6, marginBottom: 0 }}>
        {parts.map((part) => (
          <span key={part.name}>
            <i className="dot" style={{ background: part.color }} /> {part.name}
          </span>
        ))}
      </div>
    </div>
  );
}

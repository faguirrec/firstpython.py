import { currentMonth, monthLabel, shiftMonth } from '../lib/format';

export default function MonthNav({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const isFuture = month >= currentMonth();

  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <button className="small" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Mes anterior">
        ‹ {monthLabel(shiftMonth(month, -1), true)}
      </button>
      <strong style={{ textTransform: 'capitalize' }}>{monthLabel(month)}</strong>
      <button
        className="small"
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={isFuture}
        aria-label="Mes siguiente"
      >
        {monthLabel(shiftMonth(month, 1), true)} ›
      </button>
    </div>
  );
}

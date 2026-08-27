"""Reports and dashboard.

Three outputs:

* ``daily_report`` - one day's activity, for the alert channel.
* ``final_report`` - the day-30 verdict: what worked, what did not, and a
  continue / adjust / stop recommendation grounded in the recorded numbers.
* ``write_dashboard`` - a single self-contained HTML file so results can be
  reviewed without reading raw logs.
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from .agents.learning_loop import LearningLoop
from .clock import iso, trading_day, utcnow
from .config import Settings
from .db import Store
from .metrics import compute_metrics, daily_snapshot


def _fmt_money(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:,.4f}" if abs(value) < 1 else f"${value:,.2f}"


def _fmt_pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:+.2f}%"


def _fmt_num(value: float | None, digits: int = 2) -> str:
    return "-" if value is None else f"{value:,.{digits}f}"


# ------------------------------------------------------------------- reports
def daily_report(settings: Settings, store: Store, day: str | None = None) -> dict[str, Any]:
    """Compute and persist one day's metrics, plus a human-readable summary."""
    key = day or trading_day().isoformat()
    snapshot = daily_snapshot(store, key)
    overall = compute_metrics(
        store, starting_equity=settings.risk.starting_equity, benchmark=settings.benchmark
    )
    decisions = store.decisions_for_day(key)
    rejected = [d for d in decisions if not d.get("approved")]
    rejection_reasons: dict[str, int] = {}
    for decision in rejected:
        reason = str(decision.get("reason") or "unknown")
        rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1

    lines = [
        f"Resumen diario {key}",
        f"  Equity: {_fmt_money(snapshot.get('end_equity'))} "
        f"(inicio del día {_fmt_money(snapshot.get('start_equity'))})",
        f"  P&L neto del día: {_fmt_money(snapshot['net_pnl'])} "
        f"(bruto {_fmt_money(snapshot['gross_pnl'])}, fees {_fmt_money(snapshot['fees'])})",
        f"  Trades: {snapshot['trades_closed']} cerrados, {snapshot['trades_opened']} abiertos, "
        f"{snapshot['wins']}W/{snapshot['losses']}L",
        f"  Decisiones evaluadas: {len(decisions)} ({len(rejected)} descartadas)",
        f"  Acumulado: {_fmt_money(overall.net_pnl)} neto | retorno {_fmt_pct(overall.return_pct)} "
        f"| benchmark {_fmt_pct(overall.benchmark_return_pct)}",
        f"  Fees / P&L bruto: {_fmt_num(overall.fee_to_pnl_ratio)}",
    ]
    if rejection_reasons:
        top = sorted(rejection_reasons.items(), key=lambda kv: kv[1], reverse=True)[:5]
        lines.append("  Motivos de rechazo: " + ", ".join(f"{k}={v}" for k, v in top))

    return {
        "day": key,
        "daily": snapshot,
        "cumulative": overall.as_dict(),
        "rejection_reasons": rejection_reasons,
        "text": "\n".join(lines),
    }


def final_report(settings: Settings, store: Store) -> dict[str, Any]:
    """Day-30 verdict, including a continue / adjust / stop recommendation."""
    metrics = compute_metrics(
        store, starting_equity=settings.risk.starting_equity, benchmark=settings.benchmark
    )
    signals = LearningLoop(settings, store).signal_performance()
    per_symbol = _per_symbol(store)
    recommendation, rationale = _recommendation(metrics, signals)

    working = [s for s in signals if s["samples"] >= 3 and s["hit_rate"] > 0.5]
    failing = [s for s in signals if s["samples"] >= 3 and s["hit_rate"] < 0.5]

    lines = [
        f"Reporte final del experimento ({metrics.days_elapsed} días)",
        "",
        f"Capital inicial:      {_fmt_money(metrics.start_equity)}",
        f"Equity final:         {_fmt_money(metrics.current_equity)}",
        f"P&L neto:             {_fmt_money(metrics.net_pnl)}  ({_fmt_pct(metrics.return_pct)})",
        f"P&L bruto:            {_fmt_money(metrics.gross_pnl)}",
        f"Fees totales:         {_fmt_money(metrics.total_fees)}"
        f"  (fees/P&L bruto: {_fmt_num(metrics.fee_to_pnl_ratio)})",
        f"Trades cerrados:      {metrics.trades_total} ({metrics.wins}W / {metrics.losses}L,"
        f" win rate {_fmt_pct(metrics.win_rate)})",
        f"Expectativa/trade:    {_fmt_money(metrics.expectancy)}",
        f"Profit factor:        {_fmt_num(metrics.profit_factor)}",
        f"Máximo drawdown:      {_fmt_pct(metrics.max_drawdown_pct)}",
        f"Sharpe (simplificado):{_fmt_num(metrics.sharpe_ratio)}",
        f"Benchmark {settings.benchmark} buy&hold: {_fmt_pct(metrics.benchmark_return_pct)}",
        f"Exceso sobre benchmark: {_fmt_pct(metrics.excess_return_pct)}",
        "",
        "Señales que funcionaron: "
        + (", ".join(f"{s['signal']} ({_fmt_pct(s['hit_rate'])})" for s in working) or "ninguna con muestra suficiente"),
        "Señales que fallaron:    "
        + (", ".join(f"{s['signal']} ({_fmt_pct(s['hit_rate'])})" for s in failing) or "ninguna con muestra suficiente"),
        "",
        f"Recomendación: {recommendation.upper()}",
        *[f"  - {reason}" for reason in rationale],
        "",
        "Este experimento usa capital de riesgo mínimo y no constituye asesoría financiera.",
    ]

    return {
        "generated_at": iso(utcnow()),
        "metrics": metrics.as_dict(),
        "signals": signals,
        "per_symbol": per_symbol,
        "recommendation": recommendation,
        "rationale": rationale,
        "text": "\n".join(lines),
    }


def _per_symbol(store: Store) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for trade in store.closed_trades():
        symbol = str(trade.get("symbol"))
        bucket = buckets.setdefault(
            symbol, {"symbol": symbol, "trades": 0, "wins": 0, "net_pnl": 0.0, "fees": 0.0}
        )
        net = float(trade.get("net_pnl") or 0.0)
        bucket["trades"] += 1
        bucket["wins"] += 1 if net > 0 else 0
        bucket["net_pnl"] += net
        bucket["fees"] += float(trade.get("fees") or 0.0)
    rows = sorted(buckets.values(), key=lambda row: row["net_pnl"], reverse=True)
    for row in rows:
        row["net_pnl"] = round(row["net_pnl"], 4)
        row["fees"] = round(row["fees"], 4)
        row["win_rate"] = round(row["wins"] / row["trades"], 4) if row["trades"] else 0.0
    return rows


def _recommendation(metrics, signals: Sequence[Mapping[str, Any]]) -> tuple[str, list[str]]:
    """Turn the numbers into continue / adjust / stop, with the reasons stated."""
    rationale: list[str] = []
    score = 0

    if metrics.trades_total < 5:
        rationale.append(
            f"Muestra insuficiente ({metrics.trades_total} trades cerrados): "
            "los resultados no son estadísticamente informativos."
        )
        return "ajustar", rationale

    if metrics.net_pnl > 0:
        score += 1
        rationale.append(f"P&L neto positivo ({_fmt_money(metrics.net_pnl)}) después de costos.")
    else:
        score -= 1
        rationale.append(f"P&L neto negativo ({_fmt_money(metrics.net_pnl)}) después de costos.")

    if metrics.fee_to_pnl_ratio is not None:
        if metrics.fee_to_pnl_ratio > 0.5:
            score -= 2
            rationale.append(
                f"Los fees consumen {_fmt_num(metrics.fee_to_pnl_ratio * 100, 1)}% del P&L bruto: "
                "el tamaño de capital no soporta esta frecuencia de trading."
            )
        elif metrics.fee_to_pnl_ratio < 0.2:
            score += 1
            rationale.append("Los costos se mantienen contenidos frente al P&L bruto.")

    if metrics.excess_return_pct is not None:
        if metrics.excess_return_pct > 0:
            score += 1
            rationale.append(
                f"Supera al benchmark por {_fmt_pct(metrics.excess_return_pct)}."
            )
        else:
            score -= 1
            rationale.append(
                f"Queda por debajo del benchmark ({_fmt_pct(metrics.excess_return_pct)}): "
                "comprar y mantener habría rendido más."
            )

    if metrics.max_drawdown_pct <= -0.15:
        score -= 1
        rationale.append(f"Drawdown máximo elevado ({_fmt_pct(metrics.max_drawdown_pct)}).")

    if metrics.profit_factor is not None and metrics.profit_factor >= 1.3:
        score += 1
        rationale.append(f"Profit factor sólido ({_fmt_num(metrics.profit_factor)}).")

    dead = [s["signal"] for s in signals if s["samples"] >= 5 and s["hit_rate"] < 0.4]
    if dead:
        rationale.append("Señales con baja tasa de acierto a retirar o recalibrar: " + ", ".join(dead))

    if score >= 2:
        return "continuar", rationale
    if score <= -2:
        return "detener", rationale
    return "ajustar", rationale


# ----------------------------------------------------------------- dashboard
def write_dashboard(settings: Settings, store: Store, path: str | Path = "reports/dashboard.html") -> Path:
    """Render a self-contained HTML dashboard (no external assets)."""
    metrics = compute_metrics(
        store, starting_equity=settings.risk.starting_equity, benchmark=settings.benchmark
    )
    curve = store.daily_equity_curve()
    daily = store.daily_metrics()
    signals = LearningLoop(settings, store).signal_performance()
    trades = store.closed_trades()[-25:]
    events = store.recent_events(limit=20)
    risk_state = store.get_state("kill_switch") or {"active": False}

    cards = [
        ("Equity", _fmt_money(metrics.current_equity), _fmt_pct(metrics.return_pct)),
        ("P&L neto", _fmt_money(metrics.net_pnl), f"fees {_fmt_money(metrics.total_fees)}"),
        ("Trades", str(metrics.trades_total), f"win rate {_fmt_pct(metrics.win_rate)}"),
        ("Drawdown máx.", _fmt_pct(metrics.max_drawdown_pct), f"Sharpe {_fmt_num(metrics.sharpe_ratio)}"),
        (
            f"Benchmark {settings.benchmark}",
            _fmt_pct(metrics.benchmark_return_pct),
            f"exceso {_fmt_pct(metrics.excess_return_pct)}",
        ),
    ]

    document = _DASHBOARD_TEMPLATE.format(
        generated=html.escape(iso(utcnow())),
        mode="PAPER" if settings.is_paper else "LIVE",
        kill_switch="ACTIVO" if risk_state.get("active") else "inactivo",
        cards="".join(
            f'<div class="card"><h3>{html.escape(title)}</h3>'
            f'<p class="value">{html.escape(value)}</p>'
            f'<p class="sub">{html.escape(sub)}</p></div>'
            for title, value, sub in cards
        ),
        equity_chart=_sparkline([float(row["equity"]) for row in curve]),
        daily_rows=_table_rows(
            daily,
            ["trading_day", "start_equity", "end_equity", "net_pnl", "fees", "trades_closed", "wins", "losses"],
        ),
        signal_rows=_table_rows(
            signals, ["signal", "weight", "samples", "hit_rate", "ema_accuracy", "net_pnl"]
        ),
        trade_rows=_table_rows(
            trades,
            ["closed_day", "symbol", "quantity", "entry_price", "exit_price", "net_pnl", "exit_reason"],
        ),
        event_rows=_table_rows(events, ["created_at", "kind", "severity", "message"]),
        metrics_json=html.escape(json.dumps(metrics.as_dict(), indent=2)),
    )

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document, encoding="utf-8")
    return target


def _table_rows(rows: Sequence[Mapping[str, Any]], columns: Sequence[str]) -> str:
    if not rows:
        return f'<tr><td colspan="{len(columns)}" class="empty">Sin datos todavía</td></tr>'
    out = []
    for row in rows:
        cells = []
        for column in columns:
            value = row.get(column)
            if isinstance(value, float):
                text = f"{value:,.4f}"
            else:
                text = "-" if value is None else str(value)
            css = ""
            if column.endswith("pnl") and isinstance(value, (int, float)):
                css = ' class="pos"' if value > 0 else ' class="neg"'
            cells.append(f"<td{css}>{html.escape(text)}</td>")
        out.append("<tr>" + "".join(cells) + "</tr>")
    return "".join(out)


def _sparkline(values: Sequence[float], width: int = 720, height: int = 160) -> str:
    """Inline SVG equity curve - no chart library, no external requests."""
    if len(values) < 2:
        return '<p class="empty">Se necesitan al menos dos puntos de equity.</p>'
    low, high = min(values), max(values)
    span = (high - low) or 1.0
    step = width / (len(values) - 1)
    points = " ".join(
        f"{index * step:.1f},{height - ((value - low) / span) * (height - 20) - 10:.1f}"
        for index, value in enumerate(values)
    )
    trend = "pos" if values[-1] >= values[0] else "neg"
    return (
        f'<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" class="spark {trend}">'
        f'<polyline points="{points}" fill="none" stroke-width="2" />'
        f"</svg>"
        f'<p class="sub">min {low:,.2f} · max {high:,.2f} · puntos {len(values)}</p>'
    )


_DASHBOARD_TEMPLATE = """<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trading Bot · Dashboard</title>
<style>
  :root {{
    --bg: #0f1117; --panel: #171a23; --line: #262b38; --text: #e6e8ef;
    --muted: #8b93a7; --pos: #3ecf8e; --neg: #ff6b6b; --accent: #6c8cff;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 32px; background: var(--bg); color: var(--text);
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }}
  h1 {{ margin: 0 0 4px; font-size: 22px; }}
  h2 {{ margin: 32px 0 12px; font-size: 16px; color: var(--muted);
        text-transform: uppercase; letter-spacing: .08em; }}
  .meta {{ color: var(--muted); font-size: 13px; margin-bottom: 24px; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 999px;
            background: var(--panel); border: 1px solid var(--line); margin-left: 8px; }}
  .cards {{ display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }}
  .card {{ background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }}
  .card h3 {{ margin: 0 0 8px; font-size: 12px; color: var(--muted);
              text-transform: uppercase; letter-spacing: .06em; }}
  .value {{ margin: 0; font-size: 24px; font-weight: 600; }}
  .sub {{ margin: 4px 0 0; color: var(--muted); font-size: 13px; }}
  table {{ width: 100%; border-collapse: collapse; background: var(--panel);
           border: 1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 13px; }}
  th, td {{ padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }}
  th {{ color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; }}
  tr:last-child td {{ border-bottom: none; }}
  .pos {{ color: var(--pos); }} .neg {{ color: var(--neg); }}
  .empty {{ color: var(--muted); font-style: italic; }}
  .spark polyline {{ stroke: var(--accent); }}
  .spark.pos polyline {{ stroke: var(--pos); }}
  .spark.neg polyline {{ stroke: var(--neg); }}
  svg {{ width: 100%; height: 160px; background: var(--panel);
         border: 1px solid var(--line); border-radius: 12px; }}
  pre {{ background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
         padding: 16px; overflow-x: auto; font-size: 12px; color: var(--muted); }}
  .wrap {{ overflow-x: auto; }}
</style>
</head>
<body>
  <h1>Trading Bot · Dashboard</h1>
  <p class="meta">Generado {generated}
    <span class="badge">Modo {mode}</span>
    <span class="badge">Kill switch: {kill_switch}</span>
  </p>

  <div class="cards">{cards}</div>

  <h2>Curva de equity</h2>
  {equity_chart}

  <h2>Resultados diarios</h2>
  <div class="wrap"><table>
    <tr><th>Día</th><th>Equity inicial</th><th>Equity final</th><th>P&amp;L neto</th>
        <th>Fees</th><th>Cerrados</th><th>W</th><th>L</th></tr>
    {daily_rows}
  </table></div>

  <h2>Desempeño por señal</h2>
  <div class="wrap"><table>
    <tr><th>Señal</th><th>Peso</th><th>Muestras</th><th>Acierto</th><th>EMA</th><th>P&amp;L neto</th></tr>
    {signal_rows}
  </table></div>

  <h2>Últimos trades cerrados</h2>
  <div class="wrap"><table>
    <tr><th>Día</th><th>Símbolo</th><th>Cantidad</th><th>Entrada</th><th>Salida</th>
        <th>P&amp;L neto</th><th>Motivo</th></tr>
    {trade_rows}
  </table></div>

  <h2>Eventos recientes</h2>
  <div class="wrap"><table>
    <tr><th>Fecha</th><th>Tipo</th><th>Severidad</th><th>Mensaje</th></tr>
    {event_rows}
  </table></div>

  <h2>Métricas acumuladas</h2>
  <pre>{metrics_json}</pre>
</body>
</html>
"""

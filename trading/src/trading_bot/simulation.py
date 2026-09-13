"""Offline end-to-end validation of a deployment.

``trading-bot simulate`` compresses several trading days into a few seconds
against :class:`~trading_bot.brokers.simulator.SimulatedBroker`, exercising every
moving part the live bot uses: session gating, news ingestion and
classification, signal fusion, the risk gate, order placement and fills, exits,
the nightly learning loop, metrics, the daily report and the dashboard.

Then it *checks itself*. The value is not the P&L - the prices are synthetic and
mean nothing - it is the list of assertions about the environment:

* Did the scheduler respect the exchange calendar?
* Did approved orders reach the broker, and did fills become trades?
* Did every trade end up with a recorded justification?
* Is the cash accounting internally consistent?
* Did the nightly job run, grade trades and move the signal weights?
* Were the report and the dashboard actually produced?

Run it after every deploy, before pointing anything at a real account.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from .brokers.base import BrokerError
from .brokers.simulator import SimulatedBroker
from .calendars import ExchangeCalendar
from .clock import clear_time_source, set_time_source, to_utc, utcnow
from .config import Settings
from .db import Store
from .engine import TradingEngine
from .logging_setup import get_logger

log = get_logger(__name__)

OK = "ok"
WARN = "warn"
FAIL = "fail"


@dataclass
class Check:
    """One assertion about the environment."""

    name: str
    status: str
    detail: str = ""

    @property
    def symbol(self) -> str:
        return {OK: "✓", WARN: "!", FAIL: "✗"}[self.status]

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


@dataclass
class SimulationReport:
    """Result of a simulated run plus the self-checks."""

    days: int
    cycles: int
    news_cycles: int
    nightlies: int
    checks: list[Check] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)
    session_counts: dict[str, int] = field(default_factory=dict)
    started_at: str = ""
    ended_at: str = ""

    @property
    def failures(self) -> list[Check]:
        return [check for check in self.checks if check.status == FAIL]

    @property
    def warnings(self) -> list[Check]:
        return [check for check in self.checks if check.status == WARN]

    @property
    def passed(self) -> bool:
        return not self.failures

    def as_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "days": self.days,
            "cycles": self.cycles,
            "news_cycles": self.news_cycles,
            "nightlies": self.nightlies,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "session_counts": self.session_counts,
            "stats": self.stats,
            "checks": [check.as_dict() for check in self.checks],
        }

    def text(self) -> str:
        lines = [
            "Simulación del ambiente (broker sintético, sin credenciales)",
            "",
            f"  Periodo simulado: {self.started_at} → {self.ended_at} ({self.days} días)",
            f"  Ciclos de trading: {self.cycles} · noticias: {self.news_cycles} · "
            f"cierres nocturnos: {self.nightlies}",
            f"  Sesiones vistas: "
            + (", ".join(f"{k}={v}" for k, v in sorted(self.session_counts.items())) or "ninguna"),
            "",
            "  Verificaciones:",
        ]
        for check in self.checks:
            detail = f" — {check.detail}" if check.detail else ""
            lines.append(f"    {check.symbol} {check.name}{detail}")

        lines.append("")
        if self.stats:
            lines.append("  Actividad registrada:")
            for key, value in self.stats.items():
                lines.append(f"    {key}: {value}")
            lines.append("")

        if self.failures:
            lines.append(f"  RESULTADO: FALLÓ ({len(self.failures)} verificaciones críticas)")
        elif self.warnings:
            lines.append(f"  RESULTADO: OK con {len(self.warnings)} advertencias")
        else:
            lines.append("  RESULTADO: OK — el ambiente está operativo")
        lines.append("")
        lines.append("  Los precios son sintéticos: el P&L de esta corrida no significa nada.")
        lines.append("  Lo que se valida es la mecánica, no la estrategia (para eso: backtest).")
        return "\n".join(lines)


class _SilentAlerter:
    """Swallows alerts during a simulation, counting them instead of sending."""

    def __init__(self, real: Any) -> None:
        self.settings = getattr(real, "settings", None)
        self.sent: list[tuple[str, str]] = []

    @property
    def channels(self) -> list[str]:
        return []

    def send(self, subject: str, body: str = "", *, severity: str = "info", **context: Any) -> bool:
        self.sent.append((severity, subject))
        log.debug("simulated_alert", extra={"event": {"subject": subject, "severity": severity}})
        return True


def default_start(calendar: ExchangeCalendar, reference: datetime | None = None) -> datetime:
    """Open of the first trading day of the reference week, in UTC."""
    local_now = calendar.local(reference or utcnow())
    monday = local_now.date() - timedelta(days=local_now.weekday())
    day = monday
    for _ in range(7):
        if calendar.is_trading_day(day):
            break
        day += timedelta(days=1)
    opening = datetime.combine(day, calendar.open_time, tzinfo=calendar.zone)
    return to_utc(opening)


def run_simulation(
    settings: Settings,
    *,
    days: int = 5,
    seed: int = 42,
    step_minutes: int = 5,
    start: datetime | date | None = None,
    store: Store | None = None,
    reject_rate: float = 0.0,
    outage_rate: float = 0.0,
    reports_dir: str | Path | None = None,
) -> SimulationReport:
    """Run ``days`` simulated trading days and validate the environment."""
    from .calendars import load_calendar

    calendar = load_calendar(
        getattr(settings, "exchange", None),
        path=getattr(settings, "exchange_calendar_file", "") or None,
    )

    if isinstance(start, date) and not isinstance(start, datetime):
        begin = to_utc(datetime.combine(start, calendar.open_time, tzinfo=calendar.zone))
    else:
        begin = to_utc(start) if start else default_start(calendar)

    universe = list(dict.fromkeys([*settings.universe, settings.benchmark]))
    broker = SimulatedBroker(
        universe,
        equity=settings.risk.starting_equity,
        start=begin,
        seed=seed,
        calendar=calendar,
        reject_rate=reject_rate,
        outage_rate=outage_rate,
    )

    owned_store = store is None
    store = store or Store(":memory:")
    report = SimulationReport(days=days, cycles=0, news_cycles=0, nightlies=0)
    report.started_at = begin.isoformat()

    # The whole system reads the clock through trading_bot.clock, so pointing it
    # at the simulator is what makes a multi-day run possible in seconds.
    set_time_source(lambda: broker.now)
    try:
        engine = TradingEngine(settings, store=store, broker=broker)
        # Isolation: a validation run must not overwrite the real dashboard with
        # synthetic numbers, and must never send a Telegram or an email with
        # fabricated P&L to whoever is monitoring the live bot.
        sim_reports = Path(reports_dir) if reports_dir else Path("reports") / "simulated"
        sim_reports.mkdir(parents=True, exist_ok=True)
        engine.dashboard_path = str(sim_reports / "dashboard.html")
        engine.alerter = _SilentAlerter(engine.alerter)
        startup_error = ""
        try:
            engine.start_experiment()
        except BrokerError as exc:
            # Under an injected outage rate this is expected; record it and keep
            # going so the rest of the environment still gets exercised.
            startup_error = str(exc)
            log.warning("simulation_startup_degraded", extra={"event": {"error": startup_error}})

        trading_days_seen: set[date] = set()
        nightly_done: set[date] = set()
        last_trade_cycle = last_news_cycle = begin - timedelta(days=1)
        session_counts: dict[str, int] = {}
        errors: list[str] = []

        while len(trading_days_seen) <= days:
            session = broker.session()
            session_counts[session] = session_counts.get(session, 0) + 1
            local = calendar.local(broker.now)

            if session == "open":
                trading_days_seen.add(local.date())
                if len(trading_days_seen) > days:
                    break
                if broker.now - last_trade_cycle >= timedelta(minutes=settings.trade_interval_minutes):
                    last_trade_cycle = broker.now
                    result = engine.trading_cycle()
                    report.cycles += 1
                    if isinstance(result, dict) and result.get("error"):
                        errors.append(str(result["error"]))

            if broker.now - last_news_cycle >= timedelta(minutes=settings.news_interval_minutes):
                last_news_cycle = broker.now
                outcome = engine.news_cycle(lookback_hours=6.0)
                report.news_cycles += 1
                if isinstance(outcome, dict) and outcome.get("error"):
                    errors.append(str(outcome["error"]))

            # After the close, run the nightly job once for that date.
            if (
                session in ("afterhours", "closed")
                and local.time() >= time(16, 30)
                and local.date() in trading_days_seen
                and local.date() not in nightly_done
            ):
                nightly_done.add(local.date())
                engine.nightly()
                report.nightlies += 1

            broker.advance(timedelta(minutes=step_minutes))

        report.ended_at = broker.now.isoformat()
        report.session_counts = session_counts
        _collect(report, engine, store, broker, errors, sim_reports, startup_error)
        return report
    finally:
        clear_time_source()
        if owned_store:
            store.close()


def _final_equity(broker: SimulatedBroker) -> float | str:
    """Equity at the end of the run - the simulator may be injecting outages."""
    try:
        return round(broker.get_account().equity, 4)
    except BrokerError:
        return "no disponible (outage simulado)"


def _collect(
    report: SimulationReport,
    engine: TradingEngine,
    store: Store,
    broker: SimulatedBroker,
    errors: list[str],
    reports_dir: str | Path | None,
    startup_error: str = "",
) -> None:
    """Turn the run into the checks that actually matter."""
    decisions = store._rows("SELECT approved, reason FROM decisions")  # noqa: SLF001
    approved = [row for row in decisions if row["approved"]]
    orders = store._rows("SELECT status, intent FROM orders")  # noqa: SLF001
    filled = [row for row in orders if row["status"] == "filled"]
    closed = store.closed_trades()
    open_trades = store.open_trades()
    weights = store.weight_values()
    critical = [
        event for event in store.recent_events(limit=500)
        if event.get("severity") in ("error", "critical")
    ]

    report.stats = {
        "decisiones": len(decisions),
        "aprobadas": len(approved),
        "órdenes enviadas": len(broker.submitted),
        "órdenes llenadas": len(filled),
        "trades cerrados": len(closed),
        "trades abiertos al final": len(open_trades),
        "noticias almacenadas": len(store._rows("SELECT id FROM news_items")),  # noqa: SLF001
        "sentimiento clasificado": len(store._rows("SELECT id FROM sentiment_scores")),  # noqa: SLF001
        "equity final": _final_equity(broker),
    }

    add = report.checks.append

    add(Check(
        "Arranque del experimento",
        OK if not startup_error else WARN,
        "día 0 registrado" if not startup_error
        else f"arranque degradado tras reintentos: {startup_error[:120]}",
    ))

    # --- the scheduler respected the calendar ---------------------------------
    off_session = [
        entry for entry in broker.submitted
        if broker.calendar.session(to_utc(datetime.fromisoformat(entry["at"]))) != "open"
    ]
    add(Check(
        "Órdenes solo en horario de mercado",
        OK if not off_session else FAIL,
        "ninguna orden fuera de sesión" if not off_session
        else f"{len(off_session)} órdenes enviadas fuera de sesión",
    ))

    # --- the pipeline produced decisions -------------------------------------
    add(Check(
        "El motor evaluó decisiones",
        OK if decisions else FAIL,
        f"{len(decisions)} decisiones registradas" if decisions
        else "no se registró ninguna decisión: el ciclo no llegó a evaluar señales",
    ))

    add(Check(
        "Toda decisión tiene motivo registrado",
        OK if all(row["reason"] for row in decisions) else FAIL,
        "auditoría completa" if all(row["reason"] for row in decisions)
        else "hay decisiones sin motivo",
    ))

    # --- news pipeline --------------------------------------------------------
    news_count = report.stats["noticias almacenadas"]
    sentiment_count = report.stats["sentimiento clasificado"]
    add(Check(
        "NewsPulse ingirió y clasificó noticias",
        OK if news_count and sentiment_count else WARN,
        f"{news_count} noticias, {sentiment_count} clasificaciones"
        if news_count else "no se ingirió ninguna noticia",
    ))

    # --- execution ------------------------------------------------------------
    if approved:
        # An approval that never reached the broker is a bug — unless the broker
        # itself was failing, which is exactly what --outage-rate injects.
        submission_failures = [
            event for event in store.recent_events(limit=500)
            if event.get("kind") in ("entry_order_failed", "exit_order_failed")
        ]
        if broker.submitted:
            status, detail = OK, f"{len(broker.submitted)} órdenes enviadas"
        elif submission_failures:
            status, detail = WARN, (
                f"{len(submission_failures)} envíos fallaron por errores del broker "
                "(esperado con --outage-rate)"
            )
        else:
            status, detail = FAIL, "se aprobaron decisiones pero no se envió ninguna orden"
        add(Check("Las aprobaciones llegaron al broker", status, detail))
        add(Check(
            "Los fills se convirtieron en trades",
            OK if (closed or open_trades) else (WARN if not filled else FAIL),
            f"{len(closed)} cerrados, {len(open_trades)} abiertos" if (closed or open_trades)
            else "hubo fills sin trade asociado" if filled
            else "ninguna orden se llenó en el periodo simulado",
        ))
    else:
        add(Check(
            "Filtro de costos activo",
            OK,
            "ninguna decisión pasó el filtro de EV neto: correcto si el edge no cubre costos",
        ))

    # --- accounting -----------------------------------------------------------
    if closed:
        inconsistent = [
            trade for trade in closed
            if trade.get("net_pnl") is None
            or abs((trade["gross_pnl"] or 0) - (trade["fees"] or 0) - trade["net_pnl"]) > 1e-6
        ]
        add(Check(
            "Contabilidad neta consistente",
            OK if not inconsistent else FAIL,
            "net = bruto − fees en todos los trades" if not inconsistent
            else f"{len(inconsistent)} trades con contabilidad inconsistente",
        ))
        no_justification = [trade for trade in closed if not trade.get("decision_id")]
        add(Check(
            "Todo trade tiene justificación",
            OK if not no_justification else FAIL,
            "cada trade apunta a su decisión" if not no_justification
            else f"{len(no_justification)} trades sin decisión asociada",
        ))

    # --- nightly --------------------------------------------------------------
    add(Check(
        "Ciclo nocturno ejecutado",
        OK if report.nightlies else FAIL,
        f"{report.nightlies} cierres procesados" if report.nightlies
        else "el job nocturno nunca corrió",
    ))
    add(Check(
        "Pesos de señales persistidos",
        OK if weights else FAIL,
        f"{len(weights)} señales con peso" if weights else "la tabla de pesos quedó vacía",
    ))
    if closed:
        reviewed = [trade for trade in closed if trade.get("reviewed")]
        add(Check(
            "LearningLoop calificó los trades cerrados",
            OK if reviewed else WARN,
            f"{len(reviewed)}/{len(closed)} revisados",
        ))

    # --- reporting ------------------------------------------------------------
    metrics = store.daily_metrics()
    add(Check(
        "Métricas diarias calculadas",
        OK if metrics else WARN,
        f"{len(metrics)} días con métricas" if metrics else "no se guardaron métricas diarias",
    ))
    dashboard = Path(reports_dir or "reports") / "dashboard.html"
    add(Check(
        "Dashboard generado",
        OK if dashboard.is_file() else WARN,
        str(dashboard) if dashboard.is_file() else f"no se encontró {dashboard}",
    ))

    # --- every filled entry must have become a trade --------------------------
    filled_entries = [row for row in orders if row["status"] == "filled" and row["intent"] == "entry"]
    all_trades = closed + open_trades
    if filled_entries:
        add(Check(
            "Ningún fill quedó sin trade",
            OK if len(all_trades) >= len(filled_entries) else FAIL,
            f"{len(filled_entries)} entradas llenadas, {len(all_trades)} trades"
            if len(all_trades) >= len(filled_entries)
            else f"{len(filled_entries) - len(all_trades)} fills sin trade: "
                 "esas acciones quedarían sin stop loss",
        ))

    # --- the broker and the database must agree on what is held ---------------
    try:
        broker_positions = {
            position.symbol: position.quantity for position in broker.get_positions()
        }
    except BrokerError:
        broker_positions = None
    if broker_positions is not None:
        tracked = {str(trade["symbol"]).upper() for trade in open_trades}
        untracked = sorted(set(broker_positions) - tracked)
        add(Check(
            "Posiciones del broker reconciliadas",
            OK if not untracked else FAIL,
            "la base de datos refleja lo que el broker tiene" if not untracked
            else f"posiciones sin seguimiento: {', '.join(untracked)}",
        ))

    # --- cash accounting ------------------------------------------------------
    if closed and broker_positions is not None:
        realized = sum(float(trade.get("net_pnl") or 0.0) for trade in closed)
        try:
            equity = broker.get_account().equity
        except BrokerError:
            equity = None
        if equity is not None:
            unrealized = sum(
                (position.current_price - position.avg_entry_price) * position.quantity
                for position in broker.get_positions()
            )
            expected = engine.settings.risk.starting_equity + realized + unrealized
            drift = abs(equity - expected)
            add(Check(
                "Efectivo y P&L cuadran",
                OK if drift < 0.05 else WARN,
                f"desvío ${drift:.4f} (incluye costos de ejecución en tránsito)",
            ))

    # --- position sizing actually bound --------------------------------------
    cap = engine.settings.risk.starting_equity * engine.settings.risk.max_position_pct
    oversized = []
    for trade in all_trades:
        notional = float(trade["quantity"]) * float(trade["entry_price"])
        if notional > cap * 1.05:
            oversized.append(f"{trade['symbol']} ${notional:.2f}")
    add(Check(
        "Límite por posición respetado",
        OK if not oversized else FAIL,
        f"ninguna posición sobre ${cap:.2f}" if not oversized
        else f"posiciones sobre el límite: {', '.join(oversized[:4])}",
    ))

    # --- no symbol ended up with two concurrent entries ----------------------
    duplicate_symbols = sorted(
        {
            str(trade["symbol"]).upper()
            for trade in open_trades
            if sum(1 for other in open_trades if other["symbol"] == trade["symbol"]) > 1
        }
    )
    add(Check(
        "Sin posiciones apiladas en un símbolo",
        OK if not duplicate_symbols else FAIL,
        "un trade abierto por símbolo" if not duplicate_symbols
        else f"apilado en: {', '.join(duplicate_symbols)}",
    ))

    # --- resilience -----------------------------------------------------------
    add(Check(
        "Sin errores no manejados",
        OK if not errors else WARN,
        "ningún ciclo devolvió error" if not errors
        else f"{len(errors)} ciclos con error (el circuit breaker los absorbió)",
    ))
    kill_active = engine.risk.kill_switch_active()
    add(Check(
        "Kill switch en reposo",
        OK if not kill_active else WARN,
        "inactivo" if not kill_active else f"activo: {engine.risk.kill_switch_reason()}",
    ))
    if kill_active and open_trades:
        # The combination that matters: trading stopped *and* risk still on the
        # table. A run must not report success in that state.
        add(Check(
            "Sin posiciones abandonadas tras el kill switch",
            FAIL,
            f"{len(open_trades)} posiciones abiertas con el kill switch activo",
        ))
    if critical:
        add(Check(
            "Eventos críticos",
            WARN,
            ", ".join(sorted({event["kind"] for event in critical}))[:200],
        ))

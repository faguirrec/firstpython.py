"""Engine - wires the four agents together and owns the run loop's unit of work.

Everything the scheduler calls lives here as a plain method, so each job can also
be invoked once from the CLI for debugging.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from .agents.learning_loop import LearningLoop
from .agents.news_pulse import NewsPulse
from .agents.risk_sentinel import RiskSentinel
from .agents.trader_core import TraderCore
from .alerts import Alerter
from .brokers.alpaca import AlpacaBroker
from .calendars import load_calendar
from .brokers.base import BrokerError
from .circuit_breaker import CircuitBreaker
from .clock import iso, local_session, parse_iso, trading_day, utcnow
from .config import Settings
from .db import Store
from .logging_setup import get_logger
from .marketdata import build_market_data
from .metrics import compute_metrics, daily_snapshot
from .retry import with_retries
from .reporting import daily_report, final_report, write_dashboard

log = get_logger(__name__)

EXPERIMENT_START_KEY = "experiment_started_at"
LAST_DAILY_REPORT_KEY = "last_daily_report"


class TradingEngine:
    """Composition root: one object that owns the store, broker and agents."""

    def __init__(self, settings: Settings, *, store: Store | None = None, broker: Any | None = None) -> None:
        self.settings = settings
        self.store = store or Store(settings.database_url)
        self.broker = broker or AlpacaBroker(
            settings.alpaca_api_key, settings.alpaca_secret_key, base_url=settings.alpaca_base_url
        )
        self.alerter = Alerter(settings)
        # Where nightly writes the dashboard. The simulator redirects this so a
        # validation run cannot overwrite real experiment results.
        self.dashboard_path = "reports/dashboard.html"
        self.calendar = load_calendar(
            settings.exchange,
            path=settings.exchange_calendar_file or None,
            extra_holidays=settings.exchange_extra_holidays,
        )
        self.data = build_market_data(settings, self.broker)
        self.risk = RiskSentinel(settings, self.store)
        self.news = NewsPulse(settings, self.store, self.broker)
        self.trader = TraderCore(
            settings, self.store, self.broker, self.risk, news=self.news, data=self.data
        )
        self.learning = LearningLoop(settings, self.store)
        self.breaker = CircuitBreaker(
            self.store,
            "trading",
            threshold=settings.risk.consecutive_error_limit,
            on_trip=self._on_circuit_trip,
            on_escalate=self._on_circuit_escalation,
        )
        self.news_breaker = CircuitBreaker(
            self.store, "news", threshold=max(settings.risk.consecutive_error_limit, 3)
        )

    # ------------------------------------------------------------------- jobs
    def trading_cycle(self) -> dict[str, Any]:
        """One TraderCore cycle.

        A tripped breaker or an engaged kill switch disables **entries only**.
        Reconciliation and exit management keep running: an open position with a
        pending stop loss is exactly what must not be abandoned when something
        has gone wrong.
        """
        entries_enabled = True
        gate_reason = ""
        if self.breaker.is_open():
            entries_enabled = False
            gate_reason = "circuit_open"
        elif self.risk.kill_switch_active():
            entries_enabled = False
            gate_reason = f"kill_switch:{self.risk.kill_switch_reason()}"

        if not entries_enabled:
            log.warning(
                "entries_disabled_exits_continue",
                extra={"event": {"reason": gate_reason}},
            )

        try:
            report = self.trader.run_cycle(entries_enabled=entries_enabled)
        except Exception as exc:  # noqa: BLE001 - a cycle failure must not kill the process
            self.breaker.record_failure(str(exc))
            log.exception("trading_cycle_failed")
            return {"error": str(exc)}

        if not entries_enabled:
            payload = report.as_dict()
            payload["entries_disabled"] = gate_reason
            return payload

        self.breaker.record_success()
        self._check_daily_limits()
        log.info("trading_cycle", extra={"event": report.as_dict()})
        return report.as_dict()

    def news_cycle(self, *, lookback_hours: float = 6.0) -> dict[str, Any]:
        """One NewsPulse ingest+classify pass."""
        if self.news_breaker.is_open():
            return {"skipped": "circuit_open"}
        try:
            result = self.news.run_cycle(lookback_hours=lookback_hours)
        except Exception as exc:  # noqa: BLE001
            self.news_breaker.record_failure(str(exc))
            log.exception("news_cycle_failed")
            return {"error": str(exc)}
        self.news_breaker.record_success()
        return result

    def nightly(self) -> dict[str, Any]:
        """Post-close: reconcile, review, compute metrics, report, refresh dashboard."""
        results: dict[str, Any] = {"ran_at": iso(utcnow())}
        try:
            results["fills_synced"] = self.trader.sync_orders()
        except Exception as exc:  # noqa: BLE001
            results["sync_error"] = str(exc)

        results["learning"] = self.learning.run()
        results["daily"] = daily_snapshot(self.store)

        report = daily_report(self.settings, self.store)
        results["report"] = report["text"]
        self.alerter.send(
            f"Resumen diario {report['day']}", report["text"], severity="info"
        )
        try:
            results["dashboard"] = str(
                write_dashboard(self.settings, self.store, self.dashboard_path)
            )
        except OSError as exc:
            results["dashboard_error"] = str(exc)

        self.store.set_state(LAST_DAILY_REPORT_KEY, report["day"])
        self.store.record_event("nightly_complete", report["day"])
        self._check_experiment_end()
        return results

    def heartbeat(self) -> dict[str, Any]:
        """Cheap liveness job: record equity and surface a broken account early."""
        try:
            account = self.broker.get_account()
        except BrokerError as exc:
            self.breaker.record_failure(str(exc))
            return {"error": str(exc)}
        positions = []
        try:
            positions = self.broker.get_positions()
        except BrokerError:
            pass
        self.store.record_equity(
            {
                "equity": account.equity,
                "cash": account.cash,
                "buying_power": account.buying_power,
                "position_value": sum(p.market_value for p in positions),
                "trading_day": trading_day().isoformat(),
            }
        )
        self.breaker.record_success()
        return {"equity": account.equity, "session": local_session(), "positions": len(positions)}

    # --------------------------------------------------------------- controls
    def _on_circuit_trip(self, name: str, failures: int, error: str) -> None:
        self.alerter.send(
            f"Circuit breaker abierto: {name}",
            f"{failures} fallos consecutivos.\nÚltimo error: {error[:400]}",
            severity="critical",
        )

    def _on_circuit_escalation(self, name: str, trips: int, error: str) -> None:
        """A dependency that keeps failing becomes a human's problem."""
        self.risk.engage_kill_switch(f"circuit_escalated:{name}", trips=trips, error=error[:300])
        self.alerter.send(
            f"Kill switch por fallos repetidos: {name}",
            f"{trips} aperturas del circuit breaker. Último error: {error[:400]}\n"
            "Las entradas quedan bloqueadas; las salidas siguen operando.",
            severity="critical",
        )

    def _check_daily_limits(self) -> None:
        """Alert (and stop) when a hard limit is hit during the session."""
        try:
            account = self.broker.get_account()
        except BrokerError:
            return
        daily = self.risk.daily_loss_state(account)
        drawdown = self.risk.drawdown_state(account)
        if drawdown["breached"]:
            self.alerter.send(
                "Drawdown máximo alcanzado",
                f"Equity {drawdown['current_equity']} vs pico {drawdown['peak_equity']}.",
                severity="critical",
                **drawdown,
            )
        elif daily["breached"]:
            self.store.record_event("daily_loss_limit", "trading paused for the day", severity="warning", **daily)
            self.alerter.send(
                "Límite de pérdida diaria alcanzado",
                f"P&L del día {daily['day_pnl']} (límite {daily['limit_usd']}).",
                severity="warning",
                **daily,
            )

    def engage_kill_switch(self, reason: str) -> None:
        self.risk.engage_kill_switch(reason)
        self.alerter.send("Kill switch activado", reason, severity="critical")

    def release_kill_switch(self, note: str = "manual release") -> None:
        self.risk.release_kill_switch(note)
        self.breaker.reset()
        self.alerter.send("Kill switch liberado", note, severity="warning")

    def flatten_all(self, reason: str = "manual") -> dict[str, Any]:
        """Cancel every order and close every position. The emergency exit."""
        self.broker.cancel_all_orders()
        self.broker.close_all_positions(cancel_orders=True)
        self.store.record_event("flatten_all", reason, severity="critical")
        self.alerter.send("Posiciones cerradas", reason, severity="critical")
        return {"flattened": True, "reason": reason}

    # ------------------------------------------------------------ experiment
    def _account_with_retry(self, *, attempts: int = 3) -> Any:
        """Fetch the account, tolerating a transient outage.

        Startup is the one place a broker hiccup could kill the process before
        the scheduler exists to absorb it, so it gets its own retry.
        """
        return with_retries(
            self.broker.get_account,
            attempts=attempts,
            base=2.0,
            cap=10.0,
            retry_on=(BrokerError,),
            description="get_account[startup]",
        )

    def start_experiment(self) -> dict[str, Any]:
        """Mark day 0 and record the starting conditions for the final report."""
        account = self._account_with_retry()
        started = self.store.get_state(EXPERIMENT_START_KEY)
        if started:
            return {"already_started": started, "equity": account.equity}

        now = iso(utcnow())
        self.store.set_state(EXPERIMENT_START_KEY, now)
        self.store.set_state("experiment_start_equity", account.equity)
        self.store.set_state(
            "experiment_config", self.settings.redacted()
        )
        self.store.record_equity(
            {"equity": account.equity, "cash": account.cash, "buying_power": account.buying_power}
        )
        self.store.record_event(
            "experiment_started",
            f"{self.settings.experiment_days} días, equity inicial {account.equity}",
            severity="info",
            equity=account.equity,
            mode="paper" if self.settings.is_paper else "live",
        )
        self.risk.release_kill_switch("experiment start")
        self.alerter.send(
            "Experimento iniciado",
            f"Modo {'PAPER' if self.settings.is_paper else 'LIVE'}, "
            f"equity {account.equity}, {self.settings.experiment_days} días.",
        )
        return {"started_at": now, "equity": account.equity}

    def _check_experiment_end(self) -> None:
        started = self.store.get_state(EXPERIMENT_START_KEY)
        if not isinstance(started, str):
            return
        start = parse_iso(started)
        if start is None:
            return
        if utcnow() - start < timedelta(days=self.settings.experiment_days):
            return
        if self.store.get_state("experiment_final_report_sent"):
            return
        report = final_report(self.settings, self.store)
        self.store.set_state("experiment_final_report_sent", iso(utcnow()))
        self.store.record_event("experiment_complete", report["recommendation"], severity="info")
        self.alerter.send("Reporte final del experimento", report["text"], severity="info")
        log.info("experiment_complete", extra={"event": {"recommendation": report["recommendation"]}})

    # ----------------------------------------------------------------- status
    def status(self) -> dict[str, Any]:
        """Everything an operator needs in one call."""
        payload: dict[str, Any] = {
            "checked_at": iso(utcnow()),
            "mode": "paper" if self.settings.is_paper else "live",
            "session": self.calendar.session(),
            "calendar": self.calendar.describe(),
            "market_data": self.data.describe(),
            "kill_switch": self.store.get_state("kill_switch") or {"active": False},
            "circuit_trading": self.breaker.state().as_dict(),
            "circuit_news": self.news_breaker.state().as_dict(),
            "experiment_started_at": self.store.get_state(EXPERIMENT_START_KEY),
            "open_trades": len(self.store.open_trades()),
            "open_orders": len(self.store.open_orders()),
        }
        last_tick = self.store.get_state("last_tick")
        payload["last_tick"] = last_tick if isinstance(last_tick, str) else None
        moment = parse_iso(last_tick) if isinstance(last_tick, str) else None
        payload["last_tick_age_seconds"] = (
            round((utcnow() - moment).total_seconds(), 1) if moment else None
        )
        try:
            account = self.broker.get_account()
            positions = self.broker.get_positions()
            payload["broker_session"] = self.broker.session()
            payload["risk"] = self.risk.snapshot(account, positions)
            payload["positions"] = [
                {"symbol": p.symbol, "qty": p.quantity, "value": p.market_value,
                 "unrealized_pl": p.unrealized_pl}
                for p in positions
            ]
        except BrokerError as exc:
            payload["broker_error"] = str(exc)
        payload["metrics"] = compute_metrics(
            self.store,
            starting_equity=self.settings.risk.starting_equity,
            benchmark=self.settings.benchmark,
        ).as_dict()
        return payload

    def close(self) -> None:
        self.store.close()

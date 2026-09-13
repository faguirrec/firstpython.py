"""24/7 scheduler.

The bot runs continuously but does different work depending on the session:

* **market open** - full trading cycles (signals, risk, execution),
* **pre/post-market** - monitoring and news only; no execution, because Alpaca
  rejects fractional orders outside regular hours,
* **market closed** - news ingestion and, once per evening, the learning loop
  plus the daily report.

APScheduler is used when installed; otherwise a stdlib loop with the same job
definitions takes over, so the bot has no hard dependency on it.
"""

from __future__ import annotations

import signal
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .calendars import BREAK, ExchangeCalendar, load_calendar
from .clock import iso, utcnow
from .config import Settings
from .engine import TradingEngine
from .logging_setup import get_logger

log = get_logger(__name__)


@dataclass
class Job:
    """A periodic unit of work plus the sessions it is allowed to run in."""

    name: str
    func: Callable[[], Any]
    interval_seconds: float
    sessions: tuple[str, ...] = ("open", "break", "premarket", "afterhours", "closed")
    next_run: float = 0.0

    def due(self, now: float) -> bool:
        return now >= self.next_run

    def schedule_next(self, now: float) -> None:
        self.next_run = now + self.interval_seconds


class BotScheduler:
    """Session-aware job runner around :class:`TradingEngine`."""

    def __init__(
        self,
        settings: Settings,
        engine: TradingEngine | None = None,
        *,
        calendar: ExchangeCalendar | None = None,
    ) -> None:
        self.settings = settings
        self.engine = engine or TradingEngine(settings)
        # Every window the scheduler uses comes from the configured exchange
        # calendar, so pointing the bot at another market is a config change.
        self.calendar = calendar or load_calendar(
            settings.exchange,
            path=settings.exchange_calendar_file or None,
            extra_holidays=settings.exchange_extra_holidays,
        )
        self._stop = threading.Event()
        # Seeded from the database so a restart after the close does not re-run
        # the nightly job and re-send the daily report.
        stored = self.engine.store.get_state("last_daily_report")
        self._nightly_done_for = stored if isinstance(stored, str) else None
        self.health: Any = None
        self.jobs = self._build_jobs()

    def _build_jobs(self) -> list[Job]:
        return [
            Job(
                "trading_cycle",
                self.engine.trading_cycle,
                self.settings.trade_interval_minutes * 60,
                sessions=("open",),
            ),
            Job(
                "news_cycle",
                lambda: self.engine.news_cycle(lookback_hours=6.0),
                self.settings.news_interval_minutes * 60,
                sessions=("open", BREAK, "premarket", "afterhours", "closed"),
            ),
            Job(
                "heartbeat",
                self.engine.heartbeat,
                15 * 60,
                sessions=("open", BREAK, "premarket", "afterhours"),
            ),
            Job("nightly", self._nightly_if_due, 10 * 60, sessions=("afterhours", "closed")),
        ]

    # -------------------------------------------------------------- lifecycle
    def run_forever(self, *, poll_seconds: float = 20.0) -> None:
        """Block, running jobs until interrupted. This is the 24/7 loop."""
        self._install_signal_handlers()
        self.start_health_server()
        log.info(
            "scheduler_started",
            extra={"event": {
                "mode": "paper" if self.settings.is_paper else "live",
                "jobs": [job.name for job in self.jobs],
                "universe": list(self.settings.universe),
                "exchange": self.calendar.code,
                "timezone": self.calendar.timezone,
                "session": self.session(),
                "next_open": (
                    self.calendar.next_open().isoformat() if self.calendar.next_open() else None
                ),
            }},
        )
        if self._try_apscheduler():
            return

        now = time.monotonic()
        for job in self.jobs:
            job.next_run = now  # run everything once at startup
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(poll_seconds)
        log.info("scheduler_stopped")

    def session(self) -> str:
        """Current session per the configured exchange calendar."""
        return self.calendar.session()

    def tick(self, *, now: float | None = None) -> list[str]:
        """Run every job that is due in the current session. Returns their names."""
        current = time.monotonic() if now is None else now
        session = self.session()
        ran: list[str] = []
        # Recorded every tick so something outside the process can tell whether
        # the scheduler is alive.
        self._record_tick()
        for job in self.jobs:
            if session not in job.sessions or not job.due(current):
                continue
            job.schedule_next(current)
            ran.append(job.name)
            try:
                result = job.func()
                log.debug("job_finished", extra={"event": {"job": job.name, "result": result}})
            except Exception as exc:  # noqa: BLE001 - one job must never stop the loop
                log.exception("job_failed", extra={"event": {"job": job.name, "error": str(exc)}})
        return ran

    def _record_tick(self) -> None:
        try:
            self.engine.store.set_state("last_tick", iso(utcnow()))
        except Exception as exc:  # noqa: BLE001 - liveness must never break the loop
            log.warning("heartbeat_write_failed", extra={"event": {"error": str(exc)}})

    def start_health_server(self) -> bool:
        """Expose /health and /status when HEALTH_PORT is configured."""
        from .health import HealthServer

        if self.settings.health_port <= 0:
            return False
        self.health = HealthServer(
            self.engine,
            port=self.settings.health_port,
            token=self.settings.health_token,
            stale_after_minutes=max(self.settings.trade_interval_minutes * 3, 30),
        )
        return self.health.start()

    def stop(self) -> None:
        self._stop.set()
        if self.health is not None:
            self.health.stop()

    def _install_signal_handlers(self) -> None:
        def handler(signum, _frame):  # pragma: no cover - process-level behaviour
            log.warning("signal_received", extra={"event": {"signal": signum}})
            self.stop()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):  # not on the main thread
                pass

    # ---------------------------------------------------------------- nightly
    def _nightly_if_due(self) -> dict[str, Any] | None:
        """Run the nightly job once per market day, after the close."""
        now = self.calendar.local()
        day = now.date().isoformat()
        if self._nightly_done_for == day:
            return None
        if not self.calendar.is_trading_day(now.date()):
            return None
        # Wait past the exchange's own close, plus a margin for fills to settle.
        if now.time() < self._nightly_after():
            return None
        self._nightly_done_for = day
        log.info("nightly_started", extra={"event": {"day": day}})
        return self.engine.nightly()

    def _nightly_after(self):
        """Local time from which the nightly job may run: close + 30 minutes."""
        from datetime import datetime, timedelta

        close = self.calendar.close_time
        stamp = datetime.combine(self.calendar.local().date(), close) + timedelta(minutes=30)
        return stamp.time()

    # ------------------------------------------------------------ apscheduler
    def _try_apscheduler(self) -> bool:
        """Use APScheduler when available; fall back to the stdlib loop."""
        try:
            from apscheduler.schedulers.blocking import BlockingScheduler
            from apscheduler.triggers.cron import CronTrigger
            from apscheduler.triggers.interval import IntervalTrigger
        except ImportError:
            log.info("apscheduler_unavailable_using_builtin_loop")
            return False

        scheduler = BlockingScheduler(timezone=self.calendar.timezone)
        scheduler.add_job(
            self._guarded(self.engine.trading_cycle, "trading_cycle"),
            IntervalTrigger(minutes=self.settings.trade_interval_minutes),
            id="trading_cycle",
            max_instances=1,
            coalesce=True,
        )
        scheduler.add_job(
            self._guarded(lambda: self.engine.news_cycle(lookback_hours=6.0), "news_cycle"),
            IntervalTrigger(minutes=self.settings.news_interval_minutes),
            id="news_cycle",
            max_instances=1,
            coalesce=True,
        )
        scheduler.add_job(
            self._guarded(self.engine.heartbeat, "heartbeat"),
            IntervalTrigger(minutes=15),
            id="heartbeat",
            max_instances=1,
            coalesce=True,
        )
        nightly_at = self._nightly_after()
        weekmask = ",".join(
            ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][day] for day in self.calendar.weekdays
        )
        scheduler.add_job(
            self._guarded(self.engine.nightly, "nightly"),
            CronTrigger(
                day_of_week=weekmask,
                hour=nightly_at.hour,
                minute=nightly_at.minute,
                timezone=self.calendar.timezone,
            ),
            id="nightly",
            max_instances=1,
        )

        def shutdown(signum, _frame):  # pragma: no cover - process-level behaviour
            log.warning("signal_received", extra={"event": {"signal": signum}})
            scheduler.shutdown(wait=False)

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, shutdown)
            except (ValueError, OSError):
                pass

        log.info("apscheduler_started")
        try:
            scheduler.start()
        except (KeyboardInterrupt, SystemExit):  # pragma: no cover
            scheduler.shutdown(wait=False)
        return True

    def _guarded(self, func: Callable[[], Any], name: str) -> Callable[[], Any]:
        """Wrap a job so it only runs in a permitted session and never raises."""
        allowed = {job.name: job.sessions for job in self.jobs}.get(name, ("open",))

        def runner() -> Any:
            session = self.session()
            if session not in allowed:
                log.debug("job_skipped", extra={"event": {"job": name, "session": session}})
                return None
            started = utcnow()
            self._record_tick()
            try:
                return func()
            except Exception as exc:  # noqa: BLE001
                log.exception("job_failed", extra={"event": {"job": name, "error": str(exc)}})
                return {"error": str(exc)}
            finally:
                log.debug(
                    "job_duration",
                    extra={"event": {
                        "job": name,
                        "seconds": round((utcnow() - started).total_seconds(), 3),
                    }},
                )

        return runner

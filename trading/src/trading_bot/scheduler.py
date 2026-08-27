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

from .clock import local_session, market_now, utcnow
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
    sessions: tuple[str, ...] = ("open", "premarket", "afterhours", "closed")
    next_run: float = 0.0

    def due(self, now: float) -> bool:
        return now >= self.next_run

    def schedule_next(self, now: float) -> None:
        self.next_run = now + self.interval_seconds


class BotScheduler:
    """Session-aware job runner around :class:`TradingEngine`."""

    def __init__(self, settings: Settings, engine: TradingEngine | None = None) -> None:
        self.settings = settings
        self.engine = engine or TradingEngine(settings)
        self._stop = threading.Event()
        self._nightly_done_for: str | None = None
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
                sessions=("open", "premarket", "afterhours", "closed"),
            ),
            Job(
                "heartbeat",
                self.engine.heartbeat,
                15 * 60,
                sessions=("open", "premarket", "afterhours"),
            ),
            Job("nightly", self._nightly_if_due, 10 * 60, sessions=("afterhours", "closed")),
        ]

    # -------------------------------------------------------------- lifecycle
    def run_forever(self, *, poll_seconds: float = 20.0) -> None:
        """Block, running jobs until interrupted. This is the 24/7 loop."""
        self._install_signal_handlers()
        log.info(
            "scheduler_started",
            extra={"event": {
                "mode": "paper" if self.settings.is_paper else "live",
                "jobs": [job.name for job in self.jobs],
                "universe": list(self.settings.universe),
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

    def tick(self, *, now: float | None = None) -> list[str]:
        """Run every job that is due in the current session. Returns their names."""
        current = time.monotonic() if now is None else now
        session = local_session()
        ran: list[str] = []
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

    def stop(self) -> None:
        self._stop.set()

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
        now = market_now()
        day = now.date().isoformat()
        if self._nightly_done_for == day:
            return None
        # 16:00 ET close; give fills time to settle before reviewing.
        if now.hour < 16 or (now.hour == 16 and now.minute < 30):
            return None
        self._nightly_done_for = day
        log.info("nightly_started", extra={"event": {"day": day}})
        return self.engine.nightly()

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

        scheduler = BlockingScheduler(timezone=self.settings.timezone)
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
        scheduler.add_job(
            self._guarded(self.engine.nightly, "nightly"),
            CronTrigger(day_of_week="mon-fri", hour=16, minute=45),
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
            session = local_session()
            if session not in allowed:
                log.debug("job_skipped", extra={"event": {"job": name, "session": session}})
                return None
            started = utcnow()
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

"""Circuit breaker.

Counts consecutive failures of a named operation and trips after a threshold,
pausing that operation for a cool-off period. A tripped breaker is persisted, so
a restart does not immediately resume hammering a broken dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from .clock import iso, parse_iso, utcnow
from .db import Store
from .logging_setup import get_logger

log = get_logger(__name__)

STATE_PREFIX = "circuit:"


@dataclass
class BreakerState:
    failures: int = 0
    open_until: str | None = None
    last_error: str = ""
    trips: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "failures": self.failures,
            "open_until": self.open_until,
            "last_error": self.last_error,
            "trips": self.trips,
        }


class CircuitBreaker:
    """One breaker per named operation (``trading``, ``news``, ...)."""

    def __init__(
        self,
        store: Store,
        name: str = "trading",
        *,
        threshold: int = 5,
        cooloff_minutes: float = 15.0,
        on_trip=None,
        escalate_after_trips: int = 4,
        on_escalate=None,
    ) -> None:
        self.store = store
        self.name = name
        self.threshold = max(threshold, 1)
        self.cooloff_minutes = cooloff_minutes
        self.on_trip = on_trip
        # Repeated trips mean the dependency is not coming back on its own.
        # Retrying forever in silence is not resilience, it is a hung bot.
        self.escalate_after_trips = max(escalate_after_trips, 1)
        self.on_escalate = on_escalate

    @property
    def _key(self) -> str:
        return f"{STATE_PREFIX}{self.name}"

    def state(self) -> BreakerState:
        raw = self.store.get_state(self._key) or {}
        return BreakerState(
            failures=int(raw.get("failures", 0)),
            open_until=raw.get("open_until"),
            last_error=str(raw.get("last_error", "")),
            trips=int(raw.get("trips", 0)),
        )

    def _save(self, state: BreakerState) -> None:
        self.store.set_state(self._key, state.as_dict())

    def is_open(self) -> bool:
        """True while the breaker is tripped and still cooling off."""
        state = self.state()
        if not state.open_until:
            return False
        until = parse_iso(state.open_until)
        if until is None or utcnow() >= until:
            # Cool-off elapsed: half-open, let the next call through.
            self._save(BreakerState(failures=state.failures, open_until=None, last_error=state.last_error))
            return False
        return True

    def record_success(self) -> None:
        state = self.state()
        if state.failures or state.open_until:
            # Trip history survives a success: escalation is about a dependency
            # that keeps failing, not about one bad minute.
            self._save(BreakerState(trips=state.trips))
            log.info("circuit_reset", extra={"event": {"name": self.name}})

    def record_failure(self, error: str) -> bool:
        """Count a failure. Returns True if this failure tripped the breaker."""
        state = self.state()
        state.failures += 1
        state.last_error = error[:500]
        tripped = state.failures >= self.threshold
        if tripped:
            state.trips += 1
            state.open_until = iso(utcnow() + timedelta(minutes=self.cooloff_minutes))
            self.store.record_event(
                "circuit_tripped", error, severity="critical",
                name=self.name, failures=state.failures, open_until=state.open_until,
            )
            log.critical(
                "circuit_tripped",
                extra={"event": {"name": self.name, "failures": state.failures, "error": error[:200]}},
            )
            if self.on_trip is not None:
                try:
                    self.on_trip(self.name, state.failures, error)
                except Exception as exc:  # noqa: BLE001 - never fail inside a trip handler
                    log.warning("circuit_trip_handler_failed", extra={"event": {"error": str(exc)}})
            if state.trips >= self.escalate_after_trips and self.on_escalate is not None:
                self.store.record_event(
                    "circuit_escalated", error, severity="critical",
                    name=self.name, trips=state.trips,
                )
                log.critical(
                    "circuit_escalated",
                    extra={"event": {"name": self.name, "trips": state.trips}},
                )
                try:
                    self.on_escalate(self.name, state.trips, error)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "circuit_escalation_handler_failed", extra={"event": {"error": str(exc)}}
                    )
        else:
            log.warning(
                "circuit_failure",
                extra={"event": {"name": self.name, "failures": state.failures, "error": error[:200]}},
            )
        self._save(state)
        return tripped

    def reset(self) -> None:
        self._save(BreakerState())

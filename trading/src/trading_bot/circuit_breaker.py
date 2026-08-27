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

    def as_dict(self) -> dict[str, Any]:
        return {"failures": self.failures, "open_until": self.open_until, "last_error": self.last_error}


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
    ) -> None:
        self.store = store
        self.name = name
        self.threshold = max(threshold, 1)
        self.cooloff_minutes = cooloff_minutes
        self.on_trip = on_trip

    @property
    def _key(self) -> str:
        return f"{STATE_PREFIX}{self.name}"

    def state(self) -> BreakerState:
        raw = self.store.get_state(self._key) or {}
        return BreakerState(
            failures=int(raw.get("failures", 0)),
            open_until=raw.get("open_until"),
            last_error=str(raw.get("last_error", "")),
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
            self._save(BreakerState())
            log.info("circuit_reset", extra={"event": {"name": self.name}})

    def record_failure(self, error: str) -> bool:
        """Count a failure. Returns True if this failure tripped the breaker."""
        state = self.state()
        state.failures += 1
        state.last_error = error[:500]
        tripped = state.failures >= self.threshold
        if tripped:
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
        else:
            log.warning(
                "circuit_failure",
                extra={"event": {"name": self.name, "failures": state.failures, "error": error[:200]}},
            )
        self._save(state)
        return tripped

    def reset(self) -> None:
        self._save(BreakerState())

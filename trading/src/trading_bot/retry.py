"""Retry helpers: exponential backoff with jitter for flaky network calls."""

from __future__ import annotations

import random
import time
from typing import Callable, Iterable, TypeVar

from .logging_setup import get_logger

log = get_logger(__name__)

T = TypeVar("T")


class RateLimited(Exception):
    """Raised when the broker signals HTTP 429."""


def backoff_delays(
    attempts: int, *, base: float = 1.0, cap: float = 30.0, jitter: float = 0.25
) -> Iterable[float]:
    """Yield ``attempts - 1`` delays: base, 2x, 4x ... capped, with jitter."""
    for attempt in range(attempts - 1):
        delay = min(base * (2**attempt), cap)
        yield delay * (1 + random.uniform(-jitter, jitter))


def with_retries(
    func: Callable[[], T],
    *,
    attempts: int = 4,
    base: float = 1.0,
    cap: float = 30.0,
    retry_on: tuple[type[BaseException], ...] = (Exception,),
    description: str = "call",
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Run ``func`` with exponential backoff. Re-raises the last error."""
    delays = list(backoff_delays(attempts, base=base, cap=cap))
    last: BaseException | None = None
    for attempt in range(attempts):
        try:
            return func()
        except retry_on as exc:  # noqa: PERF203 - retry loop by design
            last = exc
            if attempt >= attempts - 1:
                break
            delay = delays[attempt]
            log.warning(
                "retrying_after_error",
                extra={"event": {
                    "description": description,
                    "attempt": attempt + 1,
                    "attempts": attempts,
                    "delay_seconds": round(delay, 2),
                    "error": str(exc),
                }},
            )
            sleep(delay)
    assert last is not None
    raise last

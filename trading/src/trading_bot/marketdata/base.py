"""Provider protocol and shared HTTP helpers."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass
from typing import Any, Protocol

from ..brokers.base import Bar, Quote


class MarketDataError(RuntimeError):
    """Any failure fetching market data."""


@dataclass(frozen=True)
class ProviderInfo:
    """What a provider can actually deliver, and at what cost.

    ``realtime_quotes`` is the field that matters most: it decides whether this
    provider is allowed to price an order.
    """

    name: str
    realtime_quotes: bool
    realtime_bars: bool
    requests_per_minute: int
    has_bid_ask: bool = True
    monthly_cost_note: str = ""
    caveat: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "realtime_quotes": self.realtime_quotes,
            "realtime_bars": self.realtime_bars,
            "requests_per_minute": self.requests_per_minute,
            "has_bid_ask": self.has_bid_ask,
            "monthly_cost_note": self.monthly_cost_note,
            "caveat": self.caveat,
        }


class MarketDataProvider(Protocol):
    """Minimal surface the signal stack needs from a price source."""

    info: ProviderInfo

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]: ...
    def get_latest_quote(self, symbol: str) -> Quote | None: ...
    def get_latest_price(self, symbol: str) -> float | None: ...


class RateLimiter:
    """Client-side request budget, so a free tier is not blown in one cycle."""

    def __init__(self, requests_per_minute: int) -> None:
        self.requests_per_minute = max(requests_per_minute, 1)
        self._calls: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self, *, sleep=time.sleep, now=time.monotonic) -> float:
        """Block until a request slot is free. Returns the seconds waited."""
        waited = 0.0
        while True:
            with self._lock:
                current = now()
                while self._calls and current - self._calls[0] > 60.0:
                    self._calls.popleft()
                if len(self._calls) < self.requests_per_minute:
                    self._calls.append(current)
                    return waited
                delay = 60.0 - (current - self._calls[0]) + 0.05
            sleep(max(delay, 0.0))
            waited += max(delay, 0.0)


def get_json(url: str, *, timeout: float = 20.0, headers: dict[str, str] | None = None) -> Any:
    """GET a JSON document, raising :class:`MarketDataError` on any failure."""
    request = urllib.request.Request(
        url, headers={"User-Agent": "trading-bot/0.1", **(headers or {})}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise MarketDataError(f"HTTP {exc.code} from {_host(url)}: {exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise MarketDataError(f"request to {_host(url)} failed: {exc}") from exc


def _host(url: str) -> str:
    """Host only - never echo a URL back into logs, it carries the API key."""
    return urllib.parse.urlparse(url).netloc or "provider"


def timeframe_parts(spec: str) -> tuple[int, str]:
    """Split '15Min' into ``(15, 'minute')``."""
    text = spec.strip().lower()
    digits = "".join(ch for ch in text if ch.isdigit()) or "1"
    amount = int(digits)
    if "day" in text:
        return amount, "day"
    if "hour" in text:
        return amount, "hour"
    if "week" in text:
        return amount, "week"
    return amount, "minute"

"""Broker-neutral data types and protocol.

Keeping the agents behind this interface means the strategy code can be unit
tested with a fake broker and never touches ``alpaca-py`` directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, Sequence


class BrokerError(RuntimeError):
    """Any failure talking to the broker."""


@dataclass(frozen=True)
class AccountSnapshot:
    """The account facts that drive risk decisions."""

    equity: float
    cash: float
    buying_power: float
    non_marginable_buying_power: float
    portfolio_value: float
    daytrade_count: int = 0
    pattern_day_trader: bool = False
    trading_blocked: bool = False
    account_blocked: bool = False
    transfers_blocked: bool = False
    shorting_enabled: bool = False
    multiplier: float = 1.0
    currency: str = "USD"
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_cash_account(self) -> bool:
        """A cash account has no leverage, so funds settle T+1 before reuse."""
        return self.multiplier <= 1.0

    @property
    def settled_cash_available(self) -> float:
        """Cash usable right now without triggering a good-faith violation."""
        if self.is_cash_account:
            return max(min(self.cash, self.non_marginable_buying_power or self.cash), 0.0)
        return max(self.buying_power, 0.0)


@dataclass(frozen=True)
class Position:
    symbol: str
    quantity: float
    avg_entry_price: float
    market_value: float
    current_price: float
    unrealized_pl: float = 0.0
    unrealized_plpc: float = 0.0
    side: str = "long"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Bar:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: float | None = None


@dataclass(frozen=True)
class Quote:
    symbol: str
    bid: float
    ask: float
    timestamp: datetime | None = None

    @property
    def mid(self) -> float:
        if self.bid > 0 and self.ask > 0:
            return (self.bid + self.ask) / 2
        return self.ask or self.bid

    @property
    def spread_bps(self) -> float:
        mid = self.mid
        if mid <= 0 or self.bid <= 0 or self.ask <= 0:
            return float("nan")
        return (self.ask - self.bid) / mid / 1e-4

    @property
    def half_spread_bps(self) -> float:
        spread = self.spread_bps
        return spread / 2 if spread == spread else float("nan")  # NaN-safe


@dataclass(frozen=True)
class OrderResult:
    broker_order_id: str
    symbol: str
    side: str
    quantity: float
    status: str
    limit_price: float | None = None
    filled_qty: float = 0.0
    filled_avg_price: float | None = None
    submitted_at: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_filled(self) -> bool:
        return self.status == "filled"

    @property
    def is_terminal(self) -> bool:
        return self.status in {"filled", "canceled", "expired", "rejected", "done_for_day"}


@dataclass(frozen=True)
class NewsArticle:
    external_id: str
    headline: str
    summary: str
    url: str
    author: str
    source: str
    symbols: tuple[str, ...]
    published_at: datetime | None


class Broker(Protocol):
    """Minimal surface the agents rely on."""

    def get_account(self) -> AccountSnapshot: ...
    def get_positions(self) -> list[Position]: ...
    def get_position(self, symbol: str) -> Position | None: ...
    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]: ...
    def get_latest_quote(self, symbol: str) -> Quote | None: ...
    def get_latest_price(self, symbol: str) -> float | None: ...
    def submit_limit_order(
        self,
        symbol: str,
        side: str,
        *,
        quantity: float,
        limit_price: float,
        time_in_force: str = "day",
        extended_hours: bool = False,
        client_order_id: str | None = None,
    ) -> OrderResult: ...
    def get_order(self, broker_order_id: str) -> OrderResult | None: ...
    def cancel_order(self, broker_order_id: str) -> None: ...
    def session(self) -> str: ...
    def get_news(
        self, *, symbols: Sequence[str], since: datetime | None = None, limit: int = 50
    ) -> list[NewsArticle]: ...

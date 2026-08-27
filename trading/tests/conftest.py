"""Shared fixtures: an in-memory store and a deterministic fake broker."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from trading_bot.brokers.base import (  # noqa: E402
    AccountSnapshot,
    Bar,
    NewsArticle,
    OrderResult,
    Position,
    Quote,
)
from trading_bot.config import CostConfig, RiskConfig, Settings, SignalConfig  # noqa: E402
from trading_bot.db import Store  # noqa: E402

BASE_TIME = datetime(2026, 3, 2, 14, 30, tzinfo=timezone.utc)  # a Monday, market open


def make_bars(
    prices: Sequence[float], *, start: datetime = BASE_TIME, volume: float = 1000.0, step_minutes: int = 15
) -> list[Bar]:
    """Build bars from a close-price series (open/high/low derived)."""
    bars = []
    for index, close in enumerate(prices):
        previous = prices[index - 1] if index else close
        bars.append(
            Bar(
                timestamp=start + timedelta(minutes=step_minutes * index),
                open=previous,
                high=max(previous, close) * 1.001,
                low=min(previous, close) * 0.999,
                close=close,
                volume=volume,
            )
        )
    return bars


# A repeating pattern of up and down steps. Real trends pull back, and without
# pullbacks RSI pins at 0/100 and the mean-reversion signal saturates, which
# would make these fixtures test a market that does not exist.
_WOBBLE = (0.9, -0.6, 1.2, -0.9, 0.5, -0.4, 1.0, -0.7)


def trending_prices(count: int = 80, start: float = 100.0, drift: float = 0.15) -> list[float]:
    """A deterministic trend of ``drift`` per bar, with realistic pullbacks."""
    prices = []
    price = start
    for index in range(count):
        price += drift + _WOBBLE[index % len(_WOBBLE)]
        prices.append(round(price, 4))
    return prices


class FakeBroker:
    """In-memory broker: deterministic prices, instant or manual fills."""

    def __init__(
        self,
        *,
        equity: float = 30.0,
        cash: float | None = None,
        prices: dict[str, list[float]] | None = None,
        session: str = "open",
        multiplier: float = 1.0,
        daytrade_count: int = 0,
        auto_fill: bool = True,
    ) -> None:
        self.equity = equity
        self.cash = equity if cash is None else cash
        self.prices = prices or {}
        self._session = session
        self.multiplier = multiplier
        self.daytrade_count = daytrade_count
        self.auto_fill = auto_fill
        self.positions: dict[str, Position] = {}
        self.orders: dict[str, OrderResult] = {}
        self.submitted: list[dict[str, Any]] = []
        self.canceled: list[str] = []
        self.news: list[NewsArticle] = []
        self.shorting_enabled = False
        self._counter = 0

    # -------------------------------------------------------------- account
    def get_account(self) -> AccountSnapshot:
        return AccountSnapshot(
            equity=self.equity,
            cash=self.cash,
            buying_power=self.cash * max(self.multiplier, 1.0),
            non_marginable_buying_power=self.cash,
            portfolio_value=self.equity,
            daytrade_count=self.daytrade_count,
            multiplier=self.multiplier,
            shorting_enabled=self.shorting_enabled,
        )

    def get_positions(self) -> list[Position]:
        return list(self.positions.values())

    def get_position(self, symbol: str) -> Position | None:
        return self.positions.get(symbol.upper())

    def set_position(self, symbol: str, quantity: float, entry: float, current: float) -> None:
        self.positions[symbol.upper()] = Position(
            symbol=symbol.upper(),
            quantity=quantity,
            avg_entry_price=entry,
            market_value=quantity * current,
            current_price=current,
            unrealized_pl=(current - entry) * quantity,
        )

    # ----------------------------------------------------------- market data
    def series(self, symbol: str) -> list[float]:
        return self.prices.get(symbol.upper(), [])

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        return make_bars(self.series(symbol))[-limit:]

    def get_latest_price(self, symbol: str) -> float | None:
        series = self.series(symbol)
        return series[-1] if series else None

    def get_latest_quote(self, symbol: str) -> Quote | None:
        price = self.get_latest_price(symbol)
        if price is None:
            return None
        # 4 bps wide, in line with a liquid large cap; the cost model reads the
        # half-spread from here rather than falling back to its default.
        return Quote(symbol=symbol.upper(), bid=price * 0.9998, ask=price * 1.0002, timestamp=BASE_TIME)

    # ---------------------------------------------------------------- orders
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
    ) -> OrderResult:
        self._counter += 1
        order_id = f"order-{self._counter}"
        self.submitted.append(
            {
                "symbol": symbol.upper(), "side": side, "quantity": quantity,
                "limit_price": limit_price, "time_in_force": time_in_force,
                "extended_hours": extended_hours,
            }
        )
        status = "filled" if self.auto_fill else "accepted"
        result = OrderResult(
            broker_order_id=order_id,
            symbol=symbol.upper(),
            side=side,
            quantity=quantity,
            status=status,
            limit_price=limit_price,
            filled_qty=quantity if self.auto_fill else 0.0,
            filled_avg_price=limit_price if self.auto_fill else None,
            submitted_at=BASE_TIME,
        )
        self.orders[order_id] = result
        if self.auto_fill:
            self._apply_fill(result)
        return result

    def fill(self, broker_order_id: str, price: float | None = None) -> OrderResult:
        """Manually fill a pending order (for auto_fill=False tests)."""
        order = self.orders[broker_order_id]
        filled = OrderResult(
            broker_order_id=order.broker_order_id,
            symbol=order.symbol,
            side=order.side,
            quantity=order.quantity,
            status="filled",
            limit_price=order.limit_price,
            filled_qty=order.quantity,
            filled_avg_price=price if price is not None else order.limit_price,
            submitted_at=order.submitted_at,
        )
        self.orders[broker_order_id] = filled
        self._apply_fill(filled)
        return filled

    def _apply_fill(self, order: OrderResult) -> None:
        price = float(order.filled_avg_price or order.limit_price or 0.0)
        symbol = order.symbol
        signed = order.filled_qty if order.side == "buy" else -order.filled_qty
        existing = self.positions.get(symbol)
        quantity = (existing.quantity if existing else 0.0) + signed
        self.cash -= signed * price
        if abs(quantity) < 1e-9:
            self.positions.pop(symbol, None)
        else:
            self.set_position(symbol, quantity, price, price)

    def get_order(self, broker_order_id: str) -> OrderResult | None:
        return self.orders.get(broker_order_id)

    def cancel_order(self, broker_order_id: str) -> None:
        self.canceled.append(broker_order_id)
        order = self.orders.get(broker_order_id)
        if order is not None:
            self.orders[broker_order_id] = OrderResult(
                broker_order_id=order.broker_order_id, symbol=order.symbol, side=order.side,
                quantity=order.quantity, status="canceled", limit_price=order.limit_price,
            )

    def cancel_all_orders(self) -> None:
        for order_id in list(self.orders):
            self.cancel_order(order_id)

    def close_all_positions(self, *, cancel_orders: bool = True) -> None:
        self.positions.clear()

    def close_position(self, symbol: str) -> None:
        self.positions.pop(symbol.upper(), None)

    # --------------------------------------------------------------- session
    def session(self) -> str:
        return self._session

    def set_session(self, session: str) -> None:
        self._session = session

    def get_news(self, *, symbols: Sequence[str], since=None, limit: int = 50) -> list[NewsArticle]:
        return list(self.news[:limit])


@pytest.fixture()
def store() -> Store:
    instance = Store(":memory:")
    yield instance
    instance.close()


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        alpaca_api_key="key",
        alpaca_secret_key="secret",
        database_url=str(tmp_path / "test.db"),
        universe=("AAPL", "MSFT"),
        benchmark="SPY",
        dry_run=False,
        log_file="",
        costs=CostConfig(),
        risk=RiskConfig(),
        signals=SignalConfig(),
    )


@pytest.fixture()
def broker() -> FakeBroker:
    return FakeBroker(
        prices={
            "AAPL": trending_prices(80, 100.0),
            "MSFT": trending_prices(80, 200.0, drift=-0.2),
            "SPY": trending_prices(80, 500.0, drift=0.1),
        }
    )

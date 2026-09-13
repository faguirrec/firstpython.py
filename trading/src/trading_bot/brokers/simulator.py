"""A deterministic in-memory broker for offline validation.

Purpose: prove that a deployment works - engine, scheduler, news pipeline,
learning loop, reports, dashboard - **without credentials and without touching
a real market**. Run it after every deploy, before pointing the bot at Alpaca.

It is not a backtest. The backtest measures whether the *strategy* has an edge
over real history; this simulates the *environment* so the plumbing can be
exercised end to end, including the failure paths a live broker eventually
produces (rejections, unfilled limits, transient outages).

Prices are a seeded random walk, so two runs with the same seed are identical.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Sequence

from ..calendars import ExchangeCalendar, get_calendar
from ..clock import to_utc, utcnow
from ..logging_setup import get_logger
from .base import AccountSnapshot, Bar, BrokerError, NewsArticle, OrderResult, Position, Quote

log = get_logger(__name__)

BAR_MINUTES = 15

# Synthetic headlines, deliberately mixed so NewsPulse's classifier and the
# sentiment aggregation both see signal and noise.
HEADLINE_TEMPLATES = (
    ("{symbol} beats quarterly estimates and raises guidance", 1),
    ("{symbol} misses revenue expectations, shares slump", -1),
    ("Analysts upgrade {symbol} on strong demand", 1),
    ("{symbol} faces regulatory probe over accounting", -1),
    ("{symbol} announces record buyback", 1),
    ("{symbol} reportedly in talks to acquire a rival, sources say", 0),
    ("{symbol} holds annual shareholder meeting", 0),
    ("Supply chain delays hit {symbol} production", -1),
)


@dataclass
class _SimOrder:
    """An order living inside the simulator."""

    order_id: str
    symbol: str
    side: str
    quantity: float
    limit_price: float
    status: str
    created_at: datetime
    client_order_id: str | None = None
    filled_qty: float = 0.0
    filled_avg_price: float | None = None
    extended_hours: bool = False

    def snapshot(self) -> OrderResult:
        return OrderResult(
            broker_order_id=self.order_id,
            symbol=self.symbol,
            side=self.side,
            quantity=self.quantity,
            status=self.status,
            limit_price=self.limit_price,
            filled_qty=self.filled_qty,
            filled_avg_price=self.filled_avg_price,
            submitted_at=self.created_at,
            raw={"simulated": "true"},
        )


class SimulatedBroker:
    """Implements the :class:`~trading_bot.brokers.base.Broker` protocol offline."""

    def __init__(
        self,
        symbols: Sequence[str],
        *,
        equity: float = 30.0,
        start: datetime | None = None,
        seed: int = 42,
        bars_ahead: int = 4_000,
        annual_drift: float = 0.06,
        annual_volatility: float = 0.28,
        spread_bps: float = 4.0,
        reject_rate: float = 0.0,
        outage_rate: float = 0.0,
        fill_probability: float = 0.9,
        partial_fill_rate: float = 0.15,
        calendar: ExchangeCalendar | None = None,
    ) -> None:
        self.symbols = [symbol.upper() for symbol in symbols]
        self.calendar = calendar or get_calendar("XNYS")
        self.cash = equity
        self.starting_equity = equity
        self.spread_bps = spread_bps
        self.reject_rate = reject_rate
        self.outage_rate = outage_rate
        self.fill_probability = fill_probability
        # Real brokers fill fractional limit orders in pieces. The bot must book
        # each piece, so the simulator has to be able to produce them.
        self.partial_fill_rate = partial_fill_rate
        self._rng = random.Random(seed)
        self._news_rng = random.Random(seed + 1)
        self._fail_rng = random.Random(seed + 2)

        self.now = to_utc(start or utcnow())
        self.positions: dict[str, Position] = {}
        self.orders: dict[str, _SimOrder] = {}
        self.submitted: list[dict[str, Any]] = []
        self._counter = 0
        self._news: list[NewsArticle] = []

        # Pre-generate price history so `get_bars` can serve a warmup window
        # immediately, then continue into the simulated future.
        self._series: dict[str, list[Bar]] = {}
        self._origin = self.now - timedelta(minutes=BAR_MINUTES * (bars_ahead // 2))
        per_bar = BAR_MINUTES / (252 * 390)
        for index, symbol in enumerate(self.symbols):
            self._series[symbol] = self._generate(
                symbol,
                count=bars_ahead,
                start_price=50.0 + 40.0 * ((index * 7) % 5),
                drift=annual_drift * per_bar,
                volatility=annual_volatility * (per_bar**0.5),
            )

    # ------------------------------------------------------------------ prices
    def _generate(
        self, symbol: str, *, count: int, start_price: float, drift: float, volatility: float
    ) -> list[Bar]:
        bars: list[Bar] = []
        price = start_price
        for index in range(count):
            shock = self._rng.gauss(drift, volatility)
            nxt = max(price * (1 + shock), 1.0)
            high = max(price, nxt) * (1 + abs(self._rng.gauss(0, volatility / 2)))
            low = min(price, nxt) * (1 - abs(self._rng.gauss(0, volatility / 2)))
            bars.append(
                Bar(
                    timestamp=self._origin + timedelta(minutes=BAR_MINUTES * index),
                    open=round(price, 4),
                    high=round(high, 4),
                    low=round(low, 4),
                    close=round(nxt, 4),
                    volume=round(self._rng.uniform(5e5, 4e6), 0),
                )
            )
            price = nxt
        return bars

    def _visible(self, symbol: str) -> list[Bar]:
        """Bars up to the simulated present - never the future."""
        series = self._series.get(symbol.upper(), [])
        return [bar for bar in series if bar.timestamp <= self.now]

    def price(self, symbol: str) -> float:
        visible = self._visible(symbol)
        if visible:
            return visible[-1].close
        series = self._series.get(symbol.upper(), [])
        return series[0].close if series else 0.0

    # ------------------------------------------------------------------- clock
    def advance(self, delta: timedelta | float) -> None:
        """Move the simulated clock forward and settle any resting orders."""
        step = delta if isinstance(delta, timedelta) else timedelta(minutes=float(delta))
        if step.total_seconds() <= 0:
            return
        self.now = self.now + step
        self._settle_resting_orders()
        self._mark_positions()

    def session(self) -> str:
        return self.calendar.session(self.now)

    def is_market_open(self) -> bool:
        return self.session() == "open"

    # ----------------------------------------------------------------- account
    def _maybe_outage(self, what: str) -> None:
        if self.outage_rate > 0 and self._fail_rng.random() < self.outage_rate:
            raise BrokerError(f"simulated outage during {what}")

    def get_account(self) -> AccountSnapshot:
        self._maybe_outage("get_account")
        equity = self.cash + sum(position.market_value for position in self.positions.values())
        return AccountSnapshot(
            equity=round(equity, 6),
            cash=round(self.cash, 6),
            buying_power=round(max(self.cash, 0.0), 6),
            non_marginable_buying_power=round(max(self.cash, 0.0), 6),
            portfolio_value=round(equity, 6),
            daytrade_count=0,
            multiplier=1.0,           # a cash account, like a real $30 pilot
            shorting_enabled=False,
            raw={"simulated": "true"},
        )

    def get_positions(self) -> list[Position]:
        self._maybe_outage("get_positions")
        return list(self.positions.values())

    def get_position(self, symbol: str) -> Position | None:
        return self.positions.get(symbol.upper())

    def _mark_positions(self) -> None:
        for symbol, position in list(self.positions.items()):
            price = self.price(symbol)
            if price <= 0:
                continue
            self.positions[symbol] = Position(
                symbol=symbol,
                quantity=position.quantity,
                avg_entry_price=position.avg_entry_price,
                market_value=position.quantity * price,
                current_price=price,
                unrealized_pl=(price - position.avg_entry_price) * position.quantity,
                unrealized_plpc=(
                    (price - position.avg_entry_price) / position.avg_entry_price
                    if position.avg_entry_price
                    else 0.0
                ),
            )

    # ------------------------------------------------------------- market data
    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        self._maybe_outage(f"get_bars[{symbol}]")
        visible = self._visible(symbol)
        if not visible:
            return []
        if "day" in timeframe.lower():
            visible = _aggregate_daily(visible)
        return visible[-limit:]

    def get_latest_quote(self, symbol: str) -> Quote | None:
        self._maybe_outage(f"get_latest_quote[{symbol}]")
        price = self.price(symbol)
        if price <= 0:
            return None
        half = price * self.spread_bps * 1e-4 / 2
        return Quote(symbol=symbol.upper(), bid=price - half, ask=price + half, timestamp=self.now)

    def get_latest_price(self, symbol: str) -> float | None:
        price = self.price(symbol)
        return price if price > 0 else None

    # ------------------------------------------------------------------ orders
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
        self._maybe_outage("submit_order")
        symbol = symbol.upper()
        is_fractional = abs(quantity - round(quantity)) > 1e-9

        # Mirror the real broker's constraints, so the bot is tested against them.
        if is_fractional and extended_hours:
            raise BrokerError("simulated: fractional orders are rejected outside regular hours")
        if self.session() != "open" and not extended_hours:
            raise BrokerError(f"simulated: market is {self.session()}, order rejected")
        if quantity <= 0:
            raise BrokerError("simulated: quantity must be positive")

        self._counter += 1
        order = _SimOrder(
            order_id=f"sim-{self._counter:06d}",
            symbol=symbol,
            side=side.lower(),
            quantity=quantity,
            limit_price=limit_price,
            status="accepted",
            created_at=self.now,
            client_order_id=client_order_id,
            extended_hours=extended_hours,
        )
        self.orders[order.order_id] = order
        self.submitted.append(
            {
                "symbol": symbol, "side": order.side, "quantity": quantity,
                "limit_price": limit_price, "time_in_force": time_in_force,
                "at": self.now.isoformat(),
            }
        )

        if self.reject_rate > 0 and self._fail_rng.random() < self.reject_rate:
            order.status = "rejected"
            return order.snapshot()

        # A marketable limit usually fills right away; otherwise it rests.
        quote = self.get_latest_quote(symbol)
        if quote is not None and self._is_marketable(order, quote):
            if self._fail_rng.random() < self.fill_probability:
                portion = (
                    order.quantity * 0.5
                    if self._fail_rng.random() < self.partial_fill_rate
                    else order.quantity
                )
                self._fill(order, self._fill_price(order, quote), quantity=portion)
        return order.snapshot()

    def _is_marketable(self, order: _SimOrder, quote: Quote) -> bool:
        if order.side == "buy":
            return order.limit_price >= quote.ask
        return order.limit_price <= quote.bid

    def _fill_price(self, order: _SimOrder, quote: Quote) -> float:
        """Fill at the better of the limit and the touch - never worse than the limit."""
        if order.side == "buy":
            return min(order.limit_price, quote.ask)
        return max(order.limit_price, quote.bid)

    def _fill(self, order: _SimOrder, price: float, *, quantity: float | None = None) -> None:
        """Fill all or part of an order, mirroring a real broker's behaviour."""
        if order.status == "filled":
            return
        quantity = order.quantity - order.filled_qty if quantity is None else quantity
        quantity = min(quantity, order.quantity - order.filled_qty)
        if quantity <= 0:
            return
        if order.side == "buy":
            cost = price * quantity
            if cost > self.cash + 1e-9:
                order.status = "rejected"
                return
            self.cash -= cost
            existing = self.positions.get(order.symbol)
            total_qty = (existing.quantity if existing else 0.0) + quantity
            # Volume-weighted average entry, as a real broker reports it.
            if existing:
                weighted = (
                    existing.avg_entry_price * existing.quantity + price * quantity
                ) / total_qty
            else:
                weighted = price
            self.positions[order.symbol] = Position(
                symbol=order.symbol, quantity=total_qty, avg_entry_price=weighted,
                market_value=total_qty * price, current_price=price,
            )
        else:
            existing = self.positions.get(order.symbol)
            held = existing.quantity if existing else 0.0
            quantity = min(quantity, held)
            if quantity <= 0:
                order.status = "rejected"
                return
            self.cash += price * quantity
            remaining = held - quantity
            if remaining <= 1e-9:
                self.positions.pop(order.symbol, None)
            else:
                self.positions[order.symbol] = Position(
                    symbol=order.symbol, quantity=remaining,
                    avg_entry_price=existing.avg_entry_price,
                    market_value=remaining * price, current_price=price,
                )

        order.filled_qty = round(order.filled_qty + quantity, 9)
        order.filled_avg_price = price
        order.status = (
            "filled" if order.filled_qty >= order.quantity - 1e-9 else "partially_filled"
        )

    def _settle_resting_orders(self) -> None:
        """Fill resting limits whose price was touched, expire the rest at the close."""
        for order in list(self.orders.values()):
            if order.status not in ("accepted", "new", "partially_filled"):
                continue
            bars = [
                bar for bar in self._series.get(order.symbol, [])
                if order.created_at < bar.timestamp <= self.now
            ]
            touched = any(
                (order.side == "buy" and bar.low <= order.limit_price)
                or (order.side == "sell" and bar.high >= order.limit_price)
                for bar in bars
            )
            if touched and self._fail_rng.random() < self.fill_probability:
                self._fill(order, order.limit_price)
                continue
            # Time in force "day": anything unfilled dies with the session, but a
            # partially filled order keeps the shares it already got.
            if order.created_at.date() < self.now.date():
                order.status = "expired"
                if order.filled_qty > 0:
                    log.debug(
                        "simulated_partial_then_expired",
                        extra={"event": {
                            "order": order.order_id, "filled": order.filled_qty,
                            "of": order.quantity,
                        }},
                    )

    def get_order(self, broker_order_id: str) -> OrderResult | None:
        self._maybe_outage("get_order")
        order = self.orders.get(broker_order_id)
        return order.snapshot() if order else None

    def get_order_by_client_id(self, client_order_id: str) -> OrderResult | None:
        self._maybe_outage("get_order_by_client_id")
        for order in self.orders.values():
            if order.client_order_id == client_order_id:
                return order.snapshot()
        return None

    def cancel_order(self, broker_order_id: str) -> None:
        order = self.orders.get(broker_order_id)
        if order is None:
            raise BrokerError(f"simulated: unknown order {broker_order_id}")
        if order.status in ("accepted", "new", "partially_filled"):
            order.status = "canceled"

    def cancel_all_orders(self) -> None:
        for order_id in list(self.orders):
            try:
                self.cancel_order(order_id)
            except BrokerError:
                continue

    def close_position(self, symbol: str) -> None:
        position = self.positions.get(symbol.upper())
        if position is None:
            return
        price = self.price(symbol)
        self.cash += position.quantity * price
        self.positions.pop(symbol.upper(), None)

    def close_all_positions(self, *, cancel_orders: bool = True) -> None:
        if cancel_orders:
            self.cancel_all_orders()
        for symbol in list(self.positions):
            self.close_position(symbol)

    # -------------------------------------------------------------------- news
    def get_news(
        self, *, symbols: Sequence[str], since: datetime | None = None, limit: int = 50
    ) -> list[NewsArticle]:
        """Emit a few synthetic headlines per call, timestamped to sim-now."""
        self._maybe_outage("get_news")
        wanted = [s.upper() for s in symbols] or self.symbols
        produced: list[NewsArticle] = []
        for _ in range(min(3, limit)):
            symbol = self._news_rng.choice(wanted)
            template, _tone = self._news_rng.choice(HEADLINE_TEMPLATES)
            headline = template.format(symbol=symbol)
            produced.append(
                NewsArticle(
                    external_id=f"sim-news-{len(self._news) + len(produced) + 1}",
                    headline=headline,
                    summary=f"Simulated coverage for {symbol}.",
                    url=f"https://example.invalid/{symbol.lower()}",
                    author="simulator",
                    source="simulator",
                    symbols=(symbol,),
                    published_at=self.now,
                )
            )
        self._news.extend(produced)
        return produced


def _aggregate_daily(bars: Sequence[Bar]) -> list[Bar]:
    """Roll intraday bars into daily bars (the benchmark regime needs these)."""
    buckets: dict[Any, list[Bar]] = {}
    for bar in bars:
        buckets.setdefault(bar.timestamp.date(), []).append(bar)
    daily: list[Bar] = []
    for day in sorted(buckets):
        group = buckets[day]
        daily.append(
            Bar(
                timestamp=group[-1].timestamp,
                open=group[0].open,
                high=max(bar.high for bar in group),
                low=min(bar.low for bar in group),
                close=group[-1].close,
                volume=sum(bar.volume for bar in group),
            )
        )
    return daily

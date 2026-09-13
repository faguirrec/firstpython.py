"""Order lifecycle: partial fills, terminal statuses and crash recovery.

Every scenario here was found by audit as a way to strand real shares with no
stop loss. They are regression tests first and documentation second.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from conftest import FakeBroker, trending_prices
from trading_bot.agents.risk_sentinel import RiskSentinel
from trading_bot.agents.trader_core import TraderCore
from trading_bot.brokers.base import OrderResult
from trading_bot.clock import clear_time_source, set_time_source
from trading_bot.config import Settings
from trading_bot.db import Store

NOW = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clock():
    set_time_source(lambda: NOW)
    yield
    clear_time_source()


@pytest.fixture()
def trader(settings: Settings, store: Store):
    broker = FakeBroker(
        equity=30.0, cash=30.0, auto_fill=False,
        prices={
            "AAPL": trending_prices(80, 100.0, drift=0.45),
            "MSFT": trending_prices(80, 200.0, drift=-0.45),
            "SPY": trending_prices(80, 500.0, drift=0.3),
        },
    )
    return TraderCore(settings, store, broker, RiskSentinel(settings, store)), broker


def partial(order: OrderResult, quantity: float, price: float, status: str) -> OrderResult:
    return OrderResult(
        broker_order_id=order.broker_order_id, symbol=order.symbol, side=order.side,
        quantity=order.quantity, status=status, limit_price=order.limit_price,
        filled_qty=quantity, filled_avg_price=price, submitted_at=order.submitted_at,
    )


def test_partial_fill_that_then_expires_is_still_booked(trader, store: Store):
    """A day order that half-fills and expires moved real shares."""
    core, broker = trader
    core.run_cycle()
    order_id = broker.submitted and list(broker.orders)[0]
    assert order_id

    live = broker.orders[order_id]
    half = live.quantity / 2
    broker.orders[order_id] = partial(live, half, live.limit_price, "expired")

    assert core.sync_orders() == 1
    trades = store.open_trades()
    assert len(trades) == 1
    assert trades[0]["quantity"] == pytest.approx(half)


def test_a_fill_is_never_booked_twice(trader, store: Store):
    core, broker = trader
    core.run_cycle()
    order_id = list(broker.orders)[0]
    live = broker.orders[order_id]

    broker.orders[order_id] = partial(live, live.quantity / 2, live.limit_price, "partially_filled")
    core.sync_orders()
    broker.orders[order_id] = partial(live, live.quantity, live.limit_price, "filled")
    core.sync_orders()
    core.sync_orders()

    trades = store.open_trades()
    # One order produces exactly one trade, whatever shape the fills arrive in.
    assert len(trades) == 1
    assert trades[0]["quantity"] == pytest.approx(live.quantity)
    assert store.get_order(1)["booked_qty"] == pytest.approx(live.quantity)
    assert len(store.closed_trades()) == 0


def test_incremental_fills_accumulate_into_the_booked_quantity(trader, store: Store):
    core, broker = trader
    core.run_cycle()
    order_id = list(broker.orders)[0]
    live = broker.orders[order_id]

    broker.orders[order_id] = partial(live, live.quantity * 0.4, live.limit_price, "partially_filled")
    core.sync_orders()
    broker.orders[order_id] = partial(live, live.quantity, live.limit_price, "filled")
    core.sync_orders()

    record = store.get_order(1)
    assert record["booked_qty"] == pytest.approx(live.quantity)


def test_a_partial_exit_shrinks_the_trade_instead_of_closing_it(settings, store: Store):
    """Booking a partial exit as a full close reports P&L on the wrong size."""
    broker = FakeBroker(equity=30.0, cash=30.0, auto_fill=False,
                        prices={"AAPL": trending_prices(80, 100.0), "SPY": trending_prices(80, 500.0)})
    core = TraderCore(settings, store, broker, RiskSentinel(settings, store))

    trade_id = store.open_trade({"symbol": "AAPL", "quantity": 0.10, "entry_price": 100.0})
    order_id = store.record_order(
        {"symbol": "AAPL", "side": "sell", "quantity": 0.10, "limit_price": 95.0,
         "intent": "exit", "trade_id": trade_id, "status": "accepted",
         "broker_order_id": "x-1", "client_order_id": "exit-1"}
    )
    broker.orders["x-1"] = OrderResult(
        broker_order_id="x-1", symbol="AAPL", side="sell", quantity=0.10, status="expired",
        limit_price=95.0, filled_qty=0.05, filled_avg_price=95.0,
    )

    core.sync_orders()
    remaining = store.get_trade(trade_id)
    assert remaining["status"] == "open"
    assert remaining["quantity"] == pytest.approx(0.05)
    assert store.closed_trades() == []


def test_the_remainder_of_a_partial_exit_closes_at_the_right_size(settings, store: Store):
    broker = FakeBroker(equity=30.0, cash=30.0, auto_fill=False,
                        prices={"AAPL": trending_prices(80, 100.0), "SPY": trending_prices(80, 500.0)})
    core = TraderCore(settings, store, broker, RiskSentinel(settings, store))
    trade_id = store.open_trade({"symbol": "AAPL", "quantity": 0.10, "entry_price": 100.0})

    for index, (filled, status) in enumerate(((0.05, "expired"), (0.05, "filled")), start=1):
        store.record_order(
            {"symbol": "AAPL", "side": "sell", "quantity": 0.05, "limit_price": 95.0,
             "intent": "exit", "trade_id": trade_id, "status": "accepted",
             "broker_order_id": f"x-{index}", "client_order_id": f"exit-{index}"}
        )
        broker.orders[f"x-{index}"] = OrderResult(
            broker_order_id=f"x-{index}", symbol="AAPL", side="sell", quantity=0.05,
            status=status, limit_price=95.0, filled_qty=filled, filled_avg_price=95.0,
        )
        core.sync_orders()

    closed = store.closed_trades()
    assert len(closed) == 1
    # P&L is booked on the 0.05 that actually left on the closing order.
    assert closed[0]["quantity"] == pytest.approx(0.05)
    assert closed[0]["gross_pnl"] == pytest.approx((95.0 - 100.0) * 0.05)


def test_an_order_with_no_broker_id_is_recovered_by_client_id(trader, store: Store):
    """The crash window between writing the row and the broker replying."""
    core, broker = trader
    order_id = store.record_order(
        {"symbol": "AAPL", "side": "buy", "quantity": 0.05, "limit_price": 100.0,
         "intent": "entry", "status": "pending_new", "client_order_id": "entry-99"}
    )
    # The order did land at the broker; only our record of the id was lost.
    broker.orders["real-1"] = OrderResult(
        broker_order_id="real-1", symbol="AAPL", side="buy", quantity=0.05, status="filled",
        limit_price=100.0, filled_qty=0.05, filled_avg_price=100.0,
    )
    broker.get_order_by_client_id = lambda cid: (
        broker.orders["real-1"] if cid == "entry-99" else None
    )

    core.sync_orders()
    assert store.get_order(order_id)["broker_order_id"] == "real-1"
    # And once adopted, the fill books normally.
    core.sync_orders()
    assert len(store.open_trades()) == 1


def test_an_order_that_never_landed_is_retired_not_left_blocking(trader, store: Store):
    core, broker = trader
    trade_id = store.open_trade({"symbol": "AAPL", "quantity": 0.1, "entry_price": 120.0})
    order_id = store.record_order(
        {"symbol": "AAPL", "side": "sell", "quantity": 0.1, "limit_price": 100.0,
         "intent": "exit", "trade_id": trade_id, "status": "pending_new",
         "client_order_id": "exit-77",
         "created_at": (NOW - timedelta(hours=2)).isoformat()}
    )
    broker.get_order_by_client_id = lambda cid: None

    core.sync_orders()
    assert store.get_order(order_id)["status"] == "unknown"
    assert store.recent_events(kind="order_never_confirmed")
    # Crucially the trade is exitable again, instead of shielded forever.
    assert core._has_open_exit(trade_id) is False


def test_an_unconfirmed_row_never_counts_as_a_working_exit(trader, store: Store):
    core, _broker = trader
    trade_id = store.open_trade({"symbol": "AAPL", "quantity": 0.1, "entry_price": 120.0})
    store.record_order(
        {"symbol": "AAPL", "side": "sell", "quantity": 0.1, "limit_price": 100.0,
         "intent": "exit", "trade_id": trade_id, "status": "pending_new"}
    )
    assert core._has_open_exit(trade_id) is False


def test_a_broker_exception_that_is_not_a_broker_error_still_marks_the_order(trader, store: Store):
    """A pydantic/validation error must not leave a row orphaned either."""
    core, broker = trader

    def explode(*_args, **_kwargs):
        raise ValueError("malformed request")

    broker.submit_limit_order = explode
    core.run_cycle()

    orders = store.orders_for_day()
    assert orders
    assert all(order["status"] == "rejected" for order in orders)
    assert store.unconfirmed_orders() == []

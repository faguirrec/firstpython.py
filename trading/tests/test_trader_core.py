"""TraderCore integration tests, driven by the fake broker."""

from __future__ import annotations

import pytest

from conftest import FakeBroker, trending_prices
from trading_bot.agents.risk_sentinel import RiskSentinel
from trading_bot.agents.trader_core import TraderCore
from trading_bot.config import RiskConfig, Settings, SignalConfig
from trading_bot.db import Store


def build(settings: Settings, store: Store, broker: FakeBroker) -> TraderCore:
    return TraderCore(settings, store, broker, RiskSentinel(settings, store))


@pytest.fixture()
def strong_broker() -> FakeBroker:
    """A clean uptrend in AAPL, a downtrend in MSFT, a rising benchmark."""
    return FakeBroker(
        equity=30.0,
        cash=30.0,
        prices={
            "AAPL": trending_prices(80, 100.0, drift=0.45),
            "MSFT": trending_prices(80, 200.0, drift=-0.45),
            "SPY": trending_prices(80, 500.0, drift=0.3),
        },
    )


def test_cycle_does_not_execute_outside_market_hours(settings, store, strong_broker):
    strong_broker.set_session("premarket")
    report = build(settings, store, strong_broker).run_cycle()
    assert report.entries_submitted == 0
    assert strong_broker.submitted == []
    assert any(note.startswith("no_execution_in_session") for note in report.notes or [])


def test_cycle_submits_a_limit_order_for_the_best_candidate(settings, store, strong_broker):
    trader = build(settings, store, strong_broker)
    report = trader.run_cycle()

    assert report.entries_submitted == 1
    order = strong_broker.submitted[0]
    assert order["symbol"] == "AAPL"          # the downtrending MSFT is not bought
    assert order["side"] == "buy"
    assert order["limit_price"] > 0           # limit, never market
    assert order["time_in_force"] == "day"    # required for fractional fills
    assert 0 < order["quantity"] < 1          # fractional sizing on $30


def test_every_decision_is_recorded_with_its_reason(settings, store, strong_broker):
    build(settings, store, strong_broker).run_cycle()
    decisions = store.decisions_for_day()
    assert decisions
    assert all(decision["reason"] for decision in decisions)
    approved = [d for d in decisions if d["approved"]]
    assert len(approved) == 1
    assert approved[0]["signals"]["components"]


def test_fills_become_trades(settings, store, strong_broker):
    trader = build(settings, store, strong_broker)
    trader.run_cycle()
    trader.sync_orders()

    trades = store.open_trades()
    assert len(trades) == 1
    assert trades[0]["symbol"] == "AAPL"
    assert trades[0]["entry_price"] > 0
    assert trades[0]["signals"]["components"]


def test_take_profit_closes_the_position_and_books_net_pnl(settings, store, strong_broker):
    trader = build(settings, store, strong_broker)
    trader.run_cycle()
    trader.sync_orders()

    trade = store.open_trades()[0]
    entry = float(trade["entry_price"])
    # Jump the price 5% past the 3% take-profit threshold.
    target = entry * 1.05
    strong_broker.prices["AAPL"] = strong_broker.prices["AAPL"] + [target]
    strong_broker.set_position("AAPL", float(trade["quantity"]), entry, target)

    account = strong_broker.get_account()
    assert trader.manage_exits(account, strong_broker.get_positions()) == 1
    trader.sync_orders()

    closed = store.closed_trades()
    assert len(closed) == 1
    assert closed[0]["exit_reason"] == "take_profit"
    assert closed[0]["net_pnl"] == pytest.approx(
        closed[0]["gross_pnl"] - closed[0]["fees"], abs=1e-9
    )
    assert closed[0]["fees"] > 0


def test_stop_loss_triggers_below_the_threshold(settings, store, strong_broker):
    trader = build(settings, store, strong_broker)
    trader.run_cycle()
    trader.sync_orders()

    trade = store.open_trades()[0]
    entry = float(trade["entry_price"])
    strong_broker.set_position("AAPL", float(trade["quantity"]), entry, entry * 0.95)
    trader.manage_exits(strong_broker.get_account(), strong_broker.get_positions())
    trader.sync_orders()

    assert store.closed_trades()[0]["exit_reason"] == "stop_loss"
    assert store.closed_trades()[0]["net_pnl"] < 0


def test_dry_run_records_decisions_without_touching_the_broker(settings, store, strong_broker):
    dry = Settings(**{**settings.__dict__, "dry_run": True})
    report = build(dry, store, strong_broker).run_cycle()
    assert report.entries_submitted == 1
    assert strong_broker.submitted == []


def test_kill_switch_blocks_entries(settings, store, strong_broker):
    trader = build(settings, store, strong_broker)
    trader.risk.engage_kill_switch("test")
    report = trader.run_cycle()
    assert report.entries_submitted == 0
    assert any("entries_blocked" in note for note in report.notes or [])


def test_flat_market_produces_no_trade(settings, store):
    flat = FakeBroker(
        prices={"AAPL": [100.0] * 80, "MSFT": [200.0] * 80, "SPY": [500.0] * 80}
    )
    report = build(settings, store, flat).run_cycle()
    assert report.entries_submitted == 0
    assert flat.submitted == []


def test_expensive_spread_blocks_the_trade(settings, store, strong_broker):
    """A signal that survives a tight spread must still fail a punitive one."""
    strict = Settings(**{**settings.__dict__, "risk": RiskConfig(min_net_ev_bps=100_000.0)})
    report = build(strict, store, strong_broker).run_cycle()
    assert report.entries_submitted == 0
    reasons = {d["reason"] for d in store.decisions_for_day()}
    assert "net_ev_below_bps_floor" in reasons or "net_ev_not_positive" in reasons


def test_equity_is_snapshotted_each_cycle(settings, store, strong_broker):
    build(settings, store, strong_broker).run_cycle()
    assert store.latest_equity() is not None
    assert store.latest_equity()["equity"] == pytest.approx(30.0)


def test_unfilled_orders_are_not_double_counted(settings, store):
    pending = FakeBroker(
        equity=30.0, cash=30.0, auto_fill=False,
        prices={
            "AAPL": trending_prices(80, 100.0, drift=0.45),
            "MSFT": trending_prices(80, 200.0, drift=-0.45),
            "SPY": trending_prices(80, 500.0, drift=0.3),
        },
    )
    trader = build(settings, store, pending)
    trader.run_cycle()
    trader.sync_orders()
    assert store.open_trades() == []

    pending.fill("order-1")
    trader.sync_orders()
    assert len(store.open_trades()) == 1
    trader.sync_orders()
    assert len(store.open_trades()) == 1


def test_one_entry_per_cycle(settings, store):
    both_up = FakeBroker(
        equity=30.0, cash=30.0,
        prices={
            "AAPL": trending_prices(80, 100.0, drift=0.45),
            "MSFT": trending_prices(80, 200.0, drift=0.45),
            "SPY": trending_prices(80, 500.0, drift=0.3),
        },
    )
    report = build(settings, store, both_up).run_cycle()
    assert report.entries_submitted == 1
    assert len(both_up.submitted) == 1

"""Backtest engine and calibration.

The properties tested here are the ones that separate a useful backtest from a
flattering one: no lookahead, cash conservation, costs actually charged, and
pessimistic intrabar ordering.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import pytest

from trading_bot.backtest import calibrate, default_grid, load_csv, run_backtest
from trading_bot.backtest.calibrate import _split, apply_params
from trading_bot.backtest.engine import OpenPosition, _exit_trigger
from trading_bot.brokers.base import Bar
from trading_bot.config import RiskConfig, Settings
from trading_bot.db import Store

START = datetime(2024, 1, 2, tzinfo=timezone.utc)


def random_walk(count: int, start: float, drift: float, seed: int, vol: float = 0.012) -> list[Bar]:
    """A deterministic random walk: no edge to find, which is the point."""
    rnd = random.Random(seed)
    price = start
    bars: list[Bar] = []
    for index in range(count):
        nxt = max(price * (1 + drift + rnd.gauss(0, vol)), 1.0)
        bars.append(
            Bar(
                timestamp=START + timedelta(days=index),
                open=price,
                high=max(price, nxt) * 1.004,
                low=min(price, nxt) * 0.996,
                close=nxt,
                volume=rnd.uniform(8e5, 3e6),
            )
        )
        price = nxt
    return bars


@pytest.fixture()
def history() -> dict[str, list[Bar]]:
    return {
        "AAPL": random_walk(500, 180.0, 0.0006, 1),
        "MSFT": random_walk(500, 320.0, 0.0003, 2),
        "SPY": random_walk(500, 480.0, 0.0004, 3),
    }


@pytest.fixture()
def bt_settings() -> Settings:
    return Settings(
        alpaca_api_key="k", alpaca_secret_key="s", universe=("AAPL", "MSFT"),
        benchmark="SPY", log_file="",
    )


# ------------------------------------------------------------------- engine
def test_backtest_produces_metrics_from_the_shared_schema(bt_settings, history):
    result = run_backtest(bt_settings, history)
    assert result.bars_processed == 500
    assert result.metrics.trades_total > 0
    assert result.symbols == ["AAPL", "MSFT", "SPY"]
    assert "net_pnl" in result.summary()


def test_cash_is_conserved_exactly(bt_settings, history):
    """Final equity must equal starting equity plus the sum of net P&L."""
    store = Store(":memory:")
    result = run_backtest(bt_settings, history, store=store)
    net = sum(float(trade["net_pnl"]) for trade in store.closed_trades())
    assert store.latest_equity()["equity"] == pytest.approx(
        bt_settings.risk.starting_equity + net, abs=1e-9
    )
    assert result.metrics.net_pnl == pytest.approx(net, abs=1e-9)
    store.close()


def test_every_trade_pays_costs(bt_settings, history):
    store = Store(":memory:")
    run_backtest(bt_settings, history, store=store)
    trades = store.closed_trades()
    assert trades
    for trade in trades:
        assert trade["fees"] > 0
        assert trade["net_pnl"] == pytest.approx(trade["gross_pnl"] - trade["fees"], abs=1e-9)
    store.close()


def test_spread_cost_is_visible_in_the_fee_total(bt_settings, history):
    """The spread is the dominant cost at $30; it must not hide in the fill price."""
    store = Store(":memory:")
    run_backtest(bt_settings, history, store=store)
    trades = store.closed_trades()
    regulatory_only = sum(t["entry_price"] * t["quantity"] * 3e-5 for t in trades)
    assert sum(t["fees"] for t in trades) > regulatory_only * 5
    store.close()


def test_no_position_is_left_open(bt_settings, history):
    store = Store(":memory:")
    run_backtest(bt_settings, history, store=store)
    assert store.open_trades() == []
    closed = store.closed_trades()
    assert closed
    # Every trade ends for a stated reason, and they are all reasons we model.
    assert all(trade["exit_reason"] for trade in closed)
    assert set(trade["exit_reason"] for trade in closed) <= {
        "stop_loss", "take_profit", "time_stop", "end_of_backtest",
    }
    store.close()


def test_backtest_is_deterministic(bt_settings, history):
    first = run_backtest(bt_settings, history).summary()
    second = run_backtest(bt_settings, history).summary()
    assert first == second


def test_short_history_is_refused_rather_than_faked(bt_settings):
    with pytest.raises(ValueError, match="historial insuficiente"):
        run_backtest(bt_settings, {"AAPL": random_walk(20, 100.0, 0.0, 1)})


def test_empty_history_is_refused(bt_settings):
    with pytest.raises(ValueError):
        run_backtest(bt_settings, {})


def test_every_decision_is_recorded_including_rejections(bt_settings, history):
    store = Store(":memory:")
    result = run_backtest(bt_settings, history, store=store)
    assert result.rejections
    assert sum(result.rejections.values()) > result.metrics.trades_total
    store.close()


def test_stop_is_assumed_to_fill_before_the_target(bt_settings):
    """A bar that spans both levels must book the loss, not the win."""
    position = OpenPosition(
        symbol="AAPL", quantity=0.1, entry_price=100.0, opened_at=START,
        opened_day="2024-01-02", trade_id=1, decision_id=1,
    )
    engulfing = Bar(timestamp=START, open=100.0, high=110.0, low=90.0, close=105.0, volume=1e6)
    reason, price = _exit_trigger(position, engulfing, RiskConfig())
    assert reason == "stop_loss"
    assert price == pytest.approx(100.0 * (1 - RiskConfig().stop_loss_pct))


def test_time_stop_closes_a_stale_position(bt_settings):
    position = OpenPosition(
        symbol="AAPL", quantity=0.1, entry_price=100.0, opened_at=START,
        opened_day="2024-01-02", trade_id=1, decision_id=1,
    )
    later = Bar(
        timestamp=START + timedelta(days=RiskConfig().max_holding_days),
        open=100.0, high=100.5, low=99.5, close=100.2, volume=1e6,
    )
    reason, _price = _exit_trigger(position, later, RiskConfig())
    assert reason == "time_stop"


def test_a_flat_market_never_trades(bt_settings):
    flat = {symbol: [
        Bar(START + timedelta(days=i), 100.0, 100.0, 100.0, 100.0, 1e6) for i in range(200)
    ] for symbol in ("AAPL", "SPY")}
    result = run_backtest(bt_settings, flat)
    assert result.metrics.trades_total == 0
    assert result.metrics.net_pnl == 0.0


def test_no_lookahead_a_prefix_of_history_gives_the_same_early_trades(bt_settings, history):
    """Truncating the future must not change decisions already taken."""
    full_store = Store(":memory:")
    run_backtest(bt_settings, history, store=full_store)
    cut = {symbol: bars[:300] for symbol, bars in history.items()}
    short_store = Store(":memory:")
    run_backtest(bt_settings, cut, store=short_store)

    boundary = history["AAPL"][250].timestamp.isoformat()
    full_early = [
        (t["symbol"], round(t["entry_price"], 6))
        for t in full_store.closed_trades() if t["opened_at"] < boundary
    ]
    short_early = [
        (t["symbol"], round(t["entry_price"], 6))
        for t in short_store.closed_trades() if t["opened_at"] < boundary
    ]
    assert full_early == short_early
    full_store.close()
    short_store.close()


def test_risk_limits_apply_during_the_backtest(bt_settings, history):
    """The backtest runs the real RiskSentinel, so its caps must bind."""
    capped = Settings(**{**bt_settings.__dict__, "risk": RiskConfig(max_open_positions=1)})
    store = Store(":memory:")
    run_backtest(capped, history, store=store)
    # Reconstruct concurrency from the trade timeline.
    events: list[tuple[str, int]] = []
    for trade in store.closed_trades():
        events.append((trade["opened_at"], 1))
        events.append((trade["closed_at"], -1))
    concurrent = peak = 0
    for _stamp, delta in sorted(events):
        concurrent += delta
        peak = max(peak, concurrent)
    assert peak <= 1
    store.close()


def test_csv_loader_reads_a_written_file(tmp_path):
    path = tmp_path / "AAPL.csv"
    path.write_text(
        "timestamp,open,high,low,close,volume\n"
        "2024-01-02T00:00:00+00:00,100,101,99,100.5,1000\n"
        "2024-01-03,100.5,102,100,101.5,1200\n",
        encoding="utf-8",
    )
    bars = load_csv(path)
    assert len(bars) == 2
    assert bars[0].close == pytest.approx(100.5)
    assert bars[1].timestamp > bars[0].timestamp


# -------------------------------------------------------------- calibration
def test_apply_params_targets_the_right_config_object(bt_settings):
    tuned = apply_params(bt_settings, {"edge_scale_bps": 250.0, "stop_loss_pct": 0.05})
    assert tuned.signals.edge_scale_bps == 250.0
    assert tuned.risk.stop_loss_pct == 0.05
    assert bt_settings.signals.edge_scale_bps != 250.0     # original untouched


def test_out_of_sample_split_is_chronological(history):
    in_sample, held_out = _split(history, 0.3)
    assert in_sample["AAPL"][-1].timestamp < history["AAPL"][-1].timestamp
    assert held_out["AAPL"][-1].timestamp == history["AAPL"][-1].timestamp
    # The held-out slice keeps a warmup tail, so it overlaps deliberately.
    assert held_out["AAPL"][0].timestamp < in_sample["AAPL"][-1].timestamp


def test_calibration_ranks_by_net_result(bt_settings, history):
    grid = {"take_profit_pct": [0.03, 0.06], "stop_loss_pct": [0.02]}
    report = calibrate(bt_settings, history, grid=grid, min_trades=3)
    assert report.grid_size == 2
    assert report.baseline is not None
    assert "Calibración" in report.text()
    payload = report.as_dict()
    assert payload["evaluated"] == 3        # baseline + two grid points


def test_calibration_flags_an_edge_that_does_not_survive_out_of_sample(bt_settings, history):
    """On a random walk the winning parameters are noise, and must be labelled so."""
    grid = {"take_profit_pct": [0.02, 0.03, 0.05], "stop_loss_pct": [0.015, 0.03]}
    report = calibrate(bt_settings, history, grid=grid, min_trades=3, out_of_sample_fraction=0.3)
    if report.out_of_sample is not None and not report.out_of_sample["holds"]:
        assert "sobreajuste" in report.text()
    assert report.best is None or report.best.trades >= 3


def test_thin_results_are_reported_but_not_recommended(bt_settings, history):
    report = calibrate(bt_settings, history, grid={"min_confidence": [0.99]}, min_trades=500)
    assert report.best is None
    assert "resultado, no un error" in report.text()


def test_default_grid_only_touches_known_parameters(bt_settings):
    """Every grid key must reach a real config field, on risk or on signals."""
    for key, values in default_grid().items():
        # Pick a value that differs from the default so the change is observable.
        candidate = next(
            (value for value in values if value != _current(bt_settings, key)), values[0]
        )
        tuned = apply_params(bt_settings, {key: candidate})
        assert _current(tuned, key) == candidate
        assert _current(bt_settings, key) != candidate or len(values) == 1


def _current(settings, key: str):
    if hasattr(settings.risk, key):
        return getattr(settings.risk, key)
    return getattr(settings.signals, key)

"""LearningLoop tests: grading closed trades and moving the weights."""

from __future__ import annotations

import pytest

from trading_bot.agents.learning_loop import MAX_WEIGHT, MIN_WEIGHT, LearningLoop, target_weight
from trading_bot.config import Settings
from trading_bot.db import Store


def close_trade(store: Store, *, symbol="AAPL", entry=100.0, exit_price=103.0, components=None):
    trade_id = store.open_trade(
        {
            "symbol": symbol,
            "quantity": 0.1,
            "entry_price": entry,
            "signals": {"components": components or {"trend": 0.8, "sentiment": -0.6}},
            "expected_move_bps": 200.0,
        }
    )
    gross = (exit_price - entry) * 0.1
    store.close_trade(
        trade_id,
        exit_price=exit_price,
        gross_pnl=gross,
        fees=0.02,
        net_pnl=gross - 0.02,
        return_pct=(gross - 0.02) / (entry * 0.1),
        exit_reason="take_profit" if exit_price > entry else "stop_loss",
    )
    return trade_id


def test_target_weight_maps_accuracy_onto_the_weight_range():
    assert target_weight(0.5) == pytest.approx(1.0)
    assert target_weight(1.0) == pytest.approx(MAX_WEIGHT)
    assert target_weight(0.0) == pytest.approx(MIN_WEIGHT)
    assert target_weight(-5) == pytest.approx(MIN_WEIGHT)


def test_review_grades_each_component_against_the_realized_move(settings: Settings, store: Store):
    loop = LearningLoop(settings, store)
    trade_id = close_trade(store, exit_price=103.0)
    review = loop.review_trade(store.get_trade(trade_id))

    assert review.direction_correct is True
    assert review.realized_move_bps == pytest.approx(300.0)
    # trend was long and the price rose: a hit. Sentiment was bearish: a miss.
    assert review.graded == {"trend": True, "sentiment": False}


def test_components_below_the_participation_threshold_are_not_graded(settings, store):
    loop = LearningLoop(settings, store)
    trade_id = close_trade(store, components={"trend": 0.9, "volume": 0.01})
    review = loop.review_trade(store.get_trade(trade_id))
    assert "volume" not in review.graded


def test_winning_signals_gain_weight_and_losing_signals_lose_it(settings, store):
    loop = LearningLoop(settings, store)
    before = store.weight_values()
    for _ in range(4):
        close_trade(store, exit_price=104.0, components={"trend": 0.8, "sentiment": -0.7})

    summary = loop.run()
    after = summary["weights"]

    assert summary["reviewed"] == 4
    assert after["trend"] > before["trend"]
    assert after["sentiment"] < before["sentiment"]


def test_weights_stay_inside_their_bounds(settings, store):
    loop = LearningLoop(settings, store)
    for _ in range(30):
        close_trade(store, exit_price=104.0, components={"trend": 0.9})
    loop.run()
    for _ in range(30):
        close_trade(store, exit_price=96.0, components={"mean_reversion": 0.9})
    weights = loop.run()["weights"]
    assert all(MIN_WEIGHT <= value <= MAX_WEIGHT for value in weights.values())


def test_trades_are_reviewed_only_once(settings, store):
    loop = LearningLoop(settings, store)
    close_trade(store)
    assert loop.run()["reviewed"] == 1
    assert loop.run()["reviewed"] == 0


def test_a_losing_trade_flips_the_grade(settings, store):
    loop = LearningLoop(settings, store)
    trade_id = close_trade(store, exit_price=97.0, components={"trend": 0.8, "sentiment": -0.6})
    review = loop.review_trade(store.get_trade(trade_id))
    assert review.direction_correct is False
    assert review.graded == {"trend": False, "sentiment": True}


def test_signal_performance_reports_the_scoreboard(settings, store):
    loop = LearningLoop(settings, store)
    close_trade(store, exit_price=105.0)
    loop.run()
    rows = {row["signal"]: row for row in loop.signal_performance()}
    assert rows["trend"]["hits"] == 1
    assert rows["sentiment"]["misses"] == 1
    assert rows["trend"]["hit_rate"] == pytest.approx(1.0)


def test_incomplete_trades_are_skipped(settings, store):
    loop = LearningLoop(settings, store)
    trade_id = store.open_trade({"symbol": "AAPL", "quantity": 0.1, "entry_price": 100.0})
    assert loop.review_trade(store.get_trade(trade_id)) is None

"""Indicator and fusion tests."""

from __future__ import annotations

from datetime import timedelta

import pytest

from conftest import BASE_TIME, make_bars, trending_prices
from trading_bot.signals.combiner import aggregate_sentiment, fuse_signals
from trading_bot.signals.indicators import (
    SignalSet,
    atr,
    ema,
    momentum,
    realized_volatility,
    relative_volume,
    rsi,
    sma,
    technical_signals,
)


def test_sma_and_ema_need_enough_history():
    assert sma([1, 2, 3], 5) is None
    assert sma([1, 2, 3, 4], 4) == pytest.approx(2.5)
    assert ema([1, 2, 3], 5) is None
    assert ema([1] * 10, 5) == pytest.approx(1.0)


def test_rsi_bounds():
    assert rsi([1, 2], 14) is None
    rising = rsi(list(range(1, 40)), 14)
    falling = rsi(list(range(40, 1, -1)), 14)
    assert rising == pytest.approx(100.0)
    assert falling == pytest.approx(0.0, abs=1e-9)
    flat = rsi([10.0] * 40, 14)
    assert flat == pytest.approx(50.0)


def test_momentum_and_volatility():
    assert momentum([100, 101, 102], 10) is None
    assert momentum([100] * 10 + [110], 10) == pytest.approx(0.10)
    assert realized_volatility([100.0] * 30, 20) == pytest.approx(0.0)


def test_relative_volume_compares_to_the_recent_average():
    bars = make_bars([100.0] * 25)
    assert relative_volume(bars, 20) == pytest.approx(1.0)
    spike = make_bars([100.0] * 24) + make_bars([100.0], start=BASE_TIME + timedelta(hours=8), volume=5000.0)
    assert relative_volume(spike, 20) == pytest.approx(5.0)


def test_atr_is_positive_for_moving_bars():
    bars = make_bars(trending_prices(40))
    assert atr(bars, 14) > 0


def test_technical_signals_omit_indicators_without_history():
    signals = technical_signals(make_bars([100.0, 101.0, 102.0]))
    assert "trend" not in signals.scores
    assert signals.context["bars"] == 3


def test_uptrend_produces_a_positive_trend_score():
    signals = technical_signals(make_bars(trending_prices(80, drift=0.3)))
    assert signals.scores["trend"] > 0
    assert signals.scores["momentum"] > 0


def test_downtrend_produces_a_negative_trend_score():
    signals = technical_signals(make_bars(trending_prices(80, drift=-0.3)))
    assert signals.scores["trend"] < 0
    assert signals.scores["momentum"] < 0


def test_scores_stay_within_bounds():
    signals = technical_signals(make_bars(trending_prices(80, drift=5.0)))
    assert all(-1.0 <= value <= 1.0 for value in signals.scores.values())


# ------------------------------------------------------------------ fusion
def test_fusion_returns_hold_without_signals():
    fused = fuse_signals("AAPL", SignalSet())
    assert fused.action == "hold"
    assert fused.confidence == 0.0
    assert fused.context["reason"] == "no_signals"


def test_agreeing_signals_beat_conflicting_ones():
    agreeing = fuse_signals(
        "AAPL",
        SignalSet(scores={"trend": 0.8, "momentum": 0.7, "volume": 0.6}),
        sentiment=0.8,
        regime=0.5,
    )
    conflicting = fuse_signals(
        "AAPL",
        SignalSet(scores={"trend": 0.8, "momentum": -0.7, "volume": 0.6}),
        sentiment=-0.8,
        regime=-0.5,
    )
    assert agreeing.confidence > conflicting.confidence
    assert agreeing.action == "buy"
    assert conflicting.action == "hold"


def test_weights_shift_the_fused_score():
    scores = SignalSet(scores={"trend": 1.0, "mean_reversion": -1.0})
    trend_heavy = fuse_signals("AAPL", scores, weights={"trend": 2.0, "mean_reversion": 0.5})
    reversion_heavy = fuse_signals("AAPL", scores, weights={"trend": 0.5, "mean_reversion": 2.0})
    assert trend_heavy.score > 0 > reversion_heavy.score


def test_expected_move_scales_with_conviction():
    weak = fuse_signals("AAPL", SignalSet(scores={"trend": 0.2, "momentum": 0.2}), edge_scale_bps=120)
    strong = fuse_signals("AAPL", SignalSet(scores={"trend": 0.9, "momentum": 0.9}), edge_scale_bps=120)
    assert strong.expected_move_bps > weak.expected_move_bps
    assert strong.expected_move_bps <= 120


def test_low_confidence_forces_hold():
    fused = fuse_signals(
        "AAPL", SignalSet(scores={"trend": 0.9}), min_confidence=0.9
    )
    assert fused.action == "hold"


def test_a_single_signal_is_never_high_confidence():
    fused = fuse_signals("AAPL", SignalSet(scores={"trend": 1.0}))
    assert fused.confidence < 0.5


# --------------------------------------------------------------- sentiment
def test_sentiment_aggregation_decays_with_age():
    fresh, _ = aggregate_sentiment(
        [{"sentiment_score": 1.0, "confidence": 0.9, "published_at": BASE_TIME.isoformat()}],
        now=BASE_TIME,
    )
    stale, _ = aggregate_sentiment(
        [
            {"sentiment_score": 1.0, "confidence": 0.9, "published_at": BASE_TIME.isoformat()},
            {"sentiment_score": -1.0, "confidence": 0.9,
             "published_at": (BASE_TIME - timedelta(hours=48)).isoformat()},
        ],
        now=BASE_TIME,
        half_life_hours=12.0,
    )
    assert fresh == pytest.approx(1.0)
    # The 48h-old negative story is decayed to near-irrelevance.
    assert stale > 0.8


def test_rumors_and_low_confidence_items_are_ignored():
    score, context = aggregate_sentiment(
        [
            {"sentiment_score": -1.0, "confidence": 0.95, "is_rumor": True,
             "published_at": BASE_TIME.isoformat()},
            {"sentiment_score": -1.0, "confidence": 0.05,
             "published_at": BASE_TIME.isoformat()},
        ],
        now=BASE_TIME,
    )
    assert score is None
    assert context["articles_used"] == 0


def test_no_sentiment_data_returns_none_not_zero():
    score, context = aggregate_sentiment([])
    assert score is None
    assert context["articles"] == 0

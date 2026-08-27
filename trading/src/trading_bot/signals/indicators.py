"""Technical indicators, in pure Python.

No pandas/numpy dependency on the hot path: the universe is a handful of
symbols with a few hundred bars each, and keeping the core dependency-free
makes the risk-critical code trivial to unit test.

Every indicator that feeds the fusion step is normalised to ``[-1, 1]`` where
positive means bullish.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import fmean, pstdev
from typing import Any, Sequence

from ..brokers.base import Bar


def _closes(bars: Sequence[Bar]) -> list[float]:
    return [bar.close for bar in bars]


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def sma(values: Sequence[float], period: int) -> float | None:
    """Simple moving average of the last ``period`` values."""
    if period <= 0 or len(values) < period:
        return None
    return fmean(values[-period:])


def ema(values: Sequence[float], period: int) -> float | None:
    """Exponential moving average, seeded with the first ``period`` values."""
    if period <= 0 or len(values) < period:
        return None
    alpha = 2 / (period + 1)
    result = fmean(values[:period])
    for value in values[period:]:
        result = alpha * value + (1 - alpha) * result
    return result


def rsi(values: Sequence[float], period: int = 14) -> float | None:
    """Wilder's RSI in ``[0, 100]``; ``None`` when there is not enough history."""
    if period <= 0 or len(values) <= period:
        return None
    changes = [values[i] - values[i - 1] for i in range(1, len(values))]
    seed = changes[:period]
    gains = sum(c for c in seed if c > 0) / period
    losses = -sum(c for c in seed if c < 0) / period
    # Wilder smoothing over the remaining changes.
    for change in changes[period:]:
        gain = max(change, 0.0)
        loss = -min(change, 0.0)
        gains = (gains * (period - 1) + gain) / period
        losses = (losses * (period - 1) + loss) / period
    if losses == 0:
        return 100.0 if gains > 0 else 50.0
    rs = gains / losses
    return 100 - (100 / (1 + rs))


def momentum(values: Sequence[float], period: int = 10) -> float | None:
    """Percentage change over ``period`` bars (0.02 == +2%)."""
    if period <= 0 or len(values) <= period:
        return None
    past = values[-period - 1]
    if past == 0:
        return None
    return (values[-1] - past) / past


def relative_volume(bars: Sequence[Bar], lookback: int = 20) -> float | None:
    """Latest bar volume divided by the average of the previous ``lookback``."""
    if lookback <= 0 or len(bars) < lookback + 1:
        return None
    history = [bar.volume for bar in bars[-lookback - 1 : -1]]
    average = fmean(history) if history else 0.0
    if average <= 0:
        return None
    return bars[-1].volume / average


def atr(bars: Sequence[Bar], period: int = 14) -> float | None:
    """Average true range over ``period`` bars."""
    if period <= 0 or len(bars) < period + 1:
        return None
    true_ranges: list[float] = []
    for previous, current in zip(bars[-period - 1 : -1], bars[-period:]):
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return fmean(true_ranges) if true_ranges else None


def realized_volatility(values: Sequence[float], period: int = 20) -> float | None:
    """Standard deviation of simple returns over ``period`` bars."""
    if period <= 1 or len(values) < period + 1:
        return None
    window = values[-period - 1 :]
    returns = [
        (window[i] - window[i - 1]) / window[i - 1]
        for i in range(1, len(window))
        if window[i - 1] != 0
    ]
    if len(returns) < 2:
        return None
    return pstdev(returns)


@dataclass(frozen=True)
class SignalSet:
    """Normalised technical scores plus the raw values behind them."""

    scores: dict[str, float] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)

    def get(self, name: str, default: float = 0.0) -> float:
        return self.scores.get(name, default)

    def as_dict(self) -> dict[str, Any]:
        return {
            "scores": {k: round(v, 4) for k, v in self.scores.items()},
            "context": {
                k: (round(v, 6) if isinstance(v, float) else v) for k, v in self.context.items()
            },
        }


def trend_score(closes: Sequence[float], fast: int, slow: int) -> float | None:
    """Fast/slow moving-average spread, scaled so ~2% separation saturates."""
    fast_ma = sma(closes, fast)
    slow_ma = sma(closes, slow)
    if fast_ma is None or slow_ma is None or slow_ma == 0:
        return None
    return clamp((fast_ma - slow_ma) / slow_ma / 0.02)


def mean_reversion_score(
    closes: Sequence[float], period: int, oversold: float, overbought: float
) -> float | None:
    """RSI as a contrarian signal, active only at the extremes.

    Inside the neutral band the score is exactly 0: a mid-range RSI carries no
    mean-reversion information, and treating every reading above 50 as bearish
    would permanently cancel the trend signal in any trending market.
    """
    value = rsi(closes, period)
    if value is None:
        return None
    if value <= oversold:
        return clamp((oversold - value) / max(oversold, 1e-9))
    if value >= overbought:
        return -clamp((value - overbought) / max(100.0 - overbought, 1e-9))
    return 0.0


def momentum_score(closes: Sequence[float], period: int) -> float | None:
    """Recent return, scaled so a 3% move over the window saturates."""
    change = momentum(closes, period)
    if change is None:
        return None
    return clamp(change / 0.03)


def volume_score(bars: Sequence[Bar], lookback: int) -> float | None:
    """Confirmation only: heavy volume amplifies the direction of the last bar."""
    ratio = relative_volume(bars, lookback)
    if ratio is None or len(bars) < 2:
        return None
    last = bars[-1]
    direction = 1.0 if last.close >= last.open else -1.0
    strength = clamp((ratio - 1.0) / 1.5, 0.0, 1.0)
    return direction * strength


def regime_score(benchmark_bars: Sequence[Bar], fast: int, slow: int) -> float | None:
    """Overall market regime, derived from the benchmark's own trend."""
    if not benchmark_bars:
        return None
    return trend_score(_closes(benchmark_bars), fast, slow)


def technical_signals(
    bars: Sequence[Bar],
    *,
    fast_ma: int = 10,
    slow_ma: int = 30,
    rsi_period: int = 14,
    rsi_oversold: float = 30.0,
    rsi_overbought: float = 70.0,
    momentum_period: int = 10,
    volume_lookback: int = 20,
) -> SignalSet:
    """Compute every technical score available from ``bars``.

    Indicators without enough history are simply absent from ``scores`` - a
    missing signal must not be read as a neutral one.
    """
    closes = _closes(bars)
    scores: dict[str, float] = {}
    context: dict[str, Any] = {"bars": len(bars)}

    trend = trend_score(closes, fast_ma, slow_ma)
    if trend is not None:
        scores["trend"] = trend
        context["fast_ma"] = sma(closes, fast_ma)
        context["slow_ma"] = sma(closes, slow_ma)

    reversion = mean_reversion_score(closes, rsi_period, rsi_oversold, rsi_overbought)
    if reversion is not None:
        scores["mean_reversion"] = reversion
        context["rsi"] = rsi(closes, rsi_period)

    mom = momentum_score(closes, momentum_period)
    if mom is not None:
        scores["momentum"] = mom
        context["momentum_pct"] = momentum(closes, momentum_period)

    vol = volume_score(bars, volume_lookback)
    if vol is not None:
        scores["volume"] = vol
        context["relative_volume"] = relative_volume(bars, volume_lookback)

    volatility = realized_volatility(closes, min(volume_lookback, max(len(closes) - 1, 2)))
    if volatility is not None:
        context["realized_volatility"] = volatility
    average_range = atr(bars, min(rsi_period, max(len(bars) - 1, 2)))
    if average_range is not None:
        context["atr"] = average_range
    if closes:
        context["last_close"] = closes[-1]

    return SignalSet(scores=scores, context=context)

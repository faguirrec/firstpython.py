"""Performance metrics for the 30-day experiment.

With $30 of capital the headline number is not the return - it is the ratio of
fees to P&L. A strategy that is right more often than not can still lose money
to costs, so every aggregate here is computed **net**.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import fmean, pstdev
from typing import Any, Mapping, Sequence

from .clock import parse_iso, trading_day, utcnow
from .db import Store

TRADING_DAYS_PER_YEAR = 252


@dataclass(frozen=True)
class PerformanceMetrics:
    """Everything the daily and final reports need."""

    start_equity: float
    current_equity: float
    net_pnl: float
    return_pct: float
    gross_pnl: float
    total_fees: float
    fee_to_pnl_ratio: float | None
    trades_total: int
    trades_open: int
    wins: int
    losses: int
    win_rate: float
    average_win: float
    average_loss: float
    profit_factor: float | None
    expectancy: float
    max_drawdown_pct: float
    sharpe_ratio: float | None
    benchmark_return_pct: float | None
    excess_return_pct: float | None
    days_elapsed: int
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        def r(value: float | None, digits: int = 4) -> float | None:
            return None if value is None else round(value, digits)

        return {
            "start_equity": r(self.start_equity, 2),
            "current_equity": r(self.current_equity, 2),
            "net_pnl": r(self.net_pnl),
            "return_pct": r(self.return_pct, 6),
            "gross_pnl": r(self.gross_pnl),
            "total_fees": r(self.total_fees),
            "fee_to_pnl_ratio": r(self.fee_to_pnl_ratio),
            "trades_total": self.trades_total,
            "trades_open": self.trades_open,
            "wins": self.wins,
            "losses": self.losses,
            "win_rate": r(self.win_rate),
            "average_win": r(self.average_win),
            "average_loss": r(self.average_loss),
            "profit_factor": r(self.profit_factor),
            "expectancy": r(self.expectancy),
            "max_drawdown_pct": r(self.max_drawdown_pct, 6),
            "sharpe_ratio": r(self.sharpe_ratio),
            "benchmark_return_pct": r(self.benchmark_return_pct, 6),
            "excess_return_pct": r(self.excess_return_pct, 6),
            "days_elapsed": self.days_elapsed,
            **self.extra,
        }


def max_drawdown(equity_curve: Sequence[float]) -> float:
    """Largest peak-to-trough decline, as a negative fraction."""
    peak = float("-inf")
    worst = 0.0
    for value in equity_curve:
        peak = max(peak, value)
        if peak > 0:
            worst = min(worst, (value - peak) / peak)
    return worst


def simple_returns(series: Sequence[float]) -> list[float]:
    return [
        (series[i] - series[i - 1]) / series[i - 1]
        for i in range(1, len(series))
        if series[i - 1] != 0
    ]


def sharpe_ratio(
    returns: Sequence[float], *, periods_per_year: int = TRADING_DAYS_PER_YEAR, risk_free: float = 0.0
) -> float | None:
    """Annualised Sharpe from periodic returns. ``None`` below 2 observations."""
    if len(returns) < 2:
        return None
    excess = [r - risk_free / periods_per_year for r in returns]
    volatility = pstdev(excess)
    if volatility == 0:
        return None
    return (fmean(excess) / volatility) * math.sqrt(periods_per_year)


def benchmark_return(curve: Sequence[Mapping[str, Any]]) -> float | None:
    """Buy-and-hold return of the benchmark over the same window."""
    prices = [
        float(row["benchmark_price"])
        for row in curve
        if row.get("benchmark_price") not in (None, 0)
    ]
    if len(prices) < 2 or prices[0] == 0:
        return None
    return (prices[-1] - prices[0]) / prices[0]


def compute_metrics(store: Store, *, starting_equity: float, benchmark: str = "SPY") -> PerformanceMetrics:
    """Aggregate everything recorded so far into one metrics object."""
    closed = store.closed_trades()
    open_trades = store.open_trades()
    curve = store.daily_equity_curve()
    equity_values = [float(row["equity"]) for row in curve]

    latest = store.latest_equity()
    current_equity = float(latest["equity"]) if latest else starting_equity
    first = curve[0]["equity"] if curve else starting_equity
    start_equity = float(first) if first else starting_equity

    net_values = [float(t.get("net_pnl") or 0.0) for t in closed]
    gross_values = [float(t.get("gross_pnl") or 0.0) for t in closed]
    fees = sum(float(t.get("fees") or 0.0) for t in closed)
    net_pnl = sum(net_values)
    gross_pnl = sum(gross_values)

    wins = [v for v in net_values if v > 0]
    losses = [v for v in net_values if v <= 0]
    gross_wins = sum(wins)
    gross_losses = abs(sum(losses))

    returns = simple_returns(equity_values)
    days = _days_elapsed(store, curve)
    bench = benchmark_return(curve)
    strategy_return = (
        (current_equity - starting_equity) / starting_equity if starting_equity else 0.0
    )

    return PerformanceMetrics(
        start_equity=starting_equity,
        current_equity=current_equity,
        net_pnl=net_pnl,
        return_pct=strategy_return,
        gross_pnl=gross_pnl,
        total_fees=fees,
        fee_to_pnl_ratio=(fees / abs(gross_pnl)) if gross_pnl else None,
        trades_total=len(closed),
        trades_open=len(open_trades),
        wins=len(wins),
        losses=len(losses),
        win_rate=(len(wins) / len(closed)) if closed else 0.0,
        average_win=fmean(wins) if wins else 0.0,
        average_loss=fmean(losses) if losses else 0.0,
        profit_factor=(gross_wins / gross_losses) if gross_losses else None,
        expectancy=fmean(net_values) if net_values else 0.0,
        max_drawdown_pct=max_drawdown(equity_values) if equity_values else 0.0,
        sharpe_ratio=sharpe_ratio(returns),
        benchmark_return_pct=bench,
        excess_return_pct=(strategy_return - bench) if bench is not None else None,
        days_elapsed=days,
        extra={
            "benchmark": benchmark,
            "start_equity_observed": round(start_equity, 4),
            "equity_points": len(equity_values),
        },
    )


def daily_snapshot(store: Store, day: str | None = None) -> dict[str, Any]:
    """Metrics for a single trading day, saved into ``daily_metrics``."""
    key = day or trading_day().isoformat()
    trades = [t for t in store.closed_trades() if t.get("closed_day") == key]
    opened = [t for t in store.open_trades() if t.get("opened_day") == key]
    opened += [t for t in store.closed_trades() if t.get("opened_day") == key]

    first = store.first_equity_of_day(key)
    snapshots = [row for row in store.equity_series() if row.get("trading_day") == key]
    last = snapshots[-1] if snapshots else None

    net_values = [float(t.get("net_pnl") or 0.0) for t in trades]
    metrics = {
        "trading_day": key,
        "start_equity": float(first["equity"]) if first else None,
        "end_equity": float(last["equity"]) if last else None,
        "net_pnl": sum(net_values),
        "gross_pnl": sum(float(t.get("gross_pnl") or 0.0) for t in trades),
        "fees": sum(float(t.get("fees") or 0.0) for t in trades),
        "trades_closed": len(trades),
        "trades_opened": len(opened),
        "wins": sum(1 for v in net_values if v > 0),
        "losses": sum(1 for v in net_values if v <= 0),
        "benchmark_price": (last or {}).get("benchmark_price"),
    }
    store.save_daily_metrics(key, metrics)
    return metrics


def _days_elapsed(store: Store, curve: Sequence[Mapping[str, Any]]) -> int:
    started = store.get_state("experiment_started_at")
    start_date = parse_iso(started) if isinstance(started, str) else None
    if start_date is not None:
        return max((utcnow() - start_date).days, 0)
    return len(curve)

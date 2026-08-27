"""Backtesting and parameter calibration.

The point of this package is parity: it replays history through the *same*
``technical_signals`` -> ``fuse_signals`` -> ``evaluate_net_ev`` -> RiskSentinel
path the live bot uses, and writes its results into the same
:class:`~trading_bot.db.Store` schema, so ``compute_metrics`` and the reports
produce identical numbers for a simulated run and a real one.

A backtest that re-implements the strategy is a backtest that lies.
"""

from .data import load_bars, load_csv, load_from_broker, load_yfinance
from .engine import BacktestResult, run_backtest
from .calibrate import CalibrationRun, calibrate, default_grid

__all__ = [
    "BacktestResult",
    "CalibrationRun",
    "calibrate",
    "default_grid",
    "load_bars",
    "load_csv",
    "load_from_broker",
    "load_yfinance",
    "run_backtest",
]

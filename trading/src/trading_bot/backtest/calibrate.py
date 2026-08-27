"""Parameter calibration by grid search over backtests.

This exists to answer one uncomfortable question: ``EDGE_SCALE_BPS`` and the
confidence and exit thresholds were picked by judgement, not measurement. A
sweep over history turns them into numbers with evidence behind them - and,
just as usefully, shows when *no* setting produces a positive net expectancy,
which is a result worth having before risking 30 days.

Guard rails against fooling yourself:

* Results are ranked by **net** expectancy after costs, never gross.
* Any combination with fewer than ``min_trades`` closed trades is reported but
  flagged as statistically meaningless.
* An optional out-of-sample split refits nothing - it just re-runs the winning
  combination on held-out bars and shows whether the edge survives.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Mapping, Sequence

from ..brokers.base import Bar
from ..config import RiskConfig, Settings, SignalConfig
from ..logging_setup import get_logger
from .engine import BacktestResult, run_backtest

log = get_logger(__name__)

# Fields that live on SignalConfig rather than RiskConfig.
_SIGNAL_FIELDS = {
    "fast_ma", "slow_ma", "rsi_period", "rsi_oversold", "rsi_overbought",
    "momentum_period", "volume_lookback", "edge_scale_bps", "sentiment_half_life_hours",
}


@dataclass(frozen=True)
class CalibrationRun:
    """One point in the parameter grid."""

    params: dict[str, Any]
    summary: dict[str, Any]
    trades: int
    net_pnl: float
    expectancy: float
    win_rate: float
    max_drawdown_pct: float
    enough_data: bool
    error: str = ""

    @property
    def score(self) -> float:
        """Rank by net P&L, penalised by drawdown; no trades scores zero."""
        if not self.enough_data or self.error:
            return float("-inf")
        return self.net_pnl - abs(self.max_drawdown_pct) * abs(self.net_pnl) * 0.5

    def as_dict(self) -> dict[str, Any]:
        return {
            "params": self.params,
            "trades": self.trades,
            "net_pnl": round(self.net_pnl, 4),
            "expectancy": round(self.expectancy, 5),
            "win_rate": round(self.win_rate, 4),
            "max_drawdown_pct": round(self.max_drawdown_pct, 6),
            "enough_data": self.enough_data,
            "score": None if self.score == float("-inf") else round(self.score, 5),
            "error": self.error,
        }


@dataclass
class CalibrationReport:
    """The full sweep plus the winning combination."""

    runs: list[CalibrationRun] = field(default_factory=list)
    best: CalibrationRun | None = None
    baseline: CalibrationRun | None = None
    out_of_sample: dict[str, Any] | None = None
    grid_size: int = 0

    def as_dict(self) -> dict[str, Any]:
        ranked = sorted(self.runs, key=lambda run: run.score, reverse=True)
        return {
            "grid_size": self.grid_size,
            "evaluated": len(self.runs),
            "with_enough_data": sum(1 for run in self.runs if run.enough_data),
            "baseline": self.baseline.as_dict() if self.baseline else None,
            "best": self.best.as_dict() if self.best else None,
            "out_of_sample": self.out_of_sample,
            "top": [run.as_dict() for run in ranked[:10]],
        }

    def text(self) -> str:
        lines = ["Calibración de parámetros", ""]
        if self.baseline:
            lines.append(f"  Configuración actual: {_fmt(self.baseline)}")
        if not self.best:
            lines.append("  Ninguna combinación produjo trades suficientes para concluir algo.")
            lines.append("  Con $30 y este filtro de costos, eso es un resultado, no un error:")
            lines.append("  el sistema está diciendo que no ve edge que cubra los costos.")
            return "\n".join(lines)

        lines.append(f"  Mejor combinación:    {_fmt(self.best)}")
        lines.append("")
        lines.append("  Parámetros sugeridos:")
        for key, value in self.best.params.items():
            lines.append(f"    {key.upper()}={value}")
        if self.out_of_sample:
            lines.append("")
            oos = self.out_of_sample
            lines.append(
                f"  Fuera de muestra: {oos['trades']} trades, "
                f"P&L neto ${oos['net_pnl']:.4f}, win rate {oos['win_rate'] * 100:.1f}%"
            )
            if not oos.get("holds"):
                lines.append(
                    "    AVISO: el resultado no se sostiene fuera de muestra. "
                    "Trátalo como sobreajuste, no como hallazgo."
                )
        lines.append("")
        lines.append("  Recuerda: un backtest favorable no es una promesa. Estos parámetros")
        lines.append("  se ajustaron sobre el mismo historial con el que se evaluaron.")
        return "\n".join(lines)


def default_grid() -> dict[str, list[Any]]:
    """A small, defensible grid: the parameters that actually move the needle."""
    return {
        "edge_scale_bps": [80.0, 120.0, 200.0, 300.0],
        "min_confidence": [0.25, 0.35, 0.5],
        "take_profit_pct": [0.02, 0.03, 0.05],
        "stop_loss_pct": [0.015, 0.02, 0.03],
    }


def apply_params(settings: Settings, params: Mapping[str, Any]) -> Settings:
    """Return a copy of ``settings`` with the grid point applied."""
    signal_updates = {k: v for k, v in params.items() if k in _SIGNAL_FIELDS}
    risk_updates = {k: v for k, v in params.items() if k not in _SIGNAL_FIELDS}
    signals = replace(settings.signals, **signal_updates) if signal_updates else settings.signals
    risk = replace(settings.risk, **risk_updates) if risk_updates else settings.risk
    return replace(settings, signals=signals, risk=risk)


def calibrate(
    settings: Settings,
    bars_by_symbol: Mapping[str, Sequence[Bar]],
    *,
    grid: Mapping[str, Iterable[Any]] | None = None,
    min_trades: int = 10,
    out_of_sample_fraction: float = 0.3,
) -> CalibrationReport:
    """Sweep the grid and report what history supports."""
    grid = dict(grid or default_grid())
    keys = list(grid)
    combinations = list(itertools.product(*(list(grid[key]) for key in keys)))
    report = CalibrationReport(grid_size=len(combinations))

    in_sample, held_out = _split(bars_by_symbol, out_of_sample_fraction)

    report.baseline = _evaluate(settings, in_sample, {}, min_trades)
    report.runs.append(report.baseline)

    for values in combinations:
        params = dict(zip(keys, values))
        run = _evaluate(apply_params(settings, params), in_sample, params, min_trades)
        report.runs.append(run)
        log.debug("calibration_point", extra={"event": run.as_dict()})

    viable = [run for run in report.runs if run.enough_data and not run.error and run.params]
    if viable:
        report.best = max(viable, key=lambda run: run.score)
        if held_out:
            report.out_of_sample = _out_of_sample(settings, held_out, report.best, min_trades)
    return report


def _evaluate(
    settings: Settings,
    bars_by_symbol: Mapping[str, Sequence[Bar]],
    params: Mapping[str, Any],
    min_trades: int,
) -> CalibrationRun:
    try:
        result: BacktestResult = run_backtest(settings, bars_by_symbol, params=params)
    except (ValueError, KeyError) as exc:
        return CalibrationRun(
            params=dict(params), summary={}, trades=0, net_pnl=0.0, expectancy=0.0,
            win_rate=0.0, max_drawdown_pct=0.0, enough_data=False, error=str(exc),
        )
    metrics = result.metrics
    return CalibrationRun(
        params=dict(params),
        summary=result.summary(),
        trades=metrics.trades_total,
        net_pnl=metrics.net_pnl,
        expectancy=metrics.expectancy,
        win_rate=metrics.win_rate,
        max_drawdown_pct=metrics.max_drawdown_pct,
        enough_data=metrics.trades_total >= min_trades,
    )


def _out_of_sample(
    settings: Settings,
    held_out: Mapping[str, Sequence[Bar]],
    best: CalibrationRun,
    min_trades: int,
) -> dict[str, Any]:
    run = _evaluate(apply_params(settings, best.params), held_out, best.params, min_trades)
    holds = run.net_pnl > 0 and run.trades >= max(min_trades // 3, 2)
    return {
        "trades": run.trades,
        "net_pnl": round(run.net_pnl, 4),
        "win_rate": round(run.win_rate, 4),
        "expectancy": round(run.expectancy, 5),
        "holds": holds,
        "error": run.error,
    }


def _split(
    bars_by_symbol: Mapping[str, Sequence[Bar]], fraction: float
) -> tuple[dict[str, list[Bar]], dict[str, list[Bar]]]:
    """Chronological split - never random, that would leak the future."""
    if not 0 < fraction < 1:
        return {s: list(b) for s, b in bars_by_symbol.items()}, {}
    in_sample: dict[str, list[Bar]] = {}
    held_out: dict[str, list[Bar]] = {}
    for symbol, bars in bars_by_symbol.items():
        series = list(bars)
        cut = int(len(series) * (1 - fraction))
        in_sample[symbol] = series[:cut]
        # The held-out slice keeps the warmup tail so indicators are primed.
        held_out[symbol] = series[max(cut - 60, 0):]
    if any(len(bars) < 30 for bars in held_out.values()):
        return in_sample, {}
    return in_sample, held_out


def _fmt(run: CalibrationRun) -> str:
    label = ", ".join(f"{k}={v}" for k, v in run.params.items()) or "por defecto"
    if run.error:
        return f"{label} -> error: {run.error}"
    if not run.enough_data:
        return f"{label} -> {run.trades} trades (muestra insuficiente)"
    return (
        f"{label} -> {run.trades} trades, P&L neto ${run.net_pnl:.4f}, "
        f"win rate {run.win_rate * 100:.1f}%, DD {run.max_drawdown_pct * 100:.1f}%"
    )

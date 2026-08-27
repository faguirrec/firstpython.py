"""Event-driven backtest over historical bars.

Design constraints that keep the results honest:

* **Same code path.** Signals, fusion, net-EV and RiskSentinel are the live
  modules, not copies. Results are written into a real ``Store`` so the same
  ``compute_metrics`` produces the report.
* **No lookahead.** At bar *i* the strategy sees ``bars[:i+1]`` and nothing more.
  Entries fill on bar *i* at its close plus costs; exits are checked from bar
  *i+1* onward.
* **Pessimistic intrabar ordering.** When a bar's range touches both the stop
  and the target, the stop is assumed to fill first.
* **Costs always charged.** Entry and exit each pay half-spread plus slippage,
  and the sell side pays the modelled SEC and TAF fees.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Mapping, Sequence

from ..agents.risk_sentinel import RiskSentinel
from ..brokers.base import AccountSnapshot, Bar, Position
from ..clock import iso, trading_day
from ..config import Settings
from ..costs import realized_costs
from ..db import Store
from ..logging_setup import get_logger
from ..metrics import PerformanceMetrics, compute_metrics
from ..signals import fuse_signals, technical_signals
from ..signals.combiner import FusedSignal
from ..signals.indicators import regime_score

log = get_logger(__name__)

BPS = 1e-4


@dataclass
class OpenPosition:
    """A simulated open position."""

    symbol: str
    quantity: float
    entry_price: float
    opened_at: datetime
    opened_day: str
    trade_id: int
    decision_id: int
    signal: dict[str, Any] = field(default_factory=dict)
    entry_execution_cost: float = 0.0


@dataclass(frozen=True)
class BacktestResult:
    """Outcome of one simulated run."""

    metrics: PerformanceMetrics
    trades: list[dict[str, Any]]
    rejections: dict[str, int]
    bars_processed: int
    symbols: list[str]
    start: str | None
    end: str | None
    params: dict[str, Any] = field(default_factory=dict)
    store: Store | None = None

    def summary(self) -> dict[str, Any]:
        return {
            "symbols": self.symbols,
            "start": self.start,
            "end": self.end,
            "bars": self.bars_processed,
            "trades": self.metrics.trades_total,
            "net_pnl": round(self.metrics.net_pnl, 4),
            "return_pct": round(self.metrics.return_pct, 6),
            "win_rate": round(self.metrics.win_rate, 4),
            "expectancy": round(self.metrics.expectancy, 5),
            "profit_factor": self.metrics.profit_factor,
            "max_drawdown_pct": round(self.metrics.max_drawdown_pct, 6),
            "sharpe_ratio": self.metrics.sharpe_ratio,
            "total_fees": round(self.metrics.total_fees, 4),
            "fee_to_pnl_ratio": self.metrics.fee_to_pnl_ratio,
            "benchmark_return_pct": self.metrics.benchmark_return_pct,
            "excess_return_pct": self.metrics.excess_return_pct,
            "top_rejections": dict(
                sorted(self.rejections.items(), key=lambda kv: kv[1], reverse=True)[:6]
            ),
            "params": self.params,
        }


def run_backtest(
    settings: Settings,
    bars_by_symbol: Mapping[str, Sequence[Bar]],
    *,
    warmup: int | None = None,
    store: Store | None = None,
    params: Mapping[str, Any] | None = None,
) -> BacktestResult:
    """Replay ``bars_by_symbol`` through the live decision stack."""
    symbols = [s for s, bars in bars_by_symbol.items() if bars]
    if not symbols:
        raise ValueError("no hay barras para simular")

    signal_config = settings.signals
    risk_config = settings.risk
    needed = max(signal_config.slow_ma, signal_config.rsi_period, signal_config.volume_lookback) + 2
    warmup = max(warmup or needed, needed)

    owned_store = store is None
    store = store or Store(":memory:")
    store.ensure_weights(signal_config.seed_weights)
    risk = RiskSentinel(settings, store)

    index = _build_index(bars_by_symbol)
    timeline = index["timeline"]
    if len(timeline) <= warmup:
        raise ValueError(
            f"historial insuficiente: {len(timeline)} barras, se necesitan más de {warmup}"
        )

    benchmark_bars = list(bars_by_symbol.get(settings.benchmark, []))
    cash = risk_config.starting_equity
    positions: dict[str, OpenPosition] = {}
    rejections: dict[str, int] = {}
    last_close: dict[str, float] = {}
    seen_days: set[str] = set()

    for step, moment in enumerate(timeline):
        bars_now = {
            symbol: index["at"][symbol].get(moment)
            for symbol in symbols
            if index["at"][symbol].get(moment) is not None
        }
        for symbol, bar in bars_now.items():
            last_close[symbol] = bar.close
        if step < warmup:
            continue

        day = trading_day(moment).isoformat()

        # 1. Exits first: a position freed this bar can fund an entry later in it.
        for symbol, position in list(positions.items()):
            bar = bars_now.get(symbol)
            if bar is None:
                continue
            reason, fill_price = _exit_trigger(position, bar, risk_config)
            if reason is None:
                continue
            equity = _equity(cash, positions, last_close)
            account = _account(equity, cash)
            assessment = risk.evaluate_exit(
                trade={
                    "symbol": symbol,
                    "quantity": position.quantity,
                    "opened_day": position.opened_day,
                },
                account=account,
                exit_reason=reason,
                as_of=day,
            )
            if not assessment.approved:
                rejections[assessment.reason] = rejections.get(assessment.reason, 0) + 1
                continue
            cash += _close_position(
                store, settings, position, fill_price, moment, day, reason
            )
            positions.pop(symbol, None)

        # 2. Mark to market once per bar, and snapshot equity once per day.
        equity = _equity(cash, positions, last_close)
        if day not in seen_days:
            seen_days.add(day)
            store.record_equity(
                {
                    "equity": equity,
                    "cash": cash,
                    "buying_power": cash,
                    "position_value": equity - cash,
                    "benchmark_price": last_close.get(settings.benchmark),
                    "trading_day": day,
                    "created_at": iso(moment),
                }
            )

        # 3. Entries, best conviction first.
        regime = _regime(benchmark_bars, index, moment, signal_config)
        candidates: list[tuple[FusedSignal, Bar]] = []
        for symbol, bar in bars_now.items():
            if symbol in positions:
                continue
            history = index["history"](symbol, moment)
            if len(history) < needed:
                continue
            signal = _signal(settings, symbol, history, store, regime)
            if signal is None or signal.action != "buy":
                if signal is not None:
                    rejections["no_actionable_signal"] = rejections.get("no_actionable_signal", 0) + 1
                continue
            candidates.append((signal, bar))

        candidates.sort(key=lambda item: item[0].confidence * abs(item[0].score), reverse=True)
        for signal, bar in candidates:
            equity = _equity(cash, positions, last_close)
            account = _account(equity, cash)
            open_positions = [
                Position(
                    symbol=p.symbol, quantity=p.quantity, avg_entry_price=p.entry_price,
                    market_value=p.quantity * last_close.get(p.symbol, p.entry_price),
                    current_price=last_close.get(p.symbol, p.entry_price),
                )
                for p in positions.values()
            ]
            half_spread = settings.costs.default_half_spread_bps
            limit_price = bar.close * (1 + half_spread * BPS)

            assessment = risk.evaluate_entry(
                symbol=signal.symbol,
                side="buy",
                reference_price=bar.close,
                limit_price=limit_price,
                confidence=signal.confidence,
                expected_move_bps=signal.expected_move_bps,
                account=account,
                positions=open_positions,
                half_spread_bps=half_spread,
                as_of=day,
            )
            decision_id = store.record_decision(
                {
                    "symbol": signal.symbol, "action": "buy", "session": "open",
                    "fused_score": signal.score, "confidence": signal.confidence,
                    "expected_move_bps": signal.expected_move_bps,
                    "reference_price": bar.close, "limit_price": limit_price,
                    "quantity": assessment.quantity, "signals": signal.as_dict(),
                    "ev": assessment.as_dict(), "approved": assessment.approved,
                    "reason": assessment.reason, "trading_day": day,
                    "created_at": iso(moment),
                }
            )
            if not assessment.approved:
                rejections[assessment.reason] = rejections.get(assessment.reason, 0) + 1
                continue

            # Fill at the clean close and charge execution cost separately: the
            # spread is a real cost and must show up in the fee total, not hide
            # inside the entry price where fee_to_pnl_ratio cannot see it.
            fill_price = bar.close
            quantity = assessment.quantity
            execution_cost = fill_price * quantity * (half_spread + settings.costs.slippage_bps) * BPS
            cost = fill_price * quantity + execution_cost
            if cost > cash:
                rejections["insufficient_cash"] = rejections.get("insufficient_cash", 0) + 1
                continue

            cash -= cost
            order_id = store.record_order(
                {
                    "symbol": signal.symbol, "side": "buy", "quantity": quantity,
                    "notional": cost, "limit_price": limit_price, "decision_id": decision_id,
                    "intent": "entry", "status": "filled", "filled_qty": quantity,
                    "filled_avg_price": fill_price, "trading_day": day,
                    "created_at": iso(moment),
                }
            )
            store.attach_order_to_decision(decision_id, order_id)
            trade_id = store.open_trade(
                {
                    "symbol": signal.symbol, "quantity": quantity, "entry_price": fill_price,
                    "entry_order_id": order_id, "decision_id": decision_id,
                    "signals": signal.as_dict(), "expected_move_bps": signal.expected_move_bps,
                    "opened_at": iso(moment), "opened_day": day,
                }
            )
            positions[signal.symbol] = OpenPosition(
                symbol=signal.symbol, quantity=quantity, entry_price=fill_price,
                opened_at=moment, opened_day=day, trade_id=trade_id, decision_id=decision_id,
                signal=signal.as_dict(), entry_execution_cost=execution_cost,
            )
            # One entry per bar, matching the live cycle.
            break

    # Close whatever is still open at the last price, so metrics are complete.
    final_moment = timeline[-1]
    final_day = trading_day(final_moment).isoformat()
    for symbol, position in list(positions.items()):
        price = last_close.get(symbol, position.entry_price)
        cash += _close_position(
            store, settings, position, price, final_moment, final_day, "end_of_backtest"
        )
        positions.pop(symbol, None)

    store.record_equity(
        {
            "equity": cash, "cash": cash, "position_value": 0.0,
            "benchmark_price": last_close.get(settings.benchmark),
            "trading_day": final_day, "created_at": iso(final_moment),
        }
    )

    metrics = compute_metrics(
        store, starting_equity=risk_config.starting_equity, benchmark=settings.benchmark
    )
    result = BacktestResult(
        metrics=metrics,
        trades=store.closed_trades(),
        rejections=rejections,
        bars_processed=len(timeline),
        symbols=sorted(symbols),
        start=iso(timeline[0]),
        end=iso(timeline[-1]),
        params=dict(params or {}),
        store=None if owned_store else store,
    )
    if owned_store:
        # Metrics are already computed; the in-memory database has served its purpose.
        store.close()
    return result


# -------------------------------------------------------------------- helpers
def _build_index(bars_by_symbol: Mapping[str, Sequence[Bar]]) -> dict[str, Any]:
    """Index bars by timestamp and expose a no-lookahead history accessor."""
    at: dict[str, dict[datetime, Bar]] = {}
    ordered: dict[str, list[Bar]] = {}
    stamps: set[datetime] = set()
    for symbol, bars in bars_by_symbol.items():
        series = sorted(bars, key=lambda bar: bar.timestamp)
        ordered[symbol] = series
        at[symbol] = {bar.timestamp: bar for bar in series}
        stamps.update(at[symbol])

    def history(symbol: str, moment: datetime) -> list[Bar]:
        series = ordered.get(symbol, [])
        cutoff = 0
        for index, bar in enumerate(series):
            if bar.timestamp > moment:
                break
            cutoff = index + 1
        return series[:cutoff]

    return {"timeline": sorted(stamps), "at": at, "ordered": ordered, "history": history}


def _signal(
    settings: Settings,
    symbol: str,
    history: Sequence[Bar],
    store: Store,
    regime: float | None,
) -> FusedSignal | None:
    config = settings.signals
    technical = technical_signals(
        history,
        fast_ma=config.fast_ma,
        slow_ma=config.slow_ma,
        rsi_period=config.rsi_period,
        rsi_oversold=config.rsi_oversold,
        rsi_overbought=config.rsi_overbought,
        momentum_period=config.momentum_period,
        volume_lookback=config.volume_lookback,
    )
    if not technical.scores:
        return None
    # Sentiment is intentionally absent: historical news sentiment is not
    # reproducible after the fact, and pretending otherwise would inflate the
    # backtest against what the live bot can actually know.
    return fuse_signals(
        symbol,
        technical,
        weights=store.weight_values(),
        sentiment=None,
        regime=regime,
        edge_scale_bps=config.edge_scale_bps,
        min_confidence=settings.risk.min_confidence,
    )


def _regime(
    benchmark_bars: Sequence[Bar], index: Mapping[str, Any], moment: datetime, config: Any
) -> float | None:
    if not benchmark_bars:
        return None
    history = [bar for bar in benchmark_bars if bar.timestamp <= moment]
    if len(history) < config.slow_ma + 1:
        return None
    return regime_score(history, config.fast_ma, config.slow_ma)


def _exit_trigger(position: OpenPosition, bar: Bar, risk_config: Any) -> tuple[str | None, float]:
    """Which exit (if any) this bar triggers, and at what price.

    When the bar's range covers both the stop and the target, the stop wins:
    assuming the good outcome is how a backtest flatters itself.
    """
    stop_price = position.entry_price * (1 - abs(risk_config.stop_loss_pct))
    target_price = position.entry_price * (1 + risk_config.take_profit_pct)

    if bar.low <= stop_price:
        return "stop_loss", stop_price
    if bar.high >= target_price:
        return "take_profit", target_price

    held_days = (bar.timestamp - position.opened_at).days
    if held_days >= risk_config.max_holding_days:
        return "time_stop", bar.close
    return None, 0.0


def _close_position(
    store: Store,
    settings: Settings,
    position: OpenPosition,
    price: float,
    moment: datetime,
    day: str,
    reason: str,
) -> float:
    """Book the exit and return the cash proceeds."""
    fill_price = price
    quantity = position.quantity
    execution_cost = (
        fill_price * quantity
        * (settings.costs.default_half_spread_bps + settings.costs.slippage_bps) * BPS
    )
    gross = (fill_price - position.entry_price) * quantity
    regulatory = realized_costs(
        entry_price=position.entry_price,
        exit_price=fill_price,
        quantity=quantity,
        config=settings.costs,
    ).total
    # Every cost in one number: commission, SEC/TAF, and the spread plus
    # slippage paid on both fills.
    fees = regulatory + position.entry_execution_cost + execution_cost
    net = gross - fees
    # Cash back = sale value minus the costs settled at the exit; the entry-side
    # execution cost was already deducted when the position was opened.
    proceeds = fill_price * quantity - execution_cost - regulatory

    decision_id = store.record_decision(
        {
            "symbol": position.symbol, "action": "sell", "session": "open", "approved": True,
            "reason": reason, "reference_price": price, "limit_price": fill_price,
            "quantity": quantity, "trading_day": day, "created_at": iso(moment),
            "signals": {"exit_reason": reason},
        }
    )
    order_id = store.record_order(
        {
            "symbol": position.symbol, "side": "sell", "quantity": quantity,
            "limit_price": fill_price, "decision_id": decision_id, "intent": "exit",
            "status": "filled", "filled_qty": quantity, "filled_avg_price": fill_price,
            "trade_id": position.trade_id, "trading_day": day, "created_at": iso(moment),
        }
    )
    store.attach_order_to_decision(decision_id, order_id)
    store.close_trade(
        position.trade_id,
        exit_price=fill_price,
        exit_order_id=order_id,
        gross_pnl=gross,
        fees=fees,
        net_pnl=net,
        return_pct=net / (position.entry_price * quantity) if quantity else 0.0,
        exit_reason=reason,
        closed_at=iso(moment),
        closed_day=day,
    )
    return proceeds


def _equity(
    cash: float, positions: Mapping[str, OpenPosition], last_close: Mapping[str, float]
) -> float:
    held = sum(
        position.quantity * last_close.get(symbol, position.entry_price)
        for symbol, position in positions.items()
    )
    return cash + held


def _account(equity: float, cash: float) -> AccountSnapshot:
    """A cash account: no leverage, no shorting - what a $30 pilot really is."""
    return AccountSnapshot(
        equity=equity,
        cash=cash,
        buying_power=cash,
        non_marginable_buying_power=cash,
        portfolio_value=equity,
        multiplier=1.0,
        shorting_enabled=False,
    )

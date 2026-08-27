"""TraderCore - signal fusion, order generation and execution.

One cycle does four things, in this order:

1. **Reconcile** open orders with the broker; fills become trades.
2. **Manage exits** on open positions (take profit, stop loss, time stop,
   signal reversal).
3. **Scan** the universe for entries and fuse the signals.
4. **Execute** whatever RiskSentinel approves, as a limit order.

Only limit orders are used. With $30 of capital a market order's slippage can
eat the entire edge, so the price we are willing to pay is always explicit.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from ..brokers.base import AccountSnapshot, Bar, BrokerError, OrderResult, Position, Quote
from ..clock import iso, parse_iso, trading_day, utcnow
from ..config import Settings
from ..costs import realized_costs
from ..db import Store
from ..logging_setup import get_logger
from ..signals import fuse_signals, technical_signals
from ..signals.combiner import FusedSignal, aggregate_sentiment
from ..marketdata import MarketData, MarketDataError
from ..marketdata.providers import AlpacaData
from ..signals.indicators import regime_score
from .risk_sentinel import RiskAssessment, RiskSentinel

log = get_logger(__name__)

# Marketable-limit cushion: cross the spread by this fraction of it to get
# filled, without paying an unbounded price.
LIMIT_CROSS_FRACTION = 0.6
# Orders that never filled are cancelled after this many cycles.
STALE_ORDER_MINUTES = 20.0
# The benchmark's daily trend barely moves intraday; refetching it per symbol
# would burn the rate limit for nothing.
REGIME_CACHE_SECONDS = 900.0


@dataclass(frozen=True)
class CycleReport:
    """What one trading cycle actually did."""

    session: str
    evaluated: int = 0
    entries_submitted: int = 0
    exits_submitted: int = 0
    fills: int = 0
    rejected: int = 0
    errors: int = 0
    notes: list[str] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "session": self.session,
            "evaluated": self.evaluated,
            "entries_submitted": self.entries_submitted,
            "exits_submitted": self.exits_submitted,
            "fills": self.fills,
            "rejected": self.rejected,
            "errors": self.errors,
            "notes": self.notes or [],
        }


class TraderCore:
    """Decides what to trade and places the orders."""

    def __init__(
        self,
        settings: Settings,
        store: Store,
        broker: Any,
        risk: RiskSentinel,
        *,
        news=None,
        data=None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.broker = broker
        self.risk = risk
        self.news = news
        # Prices may come from a different provider than the one we trade
        # through; orders and account state always come from the broker.
        if data is None:
            data = MarketData(AlpacaData(broker, feed=settings.alpaca_feed))
        self.data = data
        self._regime_cache: tuple[Any, float | None] = (None, None)
        self.store.ensure_weights(settings.signals.seed_weights)

    # ------------------------------------------------------------------ cycle
    def run_cycle(self) -> CycleReport:
        """Run one full trading cycle. Safe to call when the market is closed."""
        session = self.broker.session()
        notes: list[str] = []

        fills = self.sync_orders()

        if session != "open":
            # Outside regular hours we still reconcile, but never execute:
            # fractional orders are rejected off-session anyway.
            notes.append(f"no_execution_in_session:{session}")
            return CycleReport(session=session, fills=fills, notes=notes)

        account = self.broker.get_account()
        positions = self.broker.get_positions()
        self._snapshot_equity(account, positions)

        exits = self.manage_exits(account, positions)

        allowed, reason, _details = self.risk.check_trading_allowed(account, positions=positions)
        if not allowed:
            notes.append(f"entries_blocked:{reason}")
            log.info("entries_blocked", extra={"event": {"reason": reason}})
            return CycleReport(
                session=session, fills=fills, exits_submitted=exits, notes=notes
            )

        evaluated, submitted, rejected, errors = self.scan_for_entries(account, positions)
        return CycleReport(
            session=session,
            evaluated=evaluated,
            entries_submitted=submitted,
            exits_submitted=exits,
            fills=fills,
            rejected=rejected,
            errors=errors,
            notes=notes,
        )

    # ------------------------------------------------------------ reconcile
    def sync_orders(self) -> int:
        """Update local orders from the broker; turn fills into trades."""
        fills = 0
        for record in self.store.open_orders():
            broker_order_id = record.get("broker_order_id")
            if not broker_order_id:
                continue
            try:
                remote = self.broker.get_order(str(broker_order_id))
            except BrokerError as exc:
                log.warning(
                    "order_sync_failed",
                    extra={"event": {"order_id": record["id"], "error": str(exc)}},
                )
                continue
            if remote is None:
                continue

            self.store.update_order(
                int(record["id"]),
                status=remote.status,
                filled_qty=remote.filled_qty,
                filled_avg_price=remote.filled_avg_price,
                raw=remote.raw,
            )

            if remote.is_filled:
                fills += 1
                self._on_fill(record, remote)
            elif not remote.is_terminal:
                self._maybe_cancel_stale(record, remote)
        return fills

    def _settle_if_filled(self, order_id: int, result: OrderResult) -> None:
        """Book an order that came back already filled, without waiting a cycle."""
        if not result.is_filled:
            return
        record = self.store.get_order(order_id)
        if record is not None:
            self._on_fill(record, result)

    def _maybe_cancel_stale(self, record: Mapping[str, Any], remote: OrderResult) -> None:
        created = parse_iso(str(record.get("created_at")))
        if created is None:
            return
        age_minutes = (utcnow() - created).total_seconds() / 60.0
        if age_minutes < STALE_ORDER_MINUTES:
            return
        try:
            self.broker.cancel_order(remote.broker_order_id)
            self.store.update_order(int(record["id"]), status="canceled")
            self.store.record_event(
                "stale_order_canceled",
                f"{record['symbol']} unfilled after {age_minutes:.0f}m",
                symbol=record["symbol"],
                order_id=record["id"],
            )
        except BrokerError as exc:
            log.warning("cancel_failed", extra={"event": {"error": str(exc)}})

    def _on_fill(self, record: Mapping[str, Any], remote: OrderResult) -> None:
        """A fill either opens a trade or closes one."""
        intent = str(record.get("intent", "entry"))
        price = float(remote.filled_avg_price or record.get("limit_price") or 0.0)
        quantity = float(remote.filled_qty or record.get("quantity") or 0.0)
        if quantity <= 0 or price <= 0:
            return

        if intent == "entry":
            decision_id = record.get("decision_id")
            signals: dict[str, Any] = {}
            expected_move = None
            if decision_id:
                signals, expected_move = self.store.decision_signals(int(decision_id))
            trade_id = self.store.open_trade(
                {
                    "symbol": record["symbol"],
                    "quantity": quantity,
                    "entry_price": price,
                    "entry_order_id": record["id"],
                    "decision_id": decision_id,
                    "signals": signals,
                    "expected_move_bps": expected_move,
                    "opened_at": iso(remote.submitted_at or utcnow()),
                }
            )
            self.store.update_order(int(record["id"]), trade_id=trade_id)
            self.store.record_event(
                "trade_opened",
                f"{record['symbol']} {quantity} @ {price}",
                symbol=record["symbol"], trade_id=trade_id, price=price, quantity=quantity,
            )
            log.info(
                "trade_opened",
                extra={"event": {"symbol": record["symbol"], "qty": quantity, "price": price}},
            )
            return

        trade_id = record.get("trade_id")
        if not trade_id:
            return
        trade = self.store.get_trade(int(trade_id))
        if trade is None or trade.get("status") == "closed":
            return

        entry_price = float(trade["entry_price"])
        gross = (price - entry_price) * quantity
        fees = realized_costs(
            entry_price=entry_price, exit_price=price, quantity=quantity, config=self.settings.costs
        ).total
        net = gross - fees
        self.store.close_trade(
            int(trade_id),
            exit_price=price,
            exit_order_id=int(record["id"]),
            gross_pnl=gross,
            fees=fees,
            net_pnl=net,
            return_pct=(net / (entry_price * quantity)) if entry_price * quantity else 0.0,
            exit_reason=self._exit_reason_for(record),
            closed_at=iso(utcnow()),
        )
        self.store.record_event(
            "trade_closed",
            f"{record['symbol']} net {net:.4f}",
            symbol=record["symbol"], trade_id=trade_id, net_pnl=net, gross_pnl=gross, fees=fees,
        )
        log.info(
            "trade_closed",
            extra={"event": {
                "symbol": record["symbol"], "net_pnl": round(net, 4),
                "gross_pnl": round(gross, 4), "fees": round(fees, 4),
            }},
        )

    def _exit_reason_for(self, record: Mapping[str, Any]) -> str:
        """Why we exited, read back from the decision that ordered the exit.

        The order's ``raw`` column is overwritten with the broker payload on
        every sync, so the decision row is the durable record.
        """
        decision_id = record.get("decision_id")
        if decision_id:
            reason = self.store.decision_reason(int(decision_id))
            if reason:
                return reason
        return "exit"

    # ---------------------------------------------------------------- exits
    def manage_exits(
        self, account: AccountSnapshot, positions: Sequence[Position]
    ) -> int:
        """Close positions that hit their target, stop, time limit or reversal."""
        submitted = 0
        by_symbol = {p.symbol: p for p in positions}
        for trade in self.store.open_trades():
            symbol = str(trade["symbol"])
            position = by_symbol.get(symbol)
            if position is None or abs(position.quantity) <= 0:
                continue
            if self._has_open_exit(int(trade["id"])):
                continue

            price = position.current_price or self._price(symbol) or 0.0
            if price <= 0:
                continue
            reason = self._exit_reason(trade, price)
            if reason is None:
                continue

            assessment = self.risk.evaluate_exit(trade=trade, account=account, exit_reason=reason)
            if not assessment.approved:
                self.store.record_decision(
                    {
                        "symbol": symbol, "action": "sell", "session": "open",
                        "approved": False, "reason": assessment.reason,
                        "reference_price": price, "signals": {"exit_reason": reason},
                        "ev": assessment.details,
                    }
                )
                continue

            quantity = min(float(trade["quantity"]), abs(position.quantity))
            if self._submit_exit(trade, quantity=quantity, price=price, reason=reason):
                submitted += 1
        return submitted

    def _has_open_exit(self, trade_id: int) -> bool:
        return any(
            int(order.get("trade_id") or 0) == trade_id and order.get("intent") == "exit"
            for order in self.store.open_orders()
        )

    def _exit_reason(self, trade: Mapping[str, Any], price: float) -> str | None:
        entry = float(trade["entry_price"])
        if entry <= 0:
            return None
        change = (price - entry) / entry
        if change >= self.settings.risk.take_profit_pct:
            return "take_profit"
        if change <= -abs(self.settings.risk.stop_loss_pct):
            return "stop_loss"

        opened = parse_iso(str(trade.get("opened_at")))
        if opened is not None:
            held_days = (utcnow() - opened).days
            if held_days >= self.settings.risk.max_holding_days:
                return "time_stop"

        signal = self._signal_for(str(trade["symbol"]))
        if signal is not None and signal.action == "sell" and signal.confidence >= self.settings.risk.min_confidence:
            return "signal_reversal"
        return None

    def _submit_exit(
        self, trade: Mapping[str, Any], *, quantity: float, price: float, reason: str
    ) -> bool:
        symbol = str(trade["symbol"])
        quote = self._quote(symbol)
        limit_price = self._limit_price("sell", price, quote)
        decision_id = self.store.record_decision(
            {
                "symbol": symbol, "action": "sell", "session": "open", "approved": True,
                "reason": reason, "reference_price": price, "limit_price": limit_price,
                "quantity": quantity, "signals": {"exit_reason": reason},
            }
        )
        order_id = self.store.record_order(
            {
                "symbol": symbol, "side": "sell", "quantity": quantity,
                "limit_price": limit_price, "decision_id": decision_id, "intent": "exit",
                "trade_id": int(trade["id"]), "status": "pending_new",
                "raw": {"exit_reason": reason},
            }
        )
        self.store.attach_order_to_decision(decision_id, order_id)

        if self.settings.dry_run:
            self.store.update_order(order_id, status="canceled")
            log.info("dry_run_exit", extra={"event": {"symbol": symbol, "reason": reason}})
            return True
        try:
            result = self.broker.submit_limit_order(
                symbol, "sell", quantity=quantity, limit_price=limit_price,
                client_order_id=f"exit-{uuid.uuid4().hex[:16]}",
            )
        except BrokerError as exc:
            self.store.update_order(order_id, status="rejected")
            self.store.record_event("exit_order_failed", str(exc), severity="error", symbol=symbol)
            log.error("exit_order_failed", extra={"event": {"symbol": symbol, "error": str(exc)}})
            return False
        self.store.update_order(
            order_id, broker_order_id=result.broker_order_id, status=result.status, raw=result.raw
        )
        self._settle_if_filled(order_id, result)
        log.info(
            "exit_submitted",
            extra={"event": {"symbol": symbol, "qty": quantity, "limit": limit_price, "reason": reason}},
        )
        return True

    # --------------------------------------------------------------- entries
    def scan_for_entries(
        self, account: AccountSnapshot, positions: Sequence[Position]
    ) -> tuple[int, int, int, int]:
        """Evaluate the universe and submit approved entries.

        Returns ``(evaluated, submitted, rejected, errors)``.
        """
        evaluated = submitted = rejected = errors = 0
        held = {p.symbol for p in positions if abs(p.quantity) > 0}
        regime = self._regime()

        candidates: list[tuple[FusedSignal, float, Quote | None]] = []
        for symbol in self.settings.universe:
            if symbol in held:
                continue
            try:
                signal = self._signal_for(symbol, regime=regime)
                if signal is None:
                    continue
                evaluated += 1
                price = self._price(symbol)
                if not price or price <= 0:
                    continue
                candidates.append((signal, price, self._quote(symbol)))
            except (BrokerError, MarketDataError) as exc:
                errors += 1
                log.warning("signal_failed", extra={"event": {"symbol": symbol, "error": str(exc)}})

        # Best conviction first: with one or two slots, order matters.
        candidates.sort(key=lambda item: item[0].confidence * abs(item[0].score), reverse=True)

        for signal, price, quote in candidates:
            if signal.action != "buy":
                self._record_rejection(signal, price, "no_actionable_signal")
                continue

            limit_price = self._limit_price("buy", price, quote)
            half_spread = quote.half_spread_bps if quote else None
            if half_spread != half_spread:  # NaN guard
                half_spread = None

            assessment = self.risk.evaluate_entry(
                symbol=signal.symbol,
                side="buy",
                reference_price=price,
                limit_price=limit_price,
                confidence=signal.confidence,
                expected_move_bps=signal.expected_move_bps,
                account=account,
                positions=positions,
                half_spread_bps=half_spread,
            )
            if not assessment.approved:
                rejected += 1
                self._record_rejection(signal, price, assessment.reason, assessment=assessment)
                continue

            if self._submit_entry(signal, price, assessment):
                submitted += 1
                # One entry per cycle keeps sizing honest: the next candidate is
                # re-sized against the equity and cash left after this fill.
                break
        return evaluated, submitted, rejected, errors

    def _submit_entry(
        self, signal: FusedSignal, price: float, assessment: RiskAssessment
    ) -> bool:
        symbol = signal.symbol
        decision_id = self.store.record_decision(
            {
                "symbol": symbol,
                "action": "buy",
                "session": "open",
                "fused_score": signal.score,
                "confidence": signal.confidence,
                "expected_move_bps": signal.expected_move_bps,
                "reference_price": price,
                "limit_price": assessment.limit_price,
                "quantity": assessment.quantity,
                "signals": signal.as_dict(),
                "ev": assessment.as_dict(),
                "approved": True,
                "reason": "approved",
            }
        )
        order_id = self.store.record_order(
            {
                "symbol": symbol, "side": "buy", "quantity": assessment.quantity,
                "notional": assessment.notional, "limit_price": assessment.limit_price,
                "decision_id": decision_id, "intent": "entry", "status": "pending_new",
            }
        )
        self.store.attach_order_to_decision(decision_id, order_id)

        if self.settings.dry_run:
            self.store.update_order(order_id, status="canceled")
            log.info(
                "dry_run_entry",
                extra={"event": {"symbol": symbol, "qty": assessment.quantity,
                                 "limit": assessment.limit_price}},
            )
            return True

        try:
            result = self.broker.submit_limit_order(
                symbol, "buy",
                quantity=assessment.quantity,
                limit_price=float(assessment.limit_price or price),
                client_order_id=f"entry-{uuid.uuid4().hex[:16]}",
            )
        except BrokerError as exc:
            self.store.update_order(order_id, status="rejected")
            self.store.record_event("entry_order_failed", str(exc), severity="error", symbol=symbol)
            log.error("entry_order_failed", extra={"event": {"symbol": symbol, "error": str(exc)}})
            return False

        self.store.update_order(
            order_id, broker_order_id=result.broker_order_id, status=result.status, raw=result.raw
        )
        self._settle_if_filled(order_id, result)
        log.info(
            "entry_submitted",
            extra={"event": {
                "symbol": symbol, "qty": assessment.quantity, "limit": assessment.limit_price,
                "net_ev": assessment.ev.net_ev if assessment.ev else None,
                "confidence": signal.confidence,
            }},
        )
        return True

    def _record_rejection(
        self,
        signal: FusedSignal,
        price: float,
        reason: str,
        *,
        assessment: RiskAssessment | None = None,
    ) -> None:
        """Every rejection is logged too - the reasons are the experiment's data."""
        self.store.record_decision(
            {
                "symbol": signal.symbol,
                "action": signal.action,
                "session": "open",
                "fused_score": signal.score,
                "confidence": signal.confidence,
                "expected_move_bps": signal.expected_move_bps,
                "reference_price": price,
                "signals": signal.as_dict(),
                "ev": assessment.as_dict() if assessment else {},
                "approved": False,
                "reason": reason,
            }
        )

    # --------------------------------------------------------------- signals
    def _signal_for(self, symbol: str, *, regime: float | None = None) -> FusedSignal | None:
        config = self.settings.signals
        bars = self._bars(symbol, limit=config.bars_lookback)
        if len(bars) < max(config.slow_ma, config.rsi_period) + 2:
            return None
        technical = technical_signals(
            bars,
            fast_ma=config.fast_ma,
            slow_ma=config.slow_ma,
            rsi_period=config.rsi_period,
            rsi_oversold=config.rsi_oversold,
            rsi_overbought=config.rsi_overbought,
            momentum_period=config.momentum_period,
            volume_lookback=config.volume_lookback,
        )
        sentiment, sentiment_context = aggregate_sentiment(
            self.store.recent_sentiment(symbol, hours=24.0),
            half_life_hours=config.sentiment_half_life_hours,
        )
        return fuse_signals(
            symbol,
            technical,
            weights=self.store.weight_values(),
            sentiment=sentiment,
            regime=self._regime() if regime is None else regime,
            edge_scale_bps=config.edge_scale_bps,
            min_confidence=self.settings.risk.min_confidence,
            extra_context={"sentiment": sentiment_context},
        )

    def _regime(self) -> float | None:
        """Market regime from the benchmark's daily trend, cached per cycle."""
        now = utcnow()
        cached_at, cached_value = self._regime_cache
        if cached_at is not None and (now - cached_at).total_seconds() < REGIME_CACHE_SECONDS:
            return cached_value
        try:
            bars = self._bars(self.settings.benchmark, limit=60, timeframe="1Day")
        except (BrokerError, MarketDataError):
            return cached_value
        value = regime_score(bars, self.settings.signals.fast_ma, self.settings.signals.slow_ma)
        self._regime_cache = (now, value)
        return value

    # ---------------------------------------------------------------- pricing
    def _bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        return self.data.get_bars(symbol, limit=limit, timeframe=timeframe)

    def _price(self, symbol: str) -> float | None:
        try:
            return self.data.get_latest_price(symbol)
        except (BrokerError, MarketDataError):
            return None

    def _quote(self, symbol: str) -> Quote | None:
        """A real-time quote, or ``None`` when the feed cannot supply one.

        ``None`` is not a failure: it makes ``_limit_price`` and the net-EV check
        fall back to the conservative default half-spread rather than trust a
        stale bid/ask.
        """
        try:
            return self.data.get_latest_quote(symbol)
        except (BrokerError, MarketDataError):
            return None

    def _limit_price(self, side: str, reference_price: float, quote: Quote | None) -> float:
        """A marketable limit: cross part of the spread, never chase past it."""
        if quote is not None and quote.bid > 0 and quote.ask > 0:
            mid = quote.mid
            half = (quote.ask - quote.bid) / 2
            price = (
                mid + half * LIMIT_CROSS_FRACTION
                if side == "buy"
                else mid - half * LIMIT_CROSS_FRACTION
            )
            price = min(price, quote.ask) if side == "buy" else max(price, quote.bid)
        else:
            cushion = self.settings.costs.default_half_spread_bps * 1e-4
            price = reference_price * (1 + cushion) if side == "buy" else reference_price * (1 - cushion)
        return round(max(price, 0.01), 2)

    # -------------------------------------------------------------- portfolio
    def _snapshot_equity(self, account: AccountSnapshot, positions: Sequence[Position]) -> None:
        benchmark_price = self._price(self.settings.benchmark)
        self.store.record_equity(
            {
                "equity": account.equity,
                "cash": account.cash,
                "buying_power": account.buying_power,
                "position_value": sum(p.market_value for p in positions),
                "benchmark_price": benchmark_price,
                "trading_day": trading_day().isoformat(),
            }
        )

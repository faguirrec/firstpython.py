"""RiskSentinel - the agent with veto power.

Nothing reaches the broker without passing through here. It answers three
questions, in order:

1. **Is trading allowed at all right now?** Kill switch, daily loss limit,
   drawdown limit, trade count, broker-side blocks.
2. **How big may this position be?** A share of equity, scaled by confidence,
   floored at Alpaca's $1 fractional minimum and capped by *settled* cash.
3. **Is the trade worth doing after costs?** Net expected value, via
   :mod:`trading_bot.costs`.

It also enforces the two regulatory constraints that bite a $30 account: the
FINRA pattern-day-trader rule (3 day trades per rolling 5 business days below
$25k of equity on a margin account) and T+1 cash settlement on a cash account.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from ..brokers.base import AccountSnapshot, Position
from ..clock import iso, trading_day, utcnow
from ..config import Settings
from ..costs import NetExpectedValue, baseline_hit_probability, evaluate_net_ev, hit_probability
from ..db import Store
from ..logging_setup import get_logger

log = get_logger(__name__)

KILL_SWITCH_KEY = "kill_switch"
# Trades of evidence needed before the measured hit rate outweighs the prior.
PROBABILITY_PRIOR_WEIGHT = 20
# Sentinel for "PDT does not apply here"; kept finite so callers can compare.
UNLIMITED_DAY_TRADES = 999
PEAK_EQUITY_KEY = "peak_equity"


@dataclass(frozen=True)
class RiskAssessment:
    """Verdict on one candidate trade."""

    approved: bool
    reason: str
    symbol: str
    side: str
    quantity: float = 0.0
    limit_price: float | None = None
    notional: float = 0.0
    ev: NetExpectedValue | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "reason": self.reason,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": round(self.quantity, 6),
            "limit_price": self.limit_price,
            "notional": round(self.notional, 4),
            "ev": self.ev.as_dict() if self.ev else None,
            "details": self.details,
        }


@dataclass(frozen=True)
class AccountPosture:
    """How the account's own rules constrain trading today."""

    is_cash_account: bool
    equity: float
    settled_cash: float
    day_trades_used: int
    day_trades_remaining: int
    pdt_restricted: bool
    blocked: bool
    block_reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "account_type": "cash" if self.is_cash_account else "margin",
            "equity": round(self.equity, 2),
            "settled_cash": round(self.settled_cash, 2),
            "day_trades_used": self.day_trades_used,
            "day_trades_remaining": self.day_trades_remaining,
            "pdt_restricted": self.pdt_restricted,
            "blocked": self.blocked,
            "block_reason": self.block_reason,
        }


class RiskSentinel:
    """Position sizing, hard limits, cost viability and regulatory rules."""

    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.risk = settings.risk
        self.costs = settings.costs
        self.store = store

    # ------------------------------------------------------------- kill switch
    def kill_switch_active(self) -> bool:
        state = self.store.get_state(KILL_SWITCH_KEY) or {}
        return bool(state.get("active"))

    def kill_switch_reason(self) -> str:
        state = self.store.get_state(KILL_SWITCH_KEY) or {}
        return str(state.get("reason", ""))

    def engage_kill_switch(self, reason: str, **payload: Any) -> None:
        """Stop all new trading until a human clears it."""
        self.store.set_state(
            KILL_SWITCH_KEY, {"active": True, "reason": reason, "since": iso(), **payload}
        )
        self.store.record_event("kill_switch_engaged", reason, severity="critical", **payload)
        log.critical("kill_switch_engaged", extra={"event": {"reason": reason, **payload}})

    def release_kill_switch(self, note: str = "manual release") -> None:
        self.store.set_state(KILL_SWITCH_KEY, {"active": False, "reason": note, "since": iso()})
        self.store.record_event("kill_switch_released", note, severity="warning")

    # ------------------------------------------------------------ account state
    def account_posture(
        self, account: AccountSnapshot, *, as_of: str | None = None
    ) -> AccountPosture:
        """Translate the broker account into the constraints we must respect.

        ``as_of`` is the trading day being evaluated; it defaults to today and is
        set explicitly when replaying history.
        """
        blocked = account.trading_blocked or account.account_blocked
        block_reason = ""
        if account.account_blocked:
            block_reason = "account_blocked"
        elif account.trading_blocked:
            block_reason = "trading_blocked"

        # PDT applies to margin accounts below the equity threshold, and to any
        # account the broker has already flagged as a pattern day trader.
        under_threshold = account.equity < self.risk.pdt_equity_threshold
        pdt_restricted = (
            account.pattern_day_trader or not account.is_cash_account
        ) and under_threshold

        # Trust the broker's count when it has one; our own tally is the floor.
        local_count = self.store.day_trades_in_window(as_of=as_of)
        used = max(account.daytrade_count, local_count)
        if pdt_restricted:
            allowance = self.risk.max_day_trades_window - self.risk.day_trade_safety_buffer
            remaining = max(allowance - used, 0)
        else:
            # Neither a cash account (settlement-constrained, not day-trade
            # capped) nor a margin account above $25k is limited by PDT.
            remaining = UNLIMITED_DAY_TRADES

        return AccountPosture(
            is_cash_account=account.is_cash_account,
            equity=account.equity,
            settled_cash=account.settled_cash_available,
            day_trades_used=used,
            day_trades_remaining=remaining,
            pdt_restricted=pdt_restricted,
            blocked=blocked,
            block_reason=block_reason,
        )

    # ------------------------------------------------------------ global limits
    def daily_loss_state(
        self, account: AccountSnapshot, *, as_of: str | None = None
    ) -> dict[str, Any]:
        """The day's P&L against the daily loss limit."""
        start = self.store.first_equity_of_day(as_of)
        start_equity = float(start["equity"]) if start else account.equity
        change = account.equity - start_equity
        limit = -abs(self.risk.max_daily_loss_pct) * start_equity if start_equity > 0 else 0.0
        return {
            "start_equity": round(start_equity, 4),
            "current_equity": round(account.equity, 4),
            "day_pnl": round(change, 4),
            "day_pnl_pct": round(change / start_equity, 6) if start_equity else 0.0,
            "limit_usd": round(limit, 4),
            "breached": change <= limit and start_equity > 0,
        }

    def drawdown_state(self, account: AccountSnapshot) -> dict[str, Any]:
        """Current drawdown from the equity peak seen during the experiment."""
        stored_peak = float(self.store.get_state(PEAK_EQUITY_KEY) or 0.0)
        observed_peak = self.store.peak_equity() or 0.0
        peak = max(stored_peak, observed_peak, account.equity, self.risk.starting_equity)
        if peak > stored_peak:
            self.store.set_state(PEAK_EQUITY_KEY, peak)
        drawdown = (account.equity - peak) / peak if peak > 0 else 0.0
        return {
            "peak_equity": round(peak, 4),
            "current_equity": round(account.equity, 4),
            "drawdown_pct": round(drawdown, 6),
            "limit_pct": -abs(self.risk.max_drawdown_pct),
            "breached": drawdown <= -abs(self.risk.max_drawdown_pct),
        }

    def check_trading_allowed(
        self,
        account: AccountSnapshot,
        *,
        positions: Sequence[Position] = (),
        as_of: str | None = None,
        engage_on_breach: bool = True,
    ) -> tuple[bool, str, dict[str, Any]]:
        """Gate applied before any new entry is even considered.

        ``engage_on_breach=False`` makes this purely read-only, for the status
        command and the health endpoint: showing the state should never change it.
        """
        posture = self.account_posture(account, as_of=as_of)
        daily = self.daily_loss_state(account, as_of=as_of)
        drawdown = self.drawdown_state(account)
        details: dict[str, Any] = {
            "posture": posture.as_dict(),
            "daily_loss": daily,
            "drawdown": drawdown,
        }

        if self.kill_switch_active():
            return False, f"kill_switch:{self.kill_switch_reason()}", details
        if posture.blocked:
            return False, posture.block_reason, details
        if drawdown["breached"]:
            # A drawdown breach ends the experiment; it must not silently resume.
            if engage_on_breach:
                self.engage_kill_switch("max_drawdown_breached", **drawdown)
            return False, "max_drawdown_breached", details
        if daily["breached"]:
            return False, "daily_loss_limit_reached", details

        trades_today = self.store.count_entries_today(as_of)
        details["trades_today"] = trades_today
        if trades_today >= self.risk.max_trades_per_day:
            return False, "max_trades_per_day_reached", details

        # A working order is exposure in waiting: counting only filled positions
        # would let one symbol be bought again on every cycle until it fills.
        pending = self.store.symbols_with_live_orders()
        held = {p.symbol.upper() for p in positions if abs(p.quantity) > 0}
        open_count = len(held | pending)
        details["open_positions"] = len(held)
        details["pending_orders"] = sorted(pending)
        if open_count >= self.risk.max_open_positions:
            return False, "max_open_positions_reached", details

        return True, "ok", details

    # ------------------------------------------------------------------- sizing
    def max_position_notional(self, account: AccountSnapshot) -> float:
        """Dollar cap for one position: equity share, capped by settled cash."""
        posture = self.account_posture(account)
        by_equity = account.equity * self.risk.max_position_pct
        return max(min(by_equity, posture.settled_cash), 0.0)

    def size_position(
        self, account: AccountSnapshot, *, confidence: float, reference_price: float
    ) -> tuple[float, float, str]:
        """Return ``(quantity, notional, reason)`` for a candidate entry.

        Sizing is linear in confidence between ``min_confidence`` and 1.0, so a
        marginal signal gets a marginal position.
        """
        if reference_price <= 0:
            return 0.0, 0.0, "invalid_price"

        cap = self.max_position_notional(account)
        if cap < self.risk.min_position_notional:
            return 0.0, 0.0, "insufficient_settled_cash"

        floor_conf = self.risk.min_confidence
        span = max(1.0 - floor_conf, 1e-9)
        scale = min(max((confidence - floor_conf) / span, 0.0), 1.0)
        # Never size below the broker minimum: a $0.40 order is simply rejected.
        notional = max(cap * (0.5 + 0.5 * scale), self.risk.min_position_notional)
        notional = min(notional, cap)

        quantity = round(notional / reference_price, 6)
        if quantity <= 0:
            return 0.0, 0.0, "quantity_rounds_to_zero"
        return quantity, quantity * reference_price, "ok"

    # ----------------------------------------------------------- probability
    def entry_probability(self, confidence: float) -> tuple[float, dict[str, Any]]:
        """The hit probability to price this trade with.

        Starts from a confidence-scaled prior and shifts toward the **measured**
        hit rate as closed trades accumulate. The property that matters: if the
        strategy's realized hit rate turns out to be below the no-edge baseline,
        the expected value goes negative and the bot stops trading on its own,
        without anyone having to notice and intervene.
        """
        win_pct = self.risk.take_profit_pct
        loss_pct = self.risk.stop_loss_pct
        baseline = baseline_hit_probability(win_pct, loss_pct)
        prior = hit_probability(
            confidence,
            take_profit_pct=win_pct,
            stop_loss_pct=loss_pct,
            edge_cap=self.risk.confidence_edge_cap,
        )

        wins, total = self.store.realized_hit_rate()
        if total <= 0:
            return prior, {
                "source": "prior",
                "baseline": round(baseline, 4),
                "prior": round(prior, 4),
                "samples": 0,
            }

        measured = wins / total
        weight = total / (total + PROBABILITY_PRIOR_WEIGHT)
        blended = prior * (1 - weight) + measured * weight
        return blended, {
            "source": "blended",
            "baseline": round(baseline, 4),
            "prior": round(prior, 4),
            "measured": round(measured, 4),
            "samples": total,
            "weight_on_measured": round(weight, 4),
            "blended": round(blended, 4),
        }

    # ----------------------------------------------------------------- entries
    def evaluate_entry(
        self,
        *,
        symbol: str,
        side: str,
        reference_price: float,
        limit_price: float,
        confidence: float,
        expected_move_bps: float,
        account: AccountSnapshot,
        positions: Sequence[Position] = (),
        half_spread_bps: float | None = None,
        as_of: str | None = None,
    ) -> RiskAssessment:
        """Full go/no-go for opening a position."""
        allowed, reason, details = self.check_trading_allowed(
            account, positions=positions, as_of=as_of
        )
        if not allowed:
            return RiskAssessment(False, reason, symbol, side, details=details)

        if side == "sell" and not account.shorting_enabled:
            # With $30 and a cash-like account, shorting is off the table.
            return RiskAssessment(False, "shorting_not_enabled", symbol, side, details=details)

        if any(p.symbol == symbol.upper() and abs(p.quantity) > 0 for p in positions):
            return RiskAssessment(False, "position_already_open", symbol, side, details=details)

        # Same symbol, order still working: buying again would stack the position
        # past the per-position cap without either check noticing.
        if symbol.upper() in self.store.symbols_with_live_orders():
            return RiskAssessment(False, "order_already_working", symbol, side, details=details)

        if confidence < self.risk.min_confidence:
            details["confidence"] = confidence
            return RiskAssessment(False, "confidence_below_minimum", symbol, side, details=details)

        quantity, notional, sizing_reason = self.size_position(
            account, confidence=confidence, reference_price=reference_price
        )
        details["sizing"] = {
            "quantity": quantity,
            "notional": round(notional, 4),
            "cap": round(self.max_position_notional(account), 4),
            "reason": sizing_reason,
        }
        if quantity <= 0:
            return RiskAssessment(False, sizing_reason, symbol, side, details=details)

        probability, probability_detail = self.entry_probability(confidence)
        details["probability"] = probability_detail
        ev = evaluate_net_ev(
            symbol=symbol,
            side=side,
            quantity=quantity,
            entry_price=limit_price or reference_price,
            expected_move_bps=expected_move_bps,
            confidence=confidence,
            config=self.costs,
            half_spread_bps=half_spread_bps,
            min_net_ev_usd=self.risk.min_net_ev_usd,
            min_net_ev_bps=self.risk.min_net_ev_bps,
            # The payoff comes from the exit levels this trade will actually use.
            take_profit_pct=self.risk.take_profit_pct,
            stop_loss_pct=self.risk.stop_loss_pct,
            confidence_edge_cap=self.risk.confidence_edge_cap,
            probability=probability,
        )
        if not ev.approved:
            return RiskAssessment(
                False, ev.reason, symbol, side, quantity=quantity, limit_price=limit_price,
                notional=notional, ev=ev, details=details,
            )

        # An entry we could not exit today without breaking PDT is still fine -
        # it just means the position may have to be held overnight. Record it.
        posture = self.account_posture(account, as_of=as_of)
        details["can_close_same_day"] = posture.day_trades_remaining > 0

        return RiskAssessment(
            True, "approved", symbol, side, quantity=quantity, limit_price=limit_price,
            notional=notional, ev=ev, details=details,
        )

    # ------------------------------------------------------------------- exits
    def evaluate_exit(
        self,
        *,
        trade: Mapping[str, Any],
        account: AccountSnapshot,
        exit_reason: str,
        as_of: str | None = None,
    ) -> RiskAssessment:
        """Exits are permitted by default; only PDT can defer a same-day close.

        Risk-driven exits (stop loss, kill switch, drawdown) are never deferred:
        holding a loser overnight to protect a day-trade count is the worse risk.
        """
        symbol = str(trade.get("symbol", "")).upper()
        quantity = float(trade.get("quantity", 0.0) or 0.0)
        posture = self.account_posture(account, as_of=as_of)
        details: dict[str, Any] = {"posture": posture.as_dict(), "exit_reason": exit_reason}

        if quantity <= 0:
            return RiskAssessment(False, "nothing_to_exit", symbol, "sell", details=details)

        opened_day = str(trade.get("opened_day") or "")
        would_be_day_trade = opened_day == (as_of or trading_day().isoformat())
        details["would_be_day_trade"] = would_be_day_trade

        urgent = exit_reason in {"stop_loss", "kill_switch", "drawdown", "daily_loss_limit", "manual"}
        if would_be_day_trade and posture.pdt_restricted and posture.day_trades_remaining <= 0:
            if not urgent:
                return RiskAssessment(
                    False, "pdt_limit_defer_exit", symbol, "sell", quantity=quantity, details=details
                )
            details["pdt_override"] = "risk_exit_takes_priority"

        return RiskAssessment(
            True, "approved", symbol, "sell", quantity=quantity, details=details
        )

    # --------------------------------------------------------------- reporting
    def snapshot(self, account: AccountSnapshot, positions: Sequence[Position] = ()) -> dict[str, Any]:
        """A read-only view of every limit and where we stand against it."""
        allowed, reason, details = self.check_trading_allowed(
            account, positions=positions, engage_on_breach=False
        )
        return {
            "checked_at": iso(utcnow()),
            "trading_allowed": allowed,
            "reason": reason,
            "kill_switch": self.store.get_state(KILL_SWITCH_KEY) or {"active": False},
            **details,
        }

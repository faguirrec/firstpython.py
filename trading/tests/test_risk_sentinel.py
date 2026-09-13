"""Risk-rule tests: sizing, hard limits, PDT and cash settlement."""

from __future__ import annotations

import pytest

from conftest import FakeBroker
from trading_bot.agents.risk_sentinel import RiskSentinel
from trading_bot.clock import trading_day
from trading_bot.config import RiskConfig, Settings
from trading_bot.db import Store


@pytest.fixture()
def risk(settings: Settings, store: Store) -> RiskSentinel:
    return RiskSentinel(settings, store)


def account(**kwargs):
    return FakeBroker(**kwargs).get_account()


# ------------------------------------------------------------------- sizing
def test_position_is_capped_by_the_equity_share(risk: RiskSentinel):
    snapshot = account(equity=30.0, cash=30.0)
    cap = risk.max_position_notional(snapshot)
    assert cap == pytest.approx(30.0 * risk.risk.max_position_pct)


def test_position_is_capped_by_settled_cash_not_just_equity(risk: RiskSentinel):
    # Equity includes an unsettled position; only $2 is actually usable.
    snapshot = account(equity=30.0, cash=2.0)
    assert risk.max_position_notional(snapshot) == pytest.approx(2.0)


def test_sizing_scales_with_confidence(risk: RiskSentinel):
    snapshot = account(equity=30.0, cash=30.0)
    weak_qty, weak_notional, _ = risk.size_position(snapshot, confidence=0.4, reference_price=100.0)
    strong_qty, strong_notional, _ = risk.size_position(snapshot, confidence=0.95, reference_price=100.0)
    assert strong_notional > weak_notional
    assert strong_qty > weak_qty
    assert strong_notional <= risk.max_position_notional(snapshot) + 1e-9


def test_sizing_respects_the_fractional_minimum(risk: RiskSentinel):
    # Equity share is $1.02 here, just above Alpaca's $1 fractional floor.
    snapshot = account(equity=3.0, cash=3.0)
    quantity, notional, reason = risk.size_position(snapshot, confidence=0.4, reference_price=100.0)
    assert reason == "ok"
    assert notional >= risk.risk.min_position_notional

    broke = account(equity=0.5, cash=0.5)
    quantity, notional, reason = risk.size_position(broke, confidence=0.9, reference_price=100.0)
    assert quantity == 0.0
    assert reason == "insufficient_settled_cash"


def test_sizing_rejects_invalid_prices(risk: RiskSentinel):
    assert risk.size_position(account(), confidence=0.9, reference_price=0.0)[2] == "invalid_price"


# ------------------------------------------------------------ global limits
def test_kill_switch_blocks_everything(risk: RiskSentinel):
    risk.engage_kill_switch("manual test")
    allowed, reason, _ = risk.check_trading_allowed(account())
    assert allowed is False
    assert reason.startswith("kill_switch")

    risk.release_kill_switch()
    assert risk.check_trading_allowed(account())[0] is True


def test_daily_loss_limit_stops_trading(risk: RiskSentinel, store: Store):
    store.record_equity({"equity": 30.0})
    # -8% on the day, past the 6% limit.
    allowed, reason, details = risk.check_trading_allowed(account(equity=27.6, cash=27.6))
    assert allowed is False
    assert reason == "daily_loss_limit_reached"
    assert details["daily_loss"]["breached"] is True


def test_drawdown_breach_engages_the_kill_switch(risk: RiskSentinel, store: Store):
    store.record_equity({"equity": 40.0})
    allowed, reason, _ = risk.check_trading_allowed(account(equity=30.0, cash=30.0))
    assert allowed is False
    assert reason == "max_drawdown_breached"
    # The breach must persist: it ends the experiment rather than pausing it.
    assert risk.kill_switch_active() is True


def test_max_trades_per_day_is_enforced(settings: Settings, store: Store):
    tight = Settings(**{**settings.__dict__, "risk": RiskConfig(max_trades_per_day=1)})
    risk = RiskSentinel(tight, store)
    store.record_order(
        {"symbol": "AAPL", "side": "buy", "quantity": 0.1, "status": "filled",
         "intent": "entry", "trading_day": trading_day().isoformat()}
    )
    allowed, reason, _ = risk.check_trading_allowed(account())
    assert allowed is False
    assert reason == "max_trades_per_day_reached"


def test_closing_a_position_does_not_use_up_the_daily_trade_budget(settings, store):
    tight = Settings(**{**settings.__dict__, "risk": RiskConfig(max_trades_per_day=1)})
    risk = RiskSentinel(tight, store)
    store.record_order(
        {"symbol": "AAPL", "side": "sell", "quantity": 0.1, "status": "filled",
         "intent": "exit", "trading_day": trading_day().isoformat()}
    )
    assert risk.check_trading_allowed(account())[0] is True


def test_max_open_positions_is_enforced(settings: Settings, store: Store):
    tight = Settings(**{**settings.__dict__, "risk": RiskConfig(max_open_positions=1)})
    risk = RiskSentinel(tight, store)
    broker = FakeBroker()
    broker.set_position("AAPL", 0.1, 100.0, 101.0)
    allowed, reason, _ = risk.check_trading_allowed(
        broker.get_account(), positions=broker.get_positions()
    )
    assert allowed is False
    assert reason == "max_open_positions_reached"


def test_blocked_account_is_refused(risk: RiskSentinel):
    snapshot = account()
    blocked = type(snapshot)(**{**snapshot.__dict__, "trading_blocked": True})
    allowed, reason, _ = risk.check_trading_allowed(blocked)
    assert allowed is False
    assert reason == "trading_blocked"


# ---------------------------------------------------------------- PDT rules
def test_margin_account_under_25k_is_pdt_restricted(risk: RiskSentinel):
    posture = risk.account_posture(account(equity=30.0, multiplier=2.0))
    assert posture.pdt_restricted is True
    # 3 allowed minus the safety buffer of 1.
    assert posture.day_trades_remaining == 2


def test_pdt_allowance_shrinks_with_broker_day_trade_count(risk: RiskSentinel):
    posture = risk.account_posture(account(equity=30.0, multiplier=2.0, daytrade_count=2))
    assert posture.day_trades_remaining == 0


def test_cash_account_is_not_pdt_restricted_but_needs_settled_cash(risk: RiskSentinel):
    posture = risk.account_posture(account(equity=30.0, cash=5.0, multiplier=1.0))
    assert posture.is_cash_account is True
    assert posture.pdt_restricted is False
    assert posture.settled_cash == pytest.approx(5.0)


def test_large_margin_account_is_exempt_from_pdt(risk: RiskSentinel):
    posture = risk.account_posture(account(equity=30_000.0, cash=30_000.0, multiplier=4.0))
    assert posture.pdt_restricted is False
    assert posture.day_trades_remaining > 3


def test_pdt_defers_a_discretionary_same_day_exit(risk: RiskSentinel):
    trade = {"symbol": "AAPL", "quantity": 0.1, "opened_day": trading_day().isoformat()}
    snapshot = account(equity=30.0, multiplier=2.0, daytrade_count=3)
    assessment = risk.evaluate_exit(trade=trade, account=snapshot, exit_reason="take_profit")
    assert assessment.approved is False
    assert assessment.reason == "pdt_limit_defer_exit"


def test_stop_loss_overrides_the_pdt_deferral(risk: RiskSentinel):
    trade = {"symbol": "AAPL", "quantity": 0.1, "opened_day": trading_day().isoformat()}
    snapshot = account(equity=30.0, multiplier=2.0, daytrade_count=3)
    assessment = risk.evaluate_exit(trade=trade, account=snapshot, exit_reason="stop_loss")
    assert assessment.approved is True
    assert assessment.details["pdt_override"] == "risk_exit_takes_priority"


def test_overnight_position_exit_is_never_a_day_trade(risk: RiskSentinel):
    trade = {"symbol": "AAPL", "quantity": 0.1, "opened_day": "2020-01-02"}
    snapshot = account(equity=30.0, multiplier=2.0, daytrade_count=3)
    assessment = risk.evaluate_exit(trade=trade, account=snapshot, exit_reason="take_profit")
    assert assessment.approved is True
    assert assessment.details["would_be_day_trade"] is False


# ------------------------------------------------------------------ entries
def entry(risk: RiskSentinel, **overrides):
    params = {
        "symbol": "AAPL", "side": "buy", "reference_price": 100.0, "limit_price": 100.05,
        "confidence": 0.8, "expected_move_bps": 200.0, "account": account(equity=30.0, cash=30.0),
        "positions": (),
    }
    params.update(overrides)
    return risk.evaluate_entry(**params)


def test_good_entry_is_approved_with_a_positive_net_ev(risk: RiskSentinel):
    assessment = entry(risk)
    assert assessment.approved is True
    assert assessment.ev is not None and assessment.ev.net_ev > 0
    assert assessment.quantity > 0


def test_entry_rejected_when_edge_does_not_cover_costs(risk: RiskSentinel):
    assessment = entry(risk, expected_move_bps=3.0)
    assert assessment.approved is False
    assert assessment.reason in ("net_ev_not_positive", "predicted_move_below_breakeven")


def test_entry_probability_starts_from_the_prior_then_follows_reality(risk: RiskSentinel, store: Store):
    prior, detail = risk.entry_probability(0.6)
    assert detail["source"] == "prior"
    assert prior > detail["baseline"]

    # A losing record must drag the probability below the no-edge baseline, which
    # makes every subsequent expected value negative without human intervention.
    for index in range(40):
        trade_id = store.open_trade({"symbol": "X", "quantity": 0.1, "entry_price": 100.0})
        net = 0.3 if index % 10 < 3 else -0.2
        store.close_trade(trade_id, exit_price=100 + net, gross_pnl=net, fees=0.01, net_pnl=net)

    blended, detail = risk.entry_probability(0.6)
    assert detail["source"] == "blended"
    assert detail["samples"] == 40
    assert blended < detail["baseline"]


def test_a_losing_track_record_stops_approving_entries(risk: RiskSentinel, store: Store):
    assert entry(risk).approved is True
    for index in range(40):
        trade_id = store.open_trade({"symbol": "Y", "quantity": 0.1, "entry_price": 100.0})
        net = 0.3 if index % 10 < 2 else -0.2
        store.close_trade(trade_id, exit_price=100 + net, gross_pnl=net, fees=0.01, net_pnl=net)
    assert entry(risk).approved is False


def test_entry_rejected_below_minimum_confidence(risk: RiskSentinel):
    assessment = entry(risk, confidence=0.2)
    assert assessment.approved is False
    assert assessment.reason == "confidence_below_minimum"


def test_entry_rejected_when_already_holding_the_symbol(risk: RiskSentinel):
    broker = FakeBroker()
    broker.set_position("AAPL", 0.1, 100.0, 101.0)
    assessment = entry(risk, positions=broker.get_positions())
    assert assessment.approved is False
    assert assessment.reason == "position_already_open"


def test_short_entry_refused_without_shorting_enabled(risk: RiskSentinel):
    assessment = entry(risk, side="sell")
    assert assessment.approved is False
    assert assessment.reason == "shorting_not_enabled"


def test_snapshot_reports_every_limit(risk: RiskSentinel):
    snapshot = risk.snapshot(account())
    assert {"trading_allowed", "daily_loss", "drawdown", "posture"} <= set(snapshot)

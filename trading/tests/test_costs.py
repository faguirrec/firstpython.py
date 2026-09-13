"""Net-EV tests. An error in this file costs real money, so it is the most
thoroughly covered module in the project."""

from __future__ import annotations

import pytest

from trading_bot.config import CostConfig
from trading_bot.costs import (
    baseline_hit_probability,
    breakeven_move_bps,
    evaluate_net_ev,
    realized_costs,
    round_trip_costs,
    sec_fee,
    taf_fee,
)

CONFIG = CostConfig()


def test_sec_fee_applies_to_sale_proceeds_only():
    assert sec_fee(1_000_000, CONFIG) == pytest.approx(27.80, abs=0.01)
    assert sec_fee(0, CONFIG) == 0.0
    assert sec_fee(-10, CONFIG) == 0.0


def test_taf_is_per_share_and_capped():
    assert taf_fee(100, CONFIG) == pytest.approx(0.0166)
    assert taf_fee(10_000_000, CONFIG) == CONFIG.taf_max_per_order
    assert taf_fee(0, CONFIG) == 0.0


def test_round_trip_costs_include_both_sides_of_the_spread():
    costs = round_trip_costs(100.0, 0.1, CONFIG)
    notional = 10.0
    expected_spread = 2 * notional * CONFIG.default_half_spread_bps * 1e-4
    expected_slippage = 2 * notional * CONFIG.slippage_bps * 1e-4
    assert costs.spread_cost == pytest.approx(expected_spread)
    assert costs.slippage_cost == pytest.approx(expected_slippage)
    assert costs.total == pytest.approx(
        costs.commission + costs.regulatory + expected_spread + expected_slippage
    )


def test_round_trip_costs_are_zero_for_empty_orders():
    assert round_trip_costs(0.0, 1.0, CONFIG).total == 0.0
    assert round_trip_costs(100.0, 0.0, CONFIG).total == 0.0


def test_breakeven_move_is_the_cost_of_the_round_trip():
    breakeven = breakeven_move_bps(100.0, 0.1, CONFIG)
    costs = round_trip_costs(100.0, 0.1, CONFIG)
    assert breakeven == pytest.approx(costs.total / 10.0 / 1e-4)


def test_a_signal_with_no_edge_has_exactly_zero_gross_ev():
    """The property the whole filter rests on: confidence 0 means no edge."""
    result = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=200.0, confidence=0.0, config=CONFIG,
        take_profit_pct=0.03, stop_loss_pct=0.02,
    )
    assert result.hit_probability == pytest.approx(result.baseline_probability)
    assert result.gross_ev == pytest.approx(0.0, abs=1e-9)
    # And after costs it is a loser, so it must be rejected.
    assert result.net_ev < 0
    assert result.approved is False


def test_baseline_probability_is_the_nearer_barrier():
    # With a 3% target and a 2% stop, a driftless price hits the stop more often.
    assert baseline_hit_probability(0.03, 0.02) == pytest.approx(0.4)
    assert baseline_hit_probability(0.02, 0.02) == pytest.approx(0.5)
    assert baseline_hit_probability(0.02, 0.04) == pytest.approx(2 / 3)


def test_losing_branch_is_actually_priced():
    """A 40% hit rate on 3%/2% is break-even; below it the EV must go negative."""
    below = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=200.0, confidence=0.9, config=CONFIG,
        take_profit_pct=0.03, stop_loss_pct=0.02, probability=0.30,
    )
    above = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=200.0, confidence=0.9, config=CONFIG,
        take_profit_pct=0.03, stop_loss_pct=0.02, probability=0.55,
    )
    assert below.gross_ev < 0 and below.approved is False
    assert above.gross_ev > 0 and above.approved is True


def test_a_measured_probability_overrides_the_confidence_prior():
    high_confidence_bad_record = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=200.0, confidence=1.0, config=CONFIG, probability=0.25,
    )
    assert high_confidence_bad_record.hit_probability == pytest.approx(0.25)
    assert high_confidence_bad_record.approved is False


def test_predicted_move_below_breakeven_is_rejected():
    """Even with a good hit rate, a move too small to clear costs is no trade."""
    result = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=5.0, confidence=0.9, config=CONFIG,
    )
    assert result.approved is False
    assert result.reason == "predicted_move_below_breakeven"


def test_trade_with_real_edge_is_approved():
    result = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=150.0, confidence=0.8, config=CONFIG,
        min_net_ev_usd=0.01, min_net_ev_bps=15.0,
    )
    assert result.approved is True
    assert result.net_ev > 0
    assert result.net_ev_bps > 15.0


def test_low_confidence_shrinks_gross_ev_but_not_costs():
    high = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=150.0, confidence=0.9, config=CONFIG,
    )
    low = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=150.0, confidence=0.05, config=CONFIG,
    )
    assert low.gross_ev < high.gross_ev
    # Costs do not care how sure we are, so a weak signal drowns in them.
    assert low.costs.total == pytest.approx(high.costs.total)
    assert high.approved is True
    assert low.approved is False


def test_usd_and_bps_floors_reject_marginal_trades():
    marginal = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=30.0, confidence=0.7, config=CONFIG,
        min_net_ev_usd=1.00, min_net_ev_bps=0.0,
    )
    assert marginal.net_ev > 0
    assert marginal.approved is False
    assert marginal.reason == "net_ev_below_usd_floor"

    bps_floor = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=30.0, confidence=0.7, config=CONFIG,
        min_net_ev_usd=0.0, min_net_ev_bps=500.0,
    )
    assert bps_floor.approved is False
    assert bps_floor.reason == "net_ev_below_bps_floor"


def test_wide_spread_can_flip_a_good_signal_to_negative():
    tight = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=60.0, confidence=0.8, config=CONFIG, half_spread_bps=2.0,
    )
    wide = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.1, entry_price=100.0,
        expected_move_bps=60.0, confidence=0.8, config=CONFIG, half_spread_bps=80.0,
    )
    assert tight.approved is True
    assert wide.approved is False


def test_sell_side_edge_points_the_other_way():
    result = evaluate_net_ev(
        symbol="AAPL", side="sell", quantity=0.1, entry_price=100.0,
        expected_move_bps=150.0, confidence=0.8, config=CONFIG,
    )
    # A "sell" candidate expecting the price to rise has negative EV.
    assert result.gross_ev < 0
    assert result.approved is False


def test_zero_notional_is_rejected_not_crashed():
    result = evaluate_net_ev(
        symbol="AAPL", side="buy", quantity=0.0, entry_price=100.0,
        expected_move_bps=100.0, confidence=1.0, config=CONFIG,
    )
    assert result.approved is False
    assert result.reason == "zero_notional"


def test_invalid_side_raises():
    with pytest.raises(ValueError):
        evaluate_net_ev(
            symbol="AAPL", side="hold", quantity=1, entry_price=10,
            expected_move_bps=10, confidence=1, config=CONFIG,
        )


def test_realized_costs_exclude_spread_already_in_the_fills():
    costs = realized_costs(entry_price=100.0, exit_price=103.0, quantity=0.1, config=CONFIG)
    assert costs.spread_cost == 0.0
    assert costs.slippage_cost == 0.0
    assert costs.sec_fee == pytest.approx(10.3 * CONFIG.sec_fee_rate)
    assert costs.total > 0


def test_commission_schedule_is_honoured_when_a_broker_charges():
    paid = CostConfig(commission_per_order=0.35, commission_per_share=0.01)
    costs = round_trip_costs(100.0, 2.0, paid)
    assert costs.commission == pytest.approx(2 * 0.35 + 2 * 2.0 * 0.01)

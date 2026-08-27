"""Trading cost model and net expected value.

The pilot runs on USD $30, so a trade that looks profitable gross can easily be
a loser once the round trip is paid for. Everything here answers one question:
*after all costs, is the expected value still positive?*

Cost components for a US equity round trip:

* **Commission** - $0 per order at Alpaca, but modelled anyway so the same code
  works on a broker that charges.
* **SEC Section 31 fee** - charged on the *sell* side only, as a rate applied to
  sale proceeds.
* **FINRA TAF** - charged on the *sell* side only, per share, capped per order.
* **Spread + slippage** - half the quoted spread on each fill, plus a slippage
  cushion. Limit orders reduce but do not eliminate this.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .config import CostConfig

BPS = 1e-4


@dataclass(frozen=True)
class CostBreakdown:
    """Itemised cost of a round trip, in dollars."""

    commission: float
    sec_fee: float
    taf_fee: float
    spread_cost: float
    slippage_cost: float

    @property
    def regulatory(self) -> float:
        return self.sec_fee + self.taf_fee

    @property
    def total(self) -> float:
        return (
            self.commission
            + self.sec_fee
            + self.taf_fee
            + self.spread_cost
            + self.slippage_cost
        )

    def as_dict(self) -> dict[str, float]:
        data = asdict(self)
        data["regulatory"] = self.regulatory
        data["total"] = self.total
        return {key: round(value, 6) for key, value in data.items()}


@dataclass(frozen=True)
class NetExpectedValue:
    """Result of the go/no-go economics check for one candidate trade."""

    symbol: str
    side: str
    quantity: float
    entry_price: float
    notional: float
    expected_move_bps: float
    gross_ev: float
    costs: CostBreakdown
    net_ev: float
    net_ev_bps: float
    breakeven_move_bps: float
    approved: bool
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "quantity": round(self.quantity, 6),
            "entry_price": round(self.entry_price, 4),
            "notional": round(self.notional, 4),
            "expected_move_bps": round(self.expected_move_bps, 2),
            "gross_ev": round(self.gross_ev, 6),
            "costs": self.costs.as_dict(),
            "net_ev": round(self.net_ev, 6),
            "net_ev_bps": round(self.net_ev_bps, 2),
            "breakeven_move_bps": round(self.breakeven_move_bps, 2),
            "approved": self.approved,
            "reason": self.reason,
        }


def sec_fee(sale_proceeds: float, config: CostConfig) -> float:
    """SEC Section 31 fee on sale proceeds (sells only, never negative)."""
    if sale_proceeds <= 0:
        return 0.0
    return sale_proceeds * config.sec_fee_rate


def taf_fee(shares_sold: float, config: CostConfig) -> float:
    """FINRA Trading Activity Fee: per share sold, capped per order."""
    if shares_sold <= 0:
        return 0.0
    return min(shares_sold * config.taf_per_share, config.taf_max_per_order)


def one_way_execution_cost(
    price: float,
    quantity: float,
    config: CostConfig,
    *,
    half_spread_bps: float | None = None,
) -> tuple[float, float]:
    """Spread and slippage cost of a single fill, in dollars.

    Returns ``(spread_cost, slippage_cost)``.
    """
    if price <= 0 or quantity <= 0:
        return 0.0, 0.0
    notional = price * quantity
    half_spread = config.default_half_spread_bps if half_spread_bps is None else half_spread_bps
    return notional * max(half_spread, 0.0) * BPS, notional * max(config.slippage_bps, 0.0) * BPS


def round_trip_costs(
    entry_price: float,
    quantity: float,
    config: CostConfig,
    *,
    exit_price: float | None = None,
    half_spread_bps: float | None = None,
) -> CostBreakdown:
    """Total cost of buying ``quantity`` at ``entry_price`` and selling it back.

    ``exit_price`` defaults to the entry price: regulatory fees scale with the
    sale proceeds, and assuming a flat exit keeps the estimate from flattering
    the trade when the expected move is up.
    """
    if entry_price <= 0 or quantity <= 0:
        return CostBreakdown(0.0, 0.0, 0.0, 0.0, 0.0)

    exit_px = entry_price if exit_price is None else exit_price
    entry_spread, entry_slip = one_way_execution_cost(
        entry_price, quantity, config, half_spread_bps=half_spread_bps
    )
    exit_spread, exit_slip = one_way_execution_cost(
        exit_px, quantity, config, half_spread_bps=half_spread_bps
    )

    commission = 2 * config.commission_per_order + 2 * quantity * config.commission_per_share
    proceeds = exit_px * quantity
    return CostBreakdown(
        commission=commission,
        sec_fee=sec_fee(proceeds, config),
        taf_fee=taf_fee(quantity, config),
        spread_cost=entry_spread + exit_spread,
        slippage_cost=entry_slip + exit_slip,
    )


def breakeven_move_bps(
    entry_price: float,
    quantity: float,
    config: CostConfig,
    *,
    half_spread_bps: float | None = None,
) -> float:
    """How far the price must move, in bps, just to cover the round trip."""
    notional = entry_price * quantity
    if notional <= 0:
        return float("inf")
    costs = round_trip_costs(entry_price, quantity, config, half_spread_bps=half_spread_bps)
    return costs.total / notional / BPS


def evaluate_net_ev(
    *,
    symbol: str,
    side: str,
    quantity: float,
    entry_price: float,
    expected_move_bps: float,
    confidence: float,
    config: CostConfig,
    half_spread_bps: float | None = None,
    min_net_ev_usd: float = 0.0,
    min_net_ev_bps: float = 0.0,
) -> NetExpectedValue:
    """Decide whether a candidate trade is worth doing after costs.

    ``expected_move_bps`` is the *directional* edge the signal stack predicts and
    ``confidence`` (0-1) scales it: gross EV is the probability-weighted dollar
    move. Costs are then subtracted in full - they are certain, the edge is not.
    """
    normalized_side = side.lower()
    if normalized_side not in ("buy", "sell"):
        raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")

    quantity = max(quantity, 0.0)
    confidence = min(max(confidence, 0.0), 1.0)
    notional = entry_price * quantity

    if notional <= 0:
        zero = CostBreakdown(0.0, 0.0, 0.0, 0.0, 0.0)
        return NetExpectedValue(
            symbol=symbol, side=normalized_side, quantity=quantity, entry_price=entry_price,
            notional=0.0, expected_move_bps=expected_move_bps, gross_ev=0.0, costs=zero,
            net_ev=0.0, net_ev_bps=0.0, breakeven_move_bps=float("inf"),
            approved=False, reason="zero_notional",
        )

    # A short/sell candidate profits from a fall, so its edge points the other way.
    directional_bps = expected_move_bps if normalized_side == "buy" else -expected_move_bps
    gross_ev = notional * directional_bps * BPS * confidence

    projected_exit = entry_price * (1 + directional_bps * BPS)
    costs = round_trip_costs(
        entry_price, quantity, config, exit_price=projected_exit, half_spread_bps=half_spread_bps
    )
    net_ev = gross_ev - costs.total
    net_ev_bps = net_ev / notional / BPS
    breakeven = costs.total / notional / BPS

    if net_ev <= 0:
        reason = "net_ev_not_positive"
    elif net_ev < min_net_ev_usd:
        reason = "net_ev_below_usd_floor"
    elif net_ev_bps < min_net_ev_bps:
        reason = "net_ev_below_bps_floor"
    else:
        reason = "approved"

    return NetExpectedValue(
        symbol=symbol,
        side=normalized_side,
        quantity=quantity,
        entry_price=entry_price,
        notional=notional,
        expected_move_bps=expected_move_bps,
        gross_ev=gross_ev,
        costs=costs,
        net_ev=net_ev,
        net_ev_bps=net_ev_bps,
        breakeven_move_bps=breakeven,
        approved=reason == "approved",
        reason=reason,
    )


def realized_costs(
    *,
    entry_price: float,
    exit_price: float,
    quantity: float,
    config: CostConfig,
) -> CostBreakdown:
    """Costs actually incurred by a closed round trip (fills already known).

    Spread is not re-charged here: it is already baked into the fill prices.
    """
    if quantity <= 0:
        return CostBreakdown(0.0, 0.0, 0.0, 0.0, 0.0)
    commission = 2 * config.commission_per_order + 2 * quantity * config.commission_per_share
    return CostBreakdown(
        commission=commission,
        sec_fee=sec_fee(exit_price * quantity, config),
        taf_fee=taf_fee(quantity, config),
        spread_cost=0.0,
        slippage_cost=0.0,
    )

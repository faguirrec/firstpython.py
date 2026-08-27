"""LearningLoop - nightly review of what actually worked.

After the close, every trade that closed since the last run is graded: for each
signal component that contributed to the entry, did it point the right way?

Weights move like a simple bandit:

* an exponentially-weighted accuracy per signal (recent results count more),
* the weight is that accuracy re-centred on 0.5 and mapped into
  ``[MIN_WEIGHT, MAX_WEIGHT]``, so a signal that stops predicting fades out
  instead of being deleted (it can earn its way back),
* updates are damped by ``LEARNING_RATE`` so one lucky trade cannot rewrite the
  strategy.

This is deliberately not reinforcement learning. It is auditable, it converges
on tiny sample sizes, and every number it produces is stored in
``signal_weights`` for the final report.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from ..clock import iso, utcnow
from ..config import Settings
from ..db import Store
from ..logging_setup import get_logger

log = get_logger(__name__)

# How fast the accuracy EMA forgets. 0.25 == roughly the last 4-8 trades dominate.
EMA_ALPHA = 0.25
# Damping on the weight move itself.
LEARNING_RATE = 0.35
MIN_WEIGHT = 0.1
MAX_WEIGHT = 2.0
# A component below this magnitude did not really participate in the decision.
PARTICIPATION_THRESHOLD = 0.05


@dataclass(frozen=True)
class TradeReview:
    """Grading of one closed trade."""

    trade_id: int
    symbol: str
    net_pnl: float
    return_pct: float
    direction_correct: bool
    expected_move_bps: float | None
    realized_move_bps: float
    components: dict[str, float]
    graded: dict[str, bool]

    def as_dict(self) -> dict[str, Any]:
        return {
            "trade_id": self.trade_id,
            "symbol": self.symbol,
            "net_pnl": round(self.net_pnl, 4),
            "return_pct": round(self.return_pct, 6),
            "direction_correct": self.direction_correct,
            "expected_move_bps": self.expected_move_bps,
            "realized_move_bps": round(self.realized_move_bps, 2),
            "components": {k: round(v, 4) for k, v in self.components.items()},
            "graded": self.graded,
        }


class LearningLoop:
    """Grades closed trades and updates the signal weights."""

    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store
        self.store.ensure_weights(settings.signals.seed_weights)

    def run(self) -> dict[str, Any]:
        """Review every unreviewed closed trade and update weights once."""
        trades = self.store.closed_trades(unreviewed_only=True)
        if not trades:
            log.info("learning_loop_idle", extra={"event": {"reviewed": 0}})
            return {"reviewed": 0, "weights": self.store.weight_values()}

        reviews = [self.review_trade(trade) for trade in trades]
        reviews = [r for r in reviews if r is not None]
        outcomes: dict[str, list[tuple[bool, float]]] = {}
        for review in reviews:
            for name, correct in review.graded.items():
                outcomes.setdefault(name, []).append((correct, review.net_pnl))
            self.store.mark_trade_reviewed(review.trade_id)

        weights = self.update_weights(outcomes)
        summary = {
            "reviewed": len(reviews),
            "wins": sum(1 for r in reviews if r.net_pnl > 0),
            "losses": sum(1 for r in reviews if r.net_pnl <= 0),
            "net_pnl": round(sum(r.net_pnl for r in reviews), 4),
            "weights": weights,
            "ran_at": iso(utcnow()),
        }
        self.store.record_event("learning_loop_run", "nightly review", **summary)
        log.info("learning_loop_run", extra={"event": summary})
        return summary

    # --------------------------------------------------------------- grading
    def review_trade(self, trade: Mapping[str, Any]) -> TradeReview | None:
        """Grade one closed trade against the signals that opened it."""
        entry = float(trade.get("entry_price") or 0.0)
        exit_price = trade.get("exit_price")
        if entry <= 0 or exit_price is None:
            return None

        realized_move_bps = (float(exit_price) - entry) / entry / 1e-4
        net_pnl = float(trade.get("net_pnl") or 0.0)
        # The trade was long-only, so "direction correct" means the price rose.
        direction_correct = realized_move_bps > 0

        components = _components_of(trade.get("signals") or {})
        graded: dict[str, bool] = {}
        for name, value in components.items():
            if abs(value) < PARTICIPATION_THRESHOLD:
                continue
            # A component gets credit when its sign matched the realized move.
            graded[name] = (value > 0) == direction_correct

        return TradeReview(
            trade_id=int(trade["id"]),
            symbol=str(trade.get("symbol", "")),
            net_pnl=net_pnl,
            return_pct=float(trade.get("return_pct") or 0.0),
            direction_correct=direction_correct,
            expected_move_bps=trade.get("expected_move_bps"),
            realized_move_bps=realized_move_bps,
            components=components,
            graded=graded,
        )

    # --------------------------------------------------------------- weights
    def update_weights(self, outcomes: Mapping[str, Sequence[tuple[bool, float]]]) -> dict[str, float]:
        """Fold the batch of outcomes into each signal's accuracy and weight."""
        current = self.store.signal_weights()
        for name, results in outcomes.items():
            existing = current.get(name)
            ema = existing.ema_accuracy if existing else 0.5
            weight = existing.weight if existing else self.settings.signals.seed_weights.get(name, 1.0)
            pnl_delta = 0.0

            for correct, pnl in results:
                ema = (1 - EMA_ALPHA) * ema + EMA_ALPHA * (1.0 if correct else 0.0)
                pnl_delta += pnl
                self.store.update_weight(
                    name, weight=weight, hit=correct, ema_accuracy=ema, pnl_delta=pnl
                )

            target = target_weight(ema)
            new_weight = weight + LEARNING_RATE * (target - weight)
            new_weight = max(MIN_WEIGHT, min(MAX_WEIGHT, new_weight))
            self.store.update_weight(name, weight=new_weight, ema_accuracy=ema)
            log.info(
                "weight_updated",
                extra={"event": {
                    "signal": name, "from": round(weight, 4), "to": round(new_weight, 4),
                    "ema_accuracy": round(ema, 4), "samples": len(results),
                    "pnl_contribution": round(pnl_delta, 4),
                }},
            )
        return self.store.weight_values()

    # -------------------------------------------------------------- analysis
    def signal_performance(self) -> list[dict[str, Any]]:
        """Per-signal scoreboard for the final report."""
        rows = []
        for name, weight in sorted(self.store.signal_weights().items()):
            rows.append(
                {
                    "signal": name,
                    "weight": round(weight.weight, 4),
                    "hits": weight.hits,
                    "misses": weight.misses,
                    "samples": weight.samples,
                    "hit_rate": round(weight.hit_rate, 4),
                    "ema_accuracy": round(weight.ema_accuracy, 4),
                    "net_pnl": round(weight.net_pnl, 4),
                }
            )
        return rows


def target_weight(accuracy: float) -> float:
    """Map a 0-1 accuracy onto the weight range, with 0.5 accuracy == weight 1."""
    accuracy = max(0.0, min(1.0, accuracy))
    if accuracy >= 0.5:
        return 1.0 + (accuracy - 0.5) / 0.5 * (MAX_WEIGHT - 1.0)
    return MIN_WEIGHT + (accuracy / 0.5) * (1.0 - MIN_WEIGHT)


def _components_of(signals: Mapping[str, Any]) -> dict[str, float]:
    """Extract the per-signal component scores stored with the entry decision."""
    raw = signals.get("components") if isinstance(signals, Mapping) else None
    if not isinstance(raw, Mapping):
        # Older rows stored a flat mapping of name -> score.
        raw = signals if isinstance(signals, Mapping) else {}
    out: dict[str, float] = {}
    for name, value in raw.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[str(name)] = float(value)
    return out

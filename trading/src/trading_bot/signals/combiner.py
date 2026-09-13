"""Weighted fusion of technical, sentiment and regime signals.

The fused score is a weighted average in ``[-1, 1]``; the weights come from
``LearningLoop`` (persisted in ``signal_weights``) so the mix adapts to what has
actually been predictive lately instead of staying frozen at the seed values.

Confidence is deliberately conservative: it rewards *agreement* between
independent signals, not the magnitude of any single one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from ..clock import parse_iso, utcnow
from .indicators import SignalSet, clamp


@dataclass(frozen=True)
class FusedSignal:
    """The output of signal fusion for one symbol at one moment."""

    symbol: str
    score: float
    confidence: float
    expected_move_bps: float
    action: str
    components: dict[str, float] = field(default_factory=dict)
    weights: dict[str, float] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)

    @property
    def direction(self) -> int:
        if self.action == "buy":
            return 1
        if self.action == "sell":
            return -1
        return 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 4),
            "expected_move_bps": round(self.expected_move_bps, 2),
            "action": self.action,
            "components": {k: round(v, 4) for k, v in self.components.items()},
            "weights": {k: round(v, 4) for k, v in self.weights.items()},
            "context": self.context,
        }


def aggregate_sentiment(
    records: Sequence[Mapping[str, Any]],
    *,
    half_life_hours: float = 12.0,
    now=None,
    min_confidence: float = 0.2,
) -> tuple[float | None, dict[str, Any]]:
    """Collapse recent per-article sentiment into one score in ``[-1, 1]``.

    Each article is weighted by its classification confidence and decayed
    exponentially with age, so a stale headline cannot drive a trade. Rumours
    (flagged by NewsPulse) are excluded outright.
    """
    reference = now or utcnow()
    numerator = 0.0
    denominator = 0.0
    used = 0
    for record in records:
        if record.get("is_rumor"):
            continue
        confidence = float(record.get("confidence", 0.0) or 0.0)
        if confidence < min_confidence:
            continue
        score = float(record.get("sentiment_score", 0.0) or 0.0)
        published = parse_iso(record.get("published_at") or record.get("created_at"))
        age_hours = 0.0
        if published is not None:
            age_hours = max((reference - published).total_seconds() / 3600.0, 0.0)
        decay = 0.5 ** (age_hours / half_life_hours) if half_life_hours > 0 else 1.0
        weight = confidence * decay
        if weight <= 0:
            continue
        numerator += score * weight
        denominator += weight
        used += 1

    context = {"articles": len(records), "articles_used": used, "weight_sum": round(denominator, 4)}
    if denominator <= 0:
        return None, context
    return clamp(numerator / denominator), context


def fuse_signals(
    symbol: str,
    technical: SignalSet,
    *,
    weights: Mapping[str, float] | None = None,
    sentiment: float | None = None,
    regime: float | None = None,
    edge_scale_bps: float = 120.0,
    min_confidence: float = 0.35,
    buy_threshold: float = 0.15,
    sell_threshold: float = -0.15,
    max_component_share: float = 0.4,
    require_technical_agreement: bool = True,
    extra_context: Mapping[str, Any] | None = None,
) -> FusedSignal:
    """Combine every available component into one actionable signal.

    Returns ``action='hold'`` whenever the fused score is inside the dead band or
    confidence is below ``min_confidence`` - doing nothing is free, trading is not.
    """
    components: dict[str, float] = dict(technical.scores)
    if sentiment is not None:
        components["sentiment"] = clamp(sentiment)
    if regime is not None:
        components["regime"] = clamp(regime)

    weight_map = dict(weights or {})
    used_weights = {name: max(float(weight_map.get(name, 1.0)), 0.0) for name in components}
    used_weights = _cap_weight_share(used_weights, max_share=max_component_share)
    total_weight = sum(used_weights.values())

    if not components or total_weight <= 0:
        return FusedSignal(
            symbol=symbol,
            score=0.0,
            confidence=0.0,
            expected_move_bps=0.0,
            action="hold",
            components=components,
            weights=used_weights,
            context={"reason": "no_signals", **(dict(extra_context) if extra_context else {})},
        )

    score = sum(components[name] * used_weights[name] for name in components) / total_weight
    score = clamp(score)

    confidence = _confidence(components, used_weights, score)
    expected_move_bps = abs(score) * edge_scale_bps

    # Sentiment comes from news the bot does not control. Requiring a price-based
    # component to agree means a manipulated headline cannot open a position on
    # its own, however much weight sentiment has earned.
    technical_agrees = True
    if require_technical_agreement and score != 0:
        direction = 1.0 if score > 0 else -1.0
        price_based = {
            name: value for name, value in components.items()
            if name not in ("sentiment", "regime")
        }
        technical_agrees = any(value * direction > 0 for value in price_based.values())

    if confidence < min_confidence:
        action = "hold"
    elif not technical_agrees:
        action = "hold"
    elif score >= buy_threshold:
        action = "buy"
    elif score <= sell_threshold:
        action = "sell"
    else:
        action = "hold"

    context: dict[str, Any] = {
        "agreement": round(_agreement(components, used_weights, score), 4),
        "technical_agrees": technical_agrees,
        "signal_count": len(components),
        **technical.context,
    }
    if extra_context:
        context.update(extra_context)

    return FusedSignal(
        symbol=symbol,
        score=score,
        confidence=confidence,
        expected_move_bps=expected_move_bps,
        action=action,
        components=components,
        weights=used_weights,
        context=context,
    )


def _cap_weight_share(
    weights: Mapping[str, float], *, max_share: float = 0.4
) -> dict[str, float]:
    """Stop any one component from owning more than ``max_share`` of the vote.

    LearningLoop can legitimately drive one weight to its maximum and the rest to
    their minimum. Without a cap, that single component then decides every trade
    by itself - which is only safe if it can never be manipulated, and sentiment
    can be.
    """
    values = {name: max(weight, 0.0) for name, weight in weights.items()}
    total = sum(values.values())
    if total <= 0 or len(values) < 2 or not 0 < max_share < 1:
        return values

    # A cap can never demand less than an equal share: with two components,
    # "no more than 40% each" is unsatisfiable, and asking for it anyway would
    # shrink both weights toward zero instead of levelling them.
    effective_share = max(max_share, 1.0 / len(values))
    if effective_share >= 1.0:
        return values

    # Trimming a weight also shrinks the total, so the ceiling has to be solved
    # against the *other* weights: w / (w + others) <= share.
    ratio = effective_share / (1 - effective_share)
    for _ in range(len(values)):
        changed = False
        for name, weight in list(values.items()):
            others = sum(v for key, v in values.items() if key != name)
            ceiling = others * ratio
            if weight > ceiling + 1e-12:
                values[name] = ceiling
                changed = True
        if not changed:
            break
    return values


def _agreement(
    components: Mapping[str, float], weights: Mapping[str, float], score: float
) -> float:
    """Weighted share of components pointing the same way as the fused score."""
    if score == 0:
        return 0.0
    direction = 1.0 if score > 0 else -1.0
    aligned = sum(
        weights.get(name, 0.0)
        for name, value in components.items()
        if value * direction > 0
    )
    total = sum(weights.get(name, 0.0) for name, value in components.items() if value != 0)
    return aligned / total if total > 0 else 0.0


def _confidence(
    components: Mapping[str, float], weights: Mapping[str, float], score: float
) -> float:
    """Confidence in ``[0, 1]``: strength x agreement x breadth.

    * strength - how far the fused score is from neutral,
    * agreement - do the components point the same way,
    * breadth - a single indicator is never as trustworthy as four.
    """
    strength = min(abs(score) / 0.5, 1.0)
    agreement = _agreement(components, weights, score)
    active = sum(1 for value in components.values() if abs(value) > 1e-9)
    breadth = 1 - math.exp(-active / 2.5) if active else 0.0
    return round(clamp(strength * agreement * breadth, 0.0, 1.0), 4)

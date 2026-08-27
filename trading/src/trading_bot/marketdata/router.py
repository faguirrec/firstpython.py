"""Routing between a bars provider and a real-time quote source.

The split exists because the two jobs have different requirements:

* **Bars** feed the indicators. A 15-minute delay is survivable there - the
  slow/fast moving averages barely notice.
* **Quotes** price the limit order and feed the spread into the net-EV check.
  Delayed or bid/ask-less data must never do that job, so quotes fall back to
  the execution broker, which is real time by definition.
"""

from __future__ import annotations

from typing import Any

from ..brokers.base import Bar, Quote
from ..logging_setup import get_logger
from .base import MarketDataError, ProviderInfo
from .providers import AlphaVantageData, AlpacaData, PolygonData

log = get_logger(__name__)


class MarketData:
    """Facade the signal stack talks to."""

    def __init__(self, bars_provider: Any, quote_provider: Any | None = None) -> None:
        self.bars_provider = bars_provider
        bars_info: ProviderInfo = bars_provider.info

        # Quotes come from the bars provider only when it is real time and
        # actually carries a bid/ask; otherwise from the execution broker.
        if bars_info.realtime_quotes and bars_info.has_bid_ask:
            self.quote_provider = bars_provider
        else:
            self.quote_provider = quote_provider or bars_provider
            if quote_provider is not None and quote_provider is not bars_provider:
                log.info(
                    "quotes_routed_to_realtime_source",
                    extra={"event": {
                        "bars": bars_info.name,
                        "quotes": quote_provider.info.name,
                        "reason": "delayed_or_no_bid_ask",
                    }},
                )

    @property
    def info(self) -> ProviderInfo:
        return self.bars_provider.info

    def describe(self) -> dict[str, Any]:
        return {
            "bars": self.bars_provider.info.as_dict(),
            "quotes": self.quote_provider.info.as_dict(),
            "quotes_are_realtime": bool(
                self.quote_provider.info.realtime_quotes and self.quote_provider.info.has_bid_ask
            ),
        }

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        return self.bars_provider.get_bars(symbol, limit=limit, timeframe=timeframe)

    def get_latest_quote(self, symbol: str) -> Quote | None:
        """A quote, or ``None`` when no real-time bid/ask is available.

        Returning ``None`` is deliberate: the caller then falls back to the
        conservative default half-spread instead of trusting a stale one.
        """
        info = self.quote_provider.info
        if not (info.realtime_quotes and info.has_bid_ask):
            return None
        try:
            return self.quote_provider.get_latest_quote(symbol)
        except MarketDataError as exc:
            log.warning("quote_failed", extra={"event": {"symbol": symbol, "error": str(exc)}})
            return None

    def get_latest_price(self, symbol: str) -> float | None:
        """Best available price: real-time quote mid, else the last bar close."""
        quote = self.get_latest_quote(symbol)
        if quote is not None and quote.mid > 0:
            return quote.mid
        try:
            return self.quote_provider.get_latest_price(symbol)
        except MarketDataError:
            pass
        try:
            bars = self.get_bars(symbol, limit=1, timeframe="1Min")
        except MarketDataError:
            return None
        return bars[-1].close if bars else None


def build_market_data(settings: Any, broker: Any) -> MarketData:
    """Build the configured provider, with the broker as the quote fallback."""
    broker_data = AlpacaData(broker, feed=getattr(settings, "alpaca_feed", "iex"))
    provider_name = (getattr(settings, "market_data_provider", "alpaca") or "alpaca").lower()

    if provider_name in ("alpaca", "", "broker"):
        return MarketData(broker_data)

    api_key = getattr(settings, "market_data_api_key", "")
    try:
        if provider_name == "polygon":
            provider = PolygonData(
                api_key,
                realtime=bool(getattr(settings, "market_data_realtime", False)),
                requests_per_minute=int(getattr(settings, "market_data_rpm", 5)),
            )
        elif provider_name in ("alphavantage", "alpha_vantage"):
            provider = AlphaVantageData(
                api_key, requests_per_minute=int(getattr(settings, "market_data_rpm", 5))
            )
        else:
            raise MarketDataError(f"unknown MARKET_DATA_PROVIDER: {provider_name!r}")
    except MarketDataError as exc:
        # A misconfigured data feed must not stop the bot: fall back and say so.
        log.warning(
            "market_data_provider_unavailable",
            extra={"event": {"provider": provider_name, "error": str(exc), "fallback": "alpaca"}},
        )
        return MarketData(broker_data)

    if provider.info.caveat:
        log.info(
            "market_data_provider_caveat",
            extra={"event": {"provider": provider.info.name, "caveat": provider.info.caveat}},
        )
    return MarketData(provider, quote_provider=broker_data)

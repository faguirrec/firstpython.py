"""Pluggable market-data providers.

Execution stays on Alpaca; *where the prices come from* is a separate decision,
so upgrading the data feed is a config change rather than a rewrite.

The one rule enforced here: a limit order is never priced off delayed data.
Providers declare whether their quotes are real time, and :class:`MarketData`
routes quote requests to a real-time source regardless of which provider serves
the historical bars.
"""

from .base import MarketDataError, MarketDataProvider, ProviderInfo
from .router import MarketData, build_market_data

__all__ = [
    "MarketData",
    "MarketDataError",
    "MarketDataProvider",
    "ProviderInfo",
    "build_market_data",
]

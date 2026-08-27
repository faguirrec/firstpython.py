"""Market-data provider routing and parsing."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from conftest import FakeBroker
from trading_bot.brokers.base import Quote
from trading_bot.config import Settings
from trading_bot.marketdata import MarketData, MarketDataError, ProviderInfo, build_market_data
from trading_bot.marketdata.base import RateLimiter
from trading_bot.marketdata.providers import AlphaVantageData, AlpacaData, PolygonData


class StubProvider:
    """A provider whose capabilities the test dictates."""

    def __init__(self, info: ProviderInfo, *, price: float = 100.0) -> None:
        self.info = info
        self.price = price
        self.quote_calls = 0
        self.bar_calls = 0

    def get_bars(self, symbol, *, limit=120, timeframe="15Min"):
        self.bar_calls += 1
        from conftest import make_bars

        return make_bars([self.price] * limit)

    def get_latest_quote(self, symbol):
        self.quote_calls += 1
        return Quote(symbol=symbol, bid=self.price * 0.999, ask=self.price * 1.001)

    def get_latest_price(self, symbol):
        return self.price


def info(**kwargs) -> ProviderInfo:
    base = {
        "name": "stub", "realtime_quotes": True, "realtime_bars": True,
        "requests_per_minute": 100, "has_bid_ask": True,
    }
    base.update(kwargs)
    return ProviderInfo(**base)


# ------------------------------------------------------------------- routing
def test_realtime_provider_serves_its_own_quotes():
    provider = StubProvider(info())
    data = MarketData(provider)
    assert data.get_latest_quote("AAPL") is not None
    assert provider.quote_calls == 1
    assert data.describe()["quotes_are_realtime"] is True


def test_delayed_provider_never_prices_an_order():
    """A 15-minute-old bid/ask must not set a limit price."""
    delayed = StubProvider(info(name="polygon-free", realtime_quotes=False))
    realtime = StubProvider(info(name="broker"), price=101.0)
    data = MarketData(delayed, quote_provider=realtime)

    quote = data.get_latest_quote("AAPL")
    assert delayed.quote_calls == 0          # the delayed feed is never asked
    assert quote is not None and quote.bid == pytest.approx(101.0 * 0.999)


def test_provider_without_bid_ask_yields_no_quote_at_all():
    """Alpha Vantage has no bid/ask; the caller must fall back to the default spread."""
    no_quotes = StubProvider(info(name="alphavantage", has_bid_ask=False, realtime_quotes=False))
    data = MarketData(no_quotes, quote_provider=no_quotes)
    assert data.get_latest_quote("AAPL") is None


def test_bars_still_come_from_the_configured_provider():
    delayed = StubProvider(info(name="polygon", realtime_quotes=False))
    realtime = StubProvider(info(name="broker"))
    data = MarketData(delayed, quote_provider=realtime)
    data.get_bars("AAPL", limit=40)
    assert delayed.bar_calls == 1
    assert realtime.bar_calls == 0


def test_latest_price_falls_back_to_the_last_bar_close():
    class NoQuotes(StubProvider):
        def get_latest_price(self, symbol):
            raise MarketDataError("no price endpoint")

    provider = NoQuotes(info(has_bid_ask=False, realtime_quotes=False), price=42.0)
    data = MarketData(provider, quote_provider=provider)
    assert data.get_latest_price("AAPL") == pytest.approx(42.0)


def test_quote_errors_degrade_to_none_rather_than_raising():
    class Broken(StubProvider):
        def get_latest_quote(self, symbol):
            raise MarketDataError("feed down")

    data = MarketData(Broken(info()))
    assert data.get_latest_quote("AAPL") is None


# ------------------------------------------------------------------ factory
def test_default_configuration_uses_the_broker(broker: FakeBroker):
    settings = Settings(alpaca_api_key="k", alpaca_secret_key="s")
    data = build_market_data(settings, broker)
    assert data.info.name == "alpaca:iex"
    assert "IEX" in data.info.caveat


def test_misconfigured_provider_falls_back_instead_of_crashing(broker: FakeBroker):
    # polygon selected but no API key: the bot must still run.
    settings = Settings(alpaca_api_key="k", alpaca_secret_key="s", market_data_provider="polygon")
    data = build_market_data(settings, broker)
    assert data.info.name == "alpaca:iex"


def test_polygon_provider_routes_quotes_to_the_broker(broker: FakeBroker):
    settings = Settings(
        alpaca_api_key="k", alpaca_secret_key="s",
        market_data_provider="polygon", market_data_api_key="pk",
    )
    data = build_market_data(settings, broker)
    assert data.bars_provider.info.name == "polygon"
    assert data.quote_provider.info.name == "alpaca:iex"


def test_settings_validation_requires_a_key_for_external_providers():
    problems = Settings(
        alpaca_api_key="k", alpaca_secret_key="s", market_data_provider="polygon"
    ).validate()
    assert any("MARKET_DATA_API_KEY" in problem for problem in problems)

    unknown = Settings(
        alpaca_api_key="k", alpaca_secret_key="s", market_data_provider="bloomberg"
    ).validate()
    assert any("MARKET_DATA_PROVIDER" in problem for problem in unknown)


# ------------------------------------------------------------------ parsing
def test_polygon_bars_are_parsed_and_sorted(monkeypatch):
    provider = PolygonData("key")
    payload = {
        "results": [
            {"t": 1_700_000_000_000, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100, "vw": 1.4},
            {"t": 1_700_000_060_000, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 200},
        ]
    }
    monkeypatch.setattr(provider, "_get", lambda *a, **k: payload)
    bars = provider.get_bars("AAPL", limit=10)
    assert [bar.close for bar in bars] == [1.5, 2.0]
    assert bars[0].vwap == pytest.approx(1.4)
    assert bars[1].vwap is None


def test_polygon_free_tier_is_flagged_as_delayed():
    assert PolygonData("key").info.realtime_quotes is False
    assert PolygonData("key", realtime=True).info.realtime_quotes is True


def test_alphavantage_reports_throttling_as_an_error(monkeypatch):
    provider = AlphaVantageData("key")
    monkeypatch.setattr(
        "trading_bot.marketdata.providers.get_json",
        lambda *a, **k: {"Information": "rate limit reached"},
    )
    with pytest.raises(MarketDataError, match="rate limit"):
        provider.get_bars("AAPL")


def test_alphavantage_never_pretends_to_have_a_spread():
    provider = AlphaVantageData("key")
    assert provider.info.has_bid_ask is False
    assert provider.get_latest_quote("AAPL") is None


def test_providers_require_an_api_key():
    with pytest.raises(MarketDataError):
        PolygonData("")
    with pytest.raises(MarketDataError):
        AlphaVantageData("")


# ------------------------------------------------------------- rate limiter
def test_rate_limiter_allows_the_budget_then_waits():
    slept: list[float] = []
    clock = {"now": 0.0}
    limiter = RateLimiter(3)

    def sleep(seconds):
        slept.append(seconds)
        clock["now"] += seconds

    for _ in range(3):
        assert limiter.acquire(sleep=sleep, now=lambda: clock["now"]) == 0.0
    waited = limiter.acquire(sleep=sleep, now=lambda: clock["now"])
    assert waited > 0
    assert slept and slept[0] == pytest.approx(60.05, abs=0.1)


def test_alpaca_provider_wraps_broker_errors(broker: FakeBroker):
    from trading_bot.brokers.base import BrokerError

    def explode(*_args, **_kwargs):
        raise BrokerError("boom")

    broker.get_bars = explode
    with pytest.raises(MarketDataError):
        AlpacaData(broker).get_bars("AAPL")

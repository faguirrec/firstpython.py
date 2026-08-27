"""Concrete market-data providers: Alpaca, Polygon (Massive) and Alpha Vantage.

Free-tier reality as of the 2026 pilot, which is why the defaults are what they
are:

* **Alpaca Basic** - free, real-time, but only the IEX feed (a few percent of
  consolidated volume). SIP costs $99/month.
* **Polygon.io / Massive** - free tier is 5 requests/minute and 15-minute
  delayed; real-time stock feeds start well above the pilot's entire capital.
* **Alpha Vantage** - free tier is 25 requests *per day* and its quote endpoint
  carries no bid/ask at all, so it cannot price a limit order.

At $30 of capital, none of the paid upgrades pay for themselves. The abstraction
exists so that decision can be revisited without touching the strategy code.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..brokers.base import Bar, BrokerError, Quote
from ..clock import to_utc, utcnow
from ..logging_setup import get_logger
from .base import MarketDataError, ProviderInfo, RateLimiter, get_json, timeframe_parts

log = get_logger(__name__)


class AlpacaData:
    """The execution broker doubling as the data source (Basic/IEX feed)."""

    def __init__(self, broker: Any, *, feed: str = "iex") -> None:
        self.broker = broker
        self.info = ProviderInfo(
            name=f"alpaca:{feed}",
            realtime_quotes=True,
            realtime_bars=True,
            requests_per_minute=180,
            has_bid_ask=True,
            monthly_cost_note="Basic gratis (IEX); SIP completo en Algo Trader Plus ~$99/mes.",
            caveat=(
                "IEX cubre una fracción del volumen consolidado: el spread visto puede ser "
                "más ancho que el NBBO real, lo que hace el filtro de EV más conservador, "
                "no más permisivo."
                if feed == "iex"
                else ""
            ),
        )

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        try:
            return self.broker.get_bars(symbol, limit=limit, timeframe=timeframe)
        except BrokerError as exc:
            raise MarketDataError(str(exc)) from exc

    def get_latest_quote(self, symbol: str) -> Quote | None:
        try:
            return self.broker.get_latest_quote(symbol)
        except BrokerError as exc:
            raise MarketDataError(str(exc)) from exc

    def get_latest_price(self, symbol: str) -> float | None:
        try:
            return self.broker.get_latest_price(symbol)
        except BrokerError as exc:
            raise MarketDataError(str(exc)) from exc


class PolygonData:
    """Polygon.io (now Massive) aggregates and NBBO quotes.

    On the free tier the data is 15 minutes delayed, so ``realtime_quotes`` is
    False and :class:`MarketData` will refuse to price orders from it.
    """

    BASE = "https://api.polygon.io"

    def __init__(self, api_key: str, *, realtime: bool = False, requests_per_minute: int = 5) -> None:
        if not api_key:
            raise MarketDataError("POLYGON/MARKET_DATA_API_KEY is required for the polygon provider.")
        self.api_key = api_key
        self.limiter = RateLimiter(requests_per_minute)
        self.info = ProviderInfo(
            name="polygon",
            realtime_quotes=realtime,
            realtime_bars=realtime,
            requests_per_minute=requests_per_minute,
            has_bid_ask=True,
            monthly_cost_note="Gratis: 5 req/min y 15 min de retraso. Tiempo real desde ~$199/mes.",
            caveat=(
                ""
                if realtime
                else "Plan gratuito con 15 minutos de retraso: sirve para barras, no para fijar precios."
            ),
        )

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        self.limiter.acquire()
        query = {**(params or {}), "apiKey": self.api_key}
        import urllib.parse

        return get_json(f"{self.BASE}{path}?{urllib.parse.urlencode(query)}")

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        amount, unit = timeframe_parts(timeframe)
        span_days = {"minute": max(5, limit // 26 + 5), "hour": 60, "day": limit + 40, "week": 400}[unit]
        end = utcnow()
        start = end - timedelta(days=span_days)
        payload = self._get(
            f"/v2/aggs/ticker/{symbol.upper()}/range/{amount}/{unit}/"
            f"{start.date().isoformat()}/{end.date().isoformat()}",
            {"adjusted": "true", "sort": "asc", "limit": max(limit * 2, 500)},
        )
        results = (payload or {}).get("results") or []
        bars = [
            Bar(
                timestamp=datetime.fromtimestamp(row["t"] / 1000, tz=timezone.utc),
                open=float(row.get("o", 0.0)),
                high=float(row.get("h", 0.0)),
                low=float(row.get("l", 0.0)),
                close=float(row.get("c", 0.0)),
                volume=float(row.get("v", 0.0)),
                vwap=float(row["vw"]) if row.get("vw") else None,
            )
            for row in results
        ]
        return bars[-limit:]

    def get_latest_quote(self, symbol: str) -> Quote | None:
        payload = self._get(f"/v2/last/nbbo/{symbol.upper()}")
        results = (payload or {}).get("results") or {}
        bid = float(results.get("p", 0.0) or 0.0)
        ask = float(results.get("P", 0.0) or 0.0)
        if bid <= 0 and ask <= 0:
            return None
        stamp = results.get("t")
        return Quote(
            symbol=symbol.upper(),
            bid=bid,
            ask=ask,
            timestamp=datetime.fromtimestamp(stamp / 1e9, tz=timezone.utc) if stamp else None,
        )

    def get_latest_price(self, symbol: str) -> float | None:
        quote = self.get_latest_quote(symbol)
        if quote is not None and quote.mid > 0:
            return quote.mid
        bars = self.get_bars(symbol, limit=1, timeframe="1Min")
        return bars[-1].close if bars else None


class AlphaVantageData:
    """Alpha Vantage intraday/daily series.

    Its ``GLOBAL_QUOTE`` endpoint returns a last price with **no bid/ask**, so
    this provider can never price a limit order, free tier or paid.
    """

    BASE = "https://www.alphavantage.co/query"

    def __init__(self, api_key: str, *, requests_per_minute: int = 5, daily_budget: int = 25) -> None:
        if not api_key:
            raise MarketDataError("MARKET_DATA_API_KEY is required for the alphavantage provider.")
        self.api_key = api_key
        self.daily_budget = daily_budget
        self.limiter = RateLimiter(requests_per_minute)
        self.info = ProviderInfo(
            name="alphavantage",
            realtime_quotes=False,
            realtime_bars=False,
            requests_per_minute=requests_per_minute,
            has_bid_ask=False,
            monthly_cost_note="Gratis: 25 peticiones por DÍA. Tiempo real desde ~$99,99/mes.",
            caveat=(
                "Sin bid/ask y con 25 peticiones diarias: alcanza para backtesting o un "
                "universo mínimo, no para un ciclo de 15 minutos sobre varios símbolos."
            ),
        )

    def _get(self, params: dict[str, Any]) -> Any:
        self.limiter.acquire()
        import urllib.parse

        payload = get_json(
            f"{self.BASE}?{urllib.parse.urlencode({**params, 'apikey': self.api_key})}"
        )
        if isinstance(payload, dict):
            # Alpha Vantage reports throttling with HTTP 200 and a prose body.
            for key in ("Note", "Information", "Error Message"):
                if key in payload:
                    raise MarketDataError(f"alphavantage: {payload[key]}")
        return payload

    def get_bars(self, symbol: str, *, limit: int = 120, timeframe: str = "15Min") -> list[Bar]:
        amount, unit = timeframe_parts(timeframe)
        if unit == "day":
            payload = self._get(
                {"function": "TIME_SERIES_DAILY", "symbol": symbol.upper(),
                 "outputsize": "full" if limit > 100 else "compact"}
            )
            series_key = "Time Series (Daily)"
        else:
            interval = {1: "1min", 5: "5min", 15: "15min", 30: "30min", 60: "60min"}.get(
                amount if unit == "minute" else amount * 60, "15min"
            )
            payload = self._get(
                {"function": "TIME_SERIES_INTRADAY", "symbol": symbol.upper(),
                 "interval": interval, "outputsize": "full" if limit > 100 else "compact"}
            )
            series_key = f"Time Series ({interval})"

        series = (payload or {}).get(series_key) or {}
        bars = []
        for stamp, row in sorted(series.items()):
            bars.append(
                Bar(
                    timestamp=to_utc(datetime.fromisoformat(stamp)),
                    open=float(row.get("1. open", 0.0)),
                    high=float(row.get("2. high", 0.0)),
                    low=float(row.get("3. low", 0.0)),
                    close=float(row.get("4. close", 0.0)),
                    volume=float(row.get("5. volume", 0.0)),
                )
            )
        return bars[-limit:]

    def get_latest_quote(self, symbol: str) -> Quote | None:
        # No bid/ask available at any tier: say so rather than fake a spread.
        return None

    def get_latest_price(self, symbol: str) -> float | None:
        payload = self._get({"function": "GLOBAL_QUOTE", "symbol": symbol.upper()})
        price = ((payload or {}).get("Global Quote") or {}).get("05. price")
        if price:
            return float(price)
        bars = self.get_bars(symbol, limit=1)
        return bars[-1].close if bars else None

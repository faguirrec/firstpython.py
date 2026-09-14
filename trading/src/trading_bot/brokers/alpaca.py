"""Alpaca adapter (Trading API + Market Data API + News API).

``alpaca-py`` is imported lazily so the rest of the system - and the whole test
suite - runs without the SDK or network access installed.

Fractional-share caveats baked in here, because they bite with $30 of capital:

* Alpaca accepts fractional quantities on **market and limit** orders, but only
  with ``time_in_force='day'``; anything else is silently a whole-share order.
* Fractional orders are **not** accepted outside regular market hours, so
  extended-hours execution is refused rather than sent and rejected.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

from ..clock import local_session, to_utc, utcnow
from ..logging_setup import get_logger
from ..retry import with_retries
from .base import AccountSnapshot, Bar, BrokerError, NewsArticle, OrderResult, Position, Quote

log = get_logger(__name__)

# Alpaca's published limit is 200 requests/minute per account on the basic plan.
MAX_REQUESTS_PER_MINUTE = 180


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"true", "1", "yes"}


def _status_name(status: Any) -> str:
    raw = getattr(status, "value", status)
    return str(raw).lower().replace("orderstatus.", "")


class _Throttle:
    """Client-side rate limiter so we never earn a 429."""

    def __init__(self, max_per_minute: int = MAX_REQUESTS_PER_MINUTE) -> None:
        self.max_per_minute = max_per_minute
        self._calls: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self, *, sleep=time.sleep, now=time.monotonic) -> None:
        """Block until a request slot frees up.

        A loop, not recursion: under sustained saturation each wait is ~60s of
        real time, and recursing would eventually raise RecursionError instead of
        simply waiting.
        """
        while True:
            with self._lock:
                current = now()
                while self._calls and current - self._calls[0] > 60.0:
                    self._calls.popleft()
                if len(self._calls) < self.max_per_minute:
                    self._calls.append(current)
                    return
                wait = 60.0 - (current - self._calls[0]) + 0.05
            sleep(max(wait, 0.0))


class AlpacaBroker:
    """Concrete :class:`~trading_bot.brokers.base.Broker` backed by Alpaca."""

    def __init__(
        self,
        api_key: str,
        secret_key: str,
        *,
        base_url: str = "https://paper-api.alpaca.markets",
        feed: str = "iex",
        retry_attempts: int = 4,
    ) -> None:
        if not api_key or not secret_key:
            raise BrokerError("Alpaca credentials are missing (ALPACA_API_KEY / ALPACA_SECRET_KEY).")
        self.api_key = api_key
        self.secret_key = secret_key
        self.base_url = base_url.rstrip("/")
        self.paper = "paper" in self.base_url
        self.feed = feed
        self.retry_attempts = retry_attempts
        self._throttle = _Throttle()
        self._trading: Any = None
        self._data: Any = None
        self._news: Any = None
        self._sdk: dict[str, Any] = {}

    # ------------------------------------------------------------------ clients
    def _load_sdk(self) -> dict[str, Any]:
        if self._sdk:
            return self._sdk
        try:
            from alpaca.data.historical import StockHistoricalDataClient
            from alpaca.data.historical.news import NewsClient
            from alpaca.data.requests import NewsRequest, StockBarsRequest, StockLatestQuoteRequest
            from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
            from alpaca.trading.client import TradingClient
            from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
            from alpaca.trading.requests import GetOrdersRequest, LimitOrderRequest
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise BrokerError(
                "alpaca-py is not installed. Run `pip install -r requirements.txt`."
            ) from exc
        self._sdk = {
            "StockHistoricalDataClient": StockHistoricalDataClient,
            "NewsClient": NewsClient,
            "NewsRequest": NewsRequest,
            "StockBarsRequest": StockBarsRequest,
            "StockLatestQuoteRequest": StockLatestQuoteRequest,
            "TimeFrame": TimeFrame,
            "TimeFrameUnit": TimeFrameUnit,
            "TradingClient": TradingClient,
            "OrderSide": OrderSide,
            "TimeInForce": TimeInForce,
            "QueryOrderStatus": QueryOrderStatus,
            "GetOrdersRequest": GetOrdersRequest,
            "LimitOrderRequest": LimitOrderRequest,
        }
        return self._sdk

    @property
    def trading(self) -> Any:
        if self._trading is None:
            sdk = self._load_sdk()
            self._trading = sdk["TradingClient"](
                api_key=self.api_key, secret_key=self.secret_key, paper=self.paper
            )
        return self._trading

    @property
    def data(self) -> Any:
        if self._data is None:
            sdk = self._load_sdk()
            self._data = sdk["StockHistoricalDataClient"](
                api_key=self.api_key, secret_key=self.secret_key
            )
        return self._data

    @property
    def news_client(self) -> Any:
        if self._news is None:
            sdk = self._load_sdk()
            self._news = sdk["NewsClient"](api_key=self.api_key, secret_key=self.secret_key)
        return self._news

    def _call(self, description: str, func):
        """Throttled + retried SDK call. Wraps SDK failures in BrokerError."""

        def invoke():
            self._throttle.acquire()
            return func()

        try:
            return with_retries(
                invoke, attempts=self.retry_attempts, base=1.0, cap=16.0, description=description
            )
        except BrokerError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalise every SDK failure
            raise BrokerError(f"{description} failed: {exc}") from exc

    # ------------------------------------------------------------------ account
    def get_account(self) -> AccountSnapshot:
        account = self._call("get_account", self.trading.get_account)
        raw = _as_dict(account)
        return AccountSnapshot(
            equity=_to_float(raw.get("equity")),
            cash=_to_float(raw.get("cash")),
            buying_power=_to_float(raw.get("buying_power")),
            non_marginable_buying_power=_to_float(raw.get("non_marginable_buying_power")),
            portfolio_value=_to_float(raw.get("portfolio_value") or raw.get("equity")),
            daytrade_count=int(_to_float(raw.get("daytrade_count"))),
            pattern_day_trader=_to_bool(raw.get("pattern_day_trader")),
            trading_blocked=_to_bool(raw.get("trading_blocked")),
            account_blocked=_to_bool(raw.get("account_blocked")),
            transfers_blocked=_to_bool(raw.get("transfers_blocked")),
            shorting_enabled=_to_bool(raw.get("shorting_enabled")),
            multiplier=_to_float(raw.get("multiplier"), 1.0),
            currency=str(raw.get("currency") or "USD"),
            raw=raw,
        )

    def get_positions(self) -> list[Position]:
        positions = self._call("get_all_positions", self.trading.get_all_positions)
        return [_position_from(_as_dict(p)) for p in positions or []]

    def get_position(self, symbol: str) -> Position | None:
        for position in self.get_positions():
            if position.symbol == symbol.upper():
                return position
        return None

    # --------------------------------------------------------------- market data
    def get_bars(
        self,
        symbol: str,
        *,
        limit: int = 120,
        timeframe: str = "15Min",
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[Bar]:
        """Historical bars. ``start``/``end`` override the derived window."""
        sdk = self._load_sdk()
        tf = _timeframe(timeframe, sdk)
        window_start = to_utc(start) if start else utcnow() - timedelta(
            days=lookback_days(limit, timeframe)
        )
        request = sdk["StockBarsRequest"](
            symbol_or_symbols=symbol.upper(),
            timeframe=tf,
            start=window_start,
            end=to_utc(end) if end else None,
            limit=limit,
            feed=self.feed,
        )
        payload = self._call(f"get_stock_bars[{symbol}]", lambda: self.data.get_stock_bars(request))
        rows = _extract_series(payload, symbol.upper())
        bars = [
            Bar(
                timestamp=to_utc(_as_datetime(row.get("timestamp"))),
                open=_to_float(row.get("open")),
                high=_to_float(row.get("high")),
                low=_to_float(row.get("low")),
                close=_to_float(row.get("close")),
                volume=_to_float(row.get("volume")),
                vwap=_to_float(row.get("vwap")) or None,
            )
            for row in rows
        ]
        bars.sort(key=lambda bar: bar.timestamp)
        return bars[-limit:]

    def get_latest_quote(self, symbol: str) -> Quote | None:
        sdk = self._load_sdk()
        request = sdk["StockLatestQuoteRequest"](symbol_or_symbols=symbol.upper(), feed=self.feed)
        payload = self._call(
            f"get_stock_latest_quote[{symbol}]", lambda: self.data.get_stock_latest_quote(request)
        )
        quote = payload.get(symbol.upper()) if isinstance(payload, dict) else payload
        if quote is None:
            return None
        raw = _as_dict(quote)
        return Quote(
            symbol=symbol.upper(),
            bid=_to_float(raw.get("bid_price")),
            ask=_to_float(raw.get("ask_price")),
            timestamp=_as_datetime(raw.get("timestamp")),
        )

    def get_latest_price(self, symbol: str) -> float | None:
        quote = self.get_latest_quote(symbol)
        if quote is not None and quote.mid > 0:
            return quote.mid
        bars = self.get_bars(symbol, limit=1, timeframe="1Min")
        return bars[-1].close if bars else None

    # -------------------------------------------------------------------- orders
    def submit_limit_order(
        self,
        symbol: str,
        side: str,
        *,
        quantity: float,
        limit_price: float,
        time_in_force: str = "day",
        extended_hours: bool = False,
        client_order_id: str | None = None,
    ) -> OrderResult:
        sdk = self._load_sdk()
        is_fractional = abs(quantity - round(quantity)) > 1e-9
        if is_fractional:
            if extended_hours:
                raise BrokerError("Alpaca rejects fractional orders outside regular market hours.")
            if time_in_force != "day":
                # Fractional fills require TIF day; silently upgrading is safer than a rejection.
                log.warning(
                    "forcing_tif_day_for_fractional",
                    extra={"event": {"symbol": symbol, "requested_tif": time_in_force}},
                )
                time_in_force = "day"

        request = sdk["LimitOrderRequest"](
            symbol=symbol.upper(),
            qty=round(quantity, 9),
            side=sdk["OrderSide"](side.lower()),
            time_in_force=sdk["TimeInForce"](time_in_force.lower()),
            limit_price=round(limit_price, 2),
            extended_hours=extended_hours,
            client_order_id=client_order_id,
        )
        order = self._call(
            f"submit_order[{symbol} {side} {quantity}]", lambda: self.trading.submit_order(request)
        )
        return _order_from(_as_dict(order))

    def get_order(self, broker_order_id: str) -> OrderResult | None:
        order = self._call(
            f"get_order[{broker_order_id}]",
            lambda: self.trading.get_order_by_id(broker_order_id),
        )
        return _order_from(_as_dict(order)) if order is not None else None

    def get_order_by_client_id(self, client_order_id: str) -> OrderResult | None:
        """Find an order by the id we generated before submitting it.

        This is the recovery path after a crash between writing the local row and
        the broker replying: the client id is deterministic, so the order can be
        adopted instead of orphaned.
        """
        try:
            order = self._call(
                f"get_order_by_client_id[{client_order_id}]",
                lambda: self.trading.get_order_by_client_id(client_order_id),
            )
        except BrokerError:
            # Alpaca answers 404 for an order that never landed; that is a
            # legitimate answer here, not a failure.
            return None
        return _order_from(_as_dict(order)) if order is not None else None

    def cancel_order(self, broker_order_id: str) -> None:
        self._call(
            f"cancel_order[{broker_order_id}]",
            lambda: self.trading.cancel_order_by_id(broker_order_id),
        )

    def cancel_all_orders(self) -> None:
        self._call("cancel_orders", self.trading.cancel_orders)

    def close_position(self, symbol: str) -> None:
        self._call(f"close_position[{symbol}]", lambda: self.trading.close_position(symbol.upper()))

    def close_all_positions(self, *, cancel_orders: bool = True) -> None:
        self._call(
            "close_all_positions",
            lambda: self.trading.close_all_positions(cancel_orders=cancel_orders),
        )

    # ------------------------------------------------------------------- session
    def session(self) -> str:
        """Market session per the broker clock, falling back to the local calendar."""
        try:
            clock = _as_dict(self._call("get_clock", self.trading.get_clock))
        except BrokerError:
            return local_session()
        if _to_bool(clock.get("is_open")):
            return "open"
        return local_session()

    def is_market_open(self) -> bool:
        return self.session() == "open"

    # ---------------------------------------------------------------------- news
    def get_news(
        self, *, symbols: Sequence[str], since: datetime | None = None, limit: int = 50
    ) -> list[NewsArticle]:
        sdk = self._load_sdk()
        request = sdk["NewsRequest"](
            symbols=",".join(s.upper() for s in symbols) if symbols else None,
            start=to_utc(since) if since else utcnow() - timedelta(hours=6),
            limit=min(limit, 50),
            include_content=False,
            exclude_contentless=True,
        )
        payload = self._call("get_news", lambda: self.news_client.get_news(request))
        raw_items = _extract_news(payload)
        articles: list[NewsArticle] = []
        for item in raw_items:
            row = _as_dict(item)
            articles.append(
                NewsArticle(
                    external_id=str(row.get("id") or row.get("news_id") or ""),
                    headline=str(row.get("headline") or ""),
                    summary=str(row.get("summary") or ""),
                    url=str(row.get("url") or ""),
                    author=str(row.get("author") or ""),
                    source=str(row.get("source") or "alpaca"),
                    symbols=tuple(str(s).upper() for s in (row.get("symbols") or [])),
                    published_at=_as_datetime(row.get("created_at") or row.get("updated_at")),
                )
            )
        return articles


# --------------------------------------------------------------------- helpers
def _as_dict(obj: Any) -> dict[str, Any]:
    """Normalise an SDK model (pydantic or plain object) into a dict."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return {str(k): v for k, v in obj.items()}
    for attr in ("model_dump", "dict", "_asdict"):
        method = getattr(obj, attr, None)
        if callable(method):
            try:
                return {str(k): v for k, v in method().items()}
            except Exception:  # noqa: BLE001 - fall through to __dict__
                break
    return {k: v for k, v in vars(obj).items() if not k.startswith("_")}


def _as_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return to_utc(value)
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return to_utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def lookback_days(limit: int, timeframe: str) -> int:
    """Calendar days to request so ``limit`` bars of ``timeframe`` come back.

    The window has to know the timeframe. A fixed ~26-bars-per-day assumption is
    right for 15-minute bars and badly wrong for daily ones: asking for 1,700
    daily bars would have requested 70 days and returned about 48, so a "backtest
    from 2020" would silently have run on two months of data.
    """
    amount, unit = _timeframe_parts(timeframe)
    amount = max(amount, 1)
    if unit == "day":
        bars_per_day = 1 / amount
    elif unit == "week":
        bars_per_day = 1 / (5 * amount)
    elif unit == "hour":
        bars_per_day = 6.5 / amount
    else:
        bars_per_day = 390 / amount
    trading_days = max(limit / bars_per_day, 1)
    # ~252 trading days per 365 calendar days, plus a buffer for holidays.
    return int(trading_days * 365 / 252) + 7


def _timeframe_parts(spec: str) -> tuple[int, str]:
    text = spec.strip().lower()
    digits = "".join(ch for ch in text if ch.isdigit()) or "1"
    amount = int(digits)
    for unit in ("day", "hour", "week"):
        if unit in text:
            return amount, unit
    return amount, "minute"


def _timeframe(spec: str, sdk: dict[str, Any]) -> Any:
    """Translate '15Min' / '1Hour' / '1Day' into an SDK TimeFrame."""
    TimeFrame = sdk["TimeFrame"]
    TimeFrameUnit = sdk["TimeFrameUnit"]
    text = spec.strip().lower()
    digits = "".join(ch for ch in text if ch.isdigit()) or "1"
    amount = int(digits)
    if "day" in text:
        return TimeFrame(amount, TimeFrameUnit.Day)
    if "hour" in text:
        return TimeFrame(amount, TimeFrameUnit.Hour)
    if "week" in text:
        return TimeFrame(amount, TimeFrameUnit.Week)
    return TimeFrame(amount, TimeFrameUnit.Minute)


def _extract_series(payload: Any, symbol: str) -> list[dict[str, Any]]:
    """Pull the per-symbol bar list out of whatever shape the SDK returned."""
    if payload is None:
        return []
    data = getattr(payload, "data", None)
    if isinstance(data, dict):
        return [_as_dict(bar) for bar in data.get(symbol, [])]
    if isinstance(payload, dict):
        bucket = payload.get(symbol, payload.get("bars", []))
        if isinstance(bucket, dict):
            bucket = bucket.get(symbol, [])
        return [_as_dict(bar) for bar in bucket or []]
    return [_as_dict(bar) for bar in payload or []]


def _extract_news(payload: Any) -> list[Any]:
    if payload is None:
        return []
    data = getattr(payload, "data", None)
    if isinstance(data, dict):
        items: list[Any] = []
        for value in data.values():
            items.extend(value or [])
        return items
    if isinstance(payload, dict):
        return list(payload.get("news", []) or [])
    return list(payload)


def _position_from(raw: dict[str, Any]) -> Position:
    return Position(
        symbol=str(raw.get("symbol", "")).upper(),
        quantity=_to_float(raw.get("qty")),
        avg_entry_price=_to_float(raw.get("avg_entry_price")),
        market_value=_to_float(raw.get("market_value")),
        current_price=_to_float(raw.get("current_price")),
        unrealized_pl=_to_float(raw.get("unrealized_pl")),
        unrealized_plpc=_to_float(raw.get("unrealized_plpc")),
        side=str(getattr(raw.get("side"), "value", raw.get("side")) or "long").lower(),
        raw=raw,
    )


def _order_from(raw: dict[str, Any]) -> OrderResult:
    return OrderResult(
        broker_order_id=str(raw.get("id") or raw.get("client_order_id") or ""),
        symbol=str(raw.get("symbol", "")).upper(),
        side=str(getattr(raw.get("side"), "value", raw.get("side")) or "").lower(),
        quantity=_to_float(raw.get("qty")),
        status=_status_name(raw.get("status")),
        limit_price=_to_float(raw.get("limit_price")) or None,
        filled_qty=_to_float(raw.get("filled_qty")),
        filled_avg_price=_to_float(raw.get("filled_avg_price")) or None,
        submitted_at=_as_datetime(raw.get("submitted_at") or raw.get("created_at")),
        raw={k: str(v) for k, v in raw.items()},
    )

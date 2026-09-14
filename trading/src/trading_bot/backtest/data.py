"""Historical bar loaders for backtesting.

Three free sources, in order of preference for the pilot:

* **Alpaca** - the same account already used for trading; years of history on
  the Basic plan, and the same feed the live bot will see.
* **CSV** - anything already on disk (``timestamp,open,high,low,close,volume``).
* **yfinance** - convenient for a quick multi-year sweep. Yahoo's data has
  known gaps and subtle delays, which is tolerable for backtesting and not for
  production; the loader says so out loud.
"""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

from ..brokers.base import Bar
from ..clock import to_utc, utcnow
from ..logging_setup import get_logger

log = get_logger(__name__)


def load_csv(path: str | Path) -> list[Bar]:
    """Load bars from a CSV with a header row.

    Recognised columns: ``timestamp`` (or ``date``/``time``), ``open``,
    ``high``, ``low``, ``close``, ``volume``.
    """
    rows: list[Bar] = []
    with Path(path).open(newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            lowered = {str(k).strip().lower(): v for k, v in record.items() if k}
            stamp = lowered.get("timestamp") or lowered.get("date") or lowered.get("time")
            if not stamp:
                continue
            moment = _parse_stamp(str(stamp))
            if moment is None:
                continue
            rows.append(
                Bar(
                    timestamp=moment,
                    open=float(lowered.get("open") or 0.0),
                    high=float(lowered.get("high") or 0.0),
                    low=float(lowered.get("low") or 0.0),
                    close=float(lowered.get("close") or 0.0),
                    volume=float(lowered.get("volume") or 0.0),
                )
            )
    rows.sort(key=lambda bar: bar.timestamp)
    return rows


def load_from_broker(
    broker: Any,
    symbol: str,
    *,
    timeframe: str = "1Day",
    limit: int = 750,
    start: datetime | None = None,
    end: datetime | None = None,
) -> list[Bar]:
    """Historical bars from the Alpaca account already configured."""
    if start is None and end is None:
        return broker.get_bars(symbol, limit=limit, timeframe=timeframe)
    return broker.get_bars(symbol, limit=limit, timeframe=timeframe, start=start, end=end)


def load_yfinance(
    symbol: str, *, timeframe: str = "1Day", days: int = 730
) -> list[Bar]:
    """Historical bars from Yahoo Finance (optional dependency).

    Intraday history on Yahoo is capped at roughly 60 days; daily bars go back
    years. Suitable for backtesting only.
    """
    try:
        import yfinance
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "yfinance no está instalado. `pip install yfinance` o usa --source alpaca/csv."
        ) from exc

    interval = {"1day": "1d", "1hour": "1h", "1week": "1wk"}.get(
        timeframe.lower(), "15m" if "min" in timeframe.lower() else "1d"
    )
    frame = yfinance.download(
        symbol,
        start=(utcnow() - timedelta(days=days)).date().isoformat(),
        interval=interval,
        auto_adjust=True,
        progress=False,
    )
    bars: list[Bar] = []
    for stamp, row in frame.iterrows():
        bars.append(
            Bar(
                timestamp=to_utc(stamp.to_pydatetime()),
                open=float(_cell(row, "Open")),
                high=float(_cell(row, "High")),
                low=float(_cell(row, "Low")),
                close=float(_cell(row, "Close")),
                volume=float(_cell(row, "Volume")),
            )
        )
    return bars


def load_bars(
    symbols: Sequence[str],
    *,
    source: str = "alpaca",
    broker: Any | None = None,
    timeframe: str = "1Day",
    limit: int = 750,
    days: int = 730,
    csv_dir: str | Path | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> dict[str, list[Bar]]:
    """Load bars for every symbol from the chosen source."""
    out: dict[str, list[Bar]] = {}
    for symbol in symbols:
        key = symbol.upper()
        try:
            if source == "csv":
                directory = Path(csv_dir or ".")
                bars = load_csv(directory / f"{key}.csv")
                out[key] = _clip(bars, start, end)
            elif source == "yfinance":
                span = days if start is None else (utcnow() - to_utc(start)).days + 1
                out[key] = _clip(load_yfinance(key, timeframe=timeframe, days=span), start, end)
            else:
                if broker is None:
                    raise RuntimeError("source='alpaca' requiere un broker configurado.")
                out[key] = load_from_broker(
                    broker, key, timeframe=timeframe, limit=limit, start=start, end=end
                )
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not stop the run
            log.warning("bars_load_failed", extra={"event": {"symbol": key, "error": str(exc)}})
            continue
        log.info("bars_loaded", extra={"event": {"symbol": key, "bars": len(out[key])}})
    return {symbol: bars for symbol, bars in out.items() if bars}


def _clip(bars: list[Bar], start: datetime | None, end: datetime | None) -> list[Bar]:
    """Restrict a series to an explicit date range."""
    if start is not None:
        floor = to_utc(start)
        bars = [bar for bar in bars if bar.timestamp >= floor]
    if end is not None:
        ceiling = to_utc(end)
        bars = [bar for bar in bars if bar.timestamp <= ceiling]
    return bars


def _cell(row: Any, name: str) -> float:
    value = row.get(name)
    # yfinance returns a Series per column when several tickers are requested.
    if hasattr(value, "iloc"):
        value = value.iloc[0]
    return 0.0 if value is None else float(value)


def _parse_stamp(text: str) -> datetime | None:
    cleaned = text.strip().replace("Z", "+00:00")
    for parse in (
        lambda v: datetime.fromisoformat(v),
        lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S"),
        lambda v: datetime.strptime(v, "%Y-%m-%d"),
        lambda v: datetime.fromtimestamp(float(v), tz=timezone.utc),
    ):
        try:
            return to_utc(parse(cleaned))
        except (ValueError, OverflowError, OSError):
            continue
    return None

"""Time helpers.

All persisted timestamps are UTC ISO-8601 strings; market-session questions are
answered in US/Eastern because that is what the exchanges use.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MARKET_TZ = ZoneInfo("America/New_York")

REGULAR_OPEN = time(9, 30)
REGULAR_CLOSE = time(16, 0)
PREMARKET_OPEN = time(4, 0)
AFTERHOURS_CLOSE = time(20, 0)

# US equity market holidays for the pilot window. Alpaca's calendar endpoint is
# authoritative; this list is the offline fallback used by `local_session`.
STATIC_HOLIDAYS: frozenset[date] = frozenset(
    {
        date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3),
        date(2026, 5, 25), date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7),
        date(2026, 11, 26), date(2026, 12, 25),
        date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26),
        date(2027, 5, 31), date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6),
        date(2027, 11, 25), date(2027, 12, 24),
    }
)


def utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def to_utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def iso(moment: datetime | None = None) -> str:
    return to_utc(moment or utcnow()).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp, tolerating a trailing ``Z``."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return to_utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def market_now(moment: datetime | None = None) -> datetime:
    return to_utc(moment or utcnow()).astimezone(MARKET_TZ)


def is_business_day(day: date) -> bool:
    return day.weekday() < 5 and day not in STATIC_HOLIDAYS


def local_session(moment: datetime | None = None) -> str:
    """Classify a moment as ``closed``/``premarket``/``open``/``afterhours``.

    Offline fallback: `AlpacaBroker.session()` prefers the exchange calendar.
    """
    now = market_now(moment)
    if not is_business_day(now.date()):
        return "closed"
    clock = now.time()
    if REGULAR_OPEN <= clock < REGULAR_CLOSE:
        return "open"
    if PREMARKET_OPEN <= clock < REGULAR_OPEN:
        return "premarket"
    if REGULAR_CLOSE <= clock < AFTERHOURS_CLOSE:
        return "afterhours"
    return "closed"


def trading_day(moment: datetime | None = None) -> date:
    """The market date a moment belongs to (US/Eastern calendar date)."""
    return market_now(moment).date()


def next_business_day(day: date, offset: int = 1) -> date:
    """The business day ``offset`` sessions after ``day`` (T+1 settlement, etc.)."""
    current = day
    remaining = offset
    while remaining > 0:
        current += timedelta(days=1)
        if is_business_day(current):
            remaining -= 1
    return current


def business_days_between(start: date, end: date) -> int:
    """Count business days in ``(start, end]``; negative if ``end`` precedes."""
    if end < start:
        return -business_days_between(end, start)
    count = 0
    current = start
    while current < end:
        current += timedelta(days=1)
        if is_business_day(current):
            count += 1
    return count

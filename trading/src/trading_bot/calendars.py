"""Exchange trading calendars.

The bot runs 24/7, but *when it may execute* depends on the exchange it trades.
This module keeps that knowledge in one configurable place instead of hardcoding
one market's hours across the scheduler.

Sessions a calendar can report:

``open``
    Regular trading hours - the only session in which orders are placed.
``break``
    A scheduled intraday halt (the lunch break on Tokyo and Hong Kong). Treated
    exactly like a closed market for execution purposes.
``premarket`` / ``afterhours``
    Extended hours. Monitoring and news only by default: Alpaca rejects
    fractional orders outside regular hours, and liquidity is thin.
``closed``
    Weekend, holiday, or outside every window.

**The broker's own calendar is authoritative.** These profiles are the offline
fallback and the source of the scheduler's windows; ``AlpacaBroker.session()``
still prefers the exchange clock when it can reach it. Only US equities are
tradable through Alpaca today - the non-US profiles are here so monitoring
windows and reports are correct if the broker ever supports them, and their
hours should be re-verified against the exchange before being relied on.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .clock import to_utc, utcnow

# Session names, in the order execution permissiveness decreases.
OPEN = "open"
BREAK = "break"
PREMARKET = "premarket"
AFTERHOURS = "afterhours"
CLOSED = "closed"

EXECUTABLE_SESSIONS = frozenset({OPEN})
MONITORING_SESSIONS = frozenset({OPEN, BREAK, PREMARKET, AFTERHOURS})


@dataclass(frozen=True)
class Window:
    """A half-open local-time window ``[start, end)``."""

    start: time
    end: time

    def contains(self, moment: time) -> bool:
        return self.start <= moment < self.end

    def as_dict(self) -> dict[str, str]:
        return {"start": self.start.strftime("%H:%M"), "end": self.end.strftime("%H:%M")}


@dataclass(frozen=True)
class ExchangeCalendar:
    """Trading hours and holidays for one exchange."""

    code: str
    name: str
    timezone: str
    regular: tuple[Window, ...]
    premarket: Window | None = None
    afterhours: Window | None = None
    weekdays: tuple[int, ...] = (0, 1, 2, 3, 4)
    holidays: frozenset[date] = frozenset()
    # Holidays derived from rules, evaluated per year. A hardcoded table silently
    # expires; a rule keeps working without anyone remembering to edit it.
    holiday_rule: Callable[[int], frozenset[date]] | None = None
    currency: str = "USD"
    notes: str = ""

    # ------------------------------------------------------------------ basics
    @property
    def zone(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as exc:  # pragma: no cover - bad config
            raise ValueError(f"unknown timezone for {self.code}: {self.timezone}") from exc

    def local(self, moment: datetime | None = None) -> datetime:
        """``moment`` expressed in the exchange's own timezone."""
        return to_utc(moment or utcnow()).astimezone(self.zone)

    @property
    def open_time(self) -> time:
        return self.regular[0].start

    @property
    def close_time(self) -> time:
        return self.regular[-1].end

    def is_trading_day(self, day: date) -> bool:
        if day.weekday() not in self.weekdays:
            return False
        if day in self.holidays:
            return False
        if self.holiday_rule is not None and day in self.holiday_rule(day.year):
            return False
        return True

    def holidays_for(self, year: int) -> frozenset[date]:
        """Every holiday in ``year``, from the explicit set and the rule."""
        explicit = frozenset(day for day in self.holidays if day.year == year)
        if self.holiday_rule is None:
            return explicit
        return explicit | self.holiday_rule(year)

    def trading_date(self, moment: datetime | None = None) -> date:
        """The exchange-local calendar date a moment belongs to."""
        return self.local(moment).date()

    # ---------------------------------------------------------------- sessions
    def session(self, moment: datetime | None = None) -> str:
        """Classify a moment into one of the session names."""
        now = self.local(moment)
        if not self.is_trading_day(now.date()):
            return CLOSED
        clock = now.time()

        for window in self.regular:
            if window.contains(clock):
                return OPEN
        # Between two regular windows is a scheduled halt, not a closed market.
        if len(self.regular) > 1 and self.regular[0].end <= clock < self.regular[-1].start:
            return BREAK
        if self.premarket and self.premarket.contains(clock):
            return PREMARKET
        if self.afterhours and self.afterhours.contains(clock):
            return AFTERHOURS
        return CLOSED

    def is_open(self, moment: datetime | None = None) -> bool:
        return self.session(moment) == OPEN

    def may_execute(self, moment: datetime | None = None) -> bool:
        """Whether orders may be sent right now."""
        return self.session(moment) in EXECUTABLE_SESSIONS

    # ------------------------------------------------------------- navigation
    def next_business_day(self, day: date, offset: int = 1) -> date:
        current = day
        remaining = max(offset, 0)
        while remaining > 0:
            current += timedelta(days=1)
            if self.is_trading_day(current):
                remaining -= 1
        return current

    def business_days_between(self, start: date, end: date) -> int:
        """Trading days in ``(start, end]``; negative when ``end`` precedes."""
        if end < start:
            return -self.business_days_between(end, start)
        count = 0
        current = start
        while current < end:
            current += timedelta(days=1)
            if self.is_trading_day(current):
                count += 1
        return count

    def next_open(self, moment: datetime | None = None, *, horizon_days: int = 14) -> datetime | None:
        """The next moment the regular session opens, in UTC."""
        now = self.local(moment)
        for offset in range(horizon_days + 1):
            day = now.date() + timedelta(days=offset)
            if not self.is_trading_day(day):
                continue
            for window in self.regular:
                candidate = datetime.combine(day, window.start, tzinfo=self.zone)
                if candidate > now:
                    return candidate.astimezone(to_utc(now).tzinfo)
        return None

    def next_close(self, moment: datetime | None = None, *, horizon_days: int = 14) -> datetime | None:
        """The next moment the regular session closes, in UTC."""
        now = self.local(moment)
        for offset in range(horizon_days + 1):
            day = now.date() + timedelta(days=offset)
            if not self.is_trading_day(day):
                continue
            candidate = datetime.combine(day, self.close_time, tzinfo=self.zone)
            if candidate > now:
                return candidate.astimezone(to_utc(now).tzinfo)
        return None

    def seconds_until_open(self, moment: datetime | None = None) -> float | None:
        target = self.next_open(moment)
        if target is None:
            return None
        return (target - to_utc(moment or utcnow())).total_seconds()

    # ----------------------------------------------------------------- report
    def describe(self, moment: datetime | None = None) -> dict[str, Any]:
        now = self.local(moment)
        next_open = self.next_open(moment)
        next_close = self.next_close(moment)
        return {
            "code": self.code,
            "name": self.name,
            "timezone": self.timezone,
            "currency": self.currency,
            "local_time": now.isoformat(timespec="seconds"),
            "session": self.session(moment),
            "regular": [window.as_dict() for window in self.regular],
            "premarket": self.premarket.as_dict() if self.premarket else None,
            "afterhours": self.afterhours.as_dict() if self.afterhours else None,
            "trading_day": self.is_trading_day(now.date()),
            "next_open": next_open.isoformat() if next_open else None,
            "next_close": next_close.isoformat() if next_close else None,
            "holidays_this_year": sorted(
                day.isoformat() for day in self.holidays_for(now.year)
            ),
            "holiday_rule": getattr(self.holiday_rule, "__name__", None),
            "notes": self.notes,
        }

    def with_holidays(self, holidays: Iterable[date | str]) -> "ExchangeCalendar":
        """A copy with extra holidays merged in."""
        from dataclasses import replace

        merged = set(self.holidays) | {_as_date(day) for day in holidays}
        return replace(self, holidays=frozenset(day for day in merged if day is not None))


def _window(start: str, end: str) -> Window:
    return Window(_as_time(start), _as_time(end))


def _as_time(value: str | time) -> time:
    if isinstance(value, time):
        return value
    hour, _, minute = str(value).partition(":")
    return time(int(hour), int(minute or 0))


def _as_date(value: date | str | None) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        return None


# --------------------------------------------------------------------- holidays
def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    """The ``nth`` ``weekday`` of a month; ``nth=-1`` means the last one."""
    if nth > 0:
        first = date(year, month, 1)
        offset = (weekday - first.weekday()) % 7
        return first + timedelta(days=offset + 7 * (nth - 1))
    last_day = (date(year, month, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    offset = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=offset)


def _easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    lam = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * lam) // 451
    month, day = divmod(h + lam - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _observed(day: date) -> date:
    """NYSE observance: Saturday holidays move back, Sunday holidays move forward."""
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def us_market_holidays(year: int) -> set[date]:
    """US equity market holidays for a year, from the rules rather than a table.

    A hardcoded list silently expires: the day after its last year, every holiday
    becomes a trading day and the scheduler works through it. Computing them means
    the calendar keeps working in 2030 without anyone remembering to edit it.

    Not modelled: ad-hoc closures (national days of mourning, hurricanes) and
    early closes. The broker calendar remains authoritative for those.
    """
    return {
        _observed(date(year, 1, 1)),                        # New Year's Day
        _nth_weekday(year, 1, 0, 3),                        # MLK Jr. Day
        _nth_weekday(year, 2, 0, 3),                        # Washington's Birthday
        _easter(year) - timedelta(days=2),                  # Good Friday
        _nth_weekday(year, 5, 0, -1),                       # Memorial Day
        _observed(date(year, 6, 19)),                       # Juneteenth
        _observed(date(year, 7, 4)),                        # Independence Day
        _nth_weekday(year, 9, 0, 1),                        # Labor Day
        _nth_weekday(year, 11, 3, 4),                       # Thanksgiving
        _observed(date(year, 12, 25)),                      # Christmas Day
    }


@lru_cache(maxsize=64)
def us_holidays_observed_in(year: int) -> frozenset[date]:
    """US market holidays *observed* during ``year``.

    An observed holiday can land in a neighbouring year - New Year's Day 2028
    falls on a Saturday and is observed on 2027-12-31 - so three years are
    computed and filtered.
    """
    candidates = (
        us_market_holidays(year - 1) | us_market_holidays(year) | us_market_holidays(year + 1)
    )
    return frozenset(day for day in candidates if day.year == year)

CALENDARS: dict[str, ExchangeCalendar] = {
    "XNYS": ExchangeCalendar(
        code="XNYS",
        name="NYSE / Nasdaq (acciones y ETFs de EE.UU.)",
        timezone="America/New_York",
        regular=(_window("09:30", "16:00"),),
        premarket=_window("04:00", "09:30"),
        afterhours=_window("16:00", "20:00"),
        holiday_rule=us_holidays_observed_in,
        currency="USD",
        notes="El único mercado operable vía Alpaca. Órdenes fraccionarias solo en horario regular.",
    ),
    "XLON": ExchangeCalendar(
        code="XLON",
        name="London Stock Exchange",
        timezone="Europe/London",
        regular=(_window("08:00", "16:30"),),
        currency="GBP",
        notes="Perfil de referencia: verifica feriados y horarios antes de usarlo.",
    ),
    "XETR": ExchangeCalendar(
        code="XETR",
        name="Xetra (Frankfurt)",
        timezone="Europe/Berlin",
        regular=(_window("09:00", "17:30"),),
        currency="EUR",
        notes="Perfil de referencia: verifica feriados y horarios antes de usarlo.",
    ),
    "XTKS": ExchangeCalendar(
        code="XTKS",
        name="Tokyo Stock Exchange",
        timezone="Asia/Tokyo",
        # Two windows with a lunch break between them.
        regular=(_window("09:00", "11:30"), _window("12:30", "15:30")),
        currency="JPY",
        notes="Cierre 15:30 desde nov-2024. Pausa de almuerzo 11:30-12:30.",
    ),
    "XHKG": ExchangeCalendar(
        code="XHKG",
        name="Hong Kong Stock Exchange",
        timezone="Asia/Hong_Kong",
        regular=(_window("09:30", "12:00"), _window("13:00", "16:00")),
        currency="HKD",
        notes="Perfil de referencia: pausa de almuerzo 12:00-13:00.",
    ),
}

# Aliases so common spellings resolve to a profile.
ALIASES = {
    "US": "XNYS", "NYSE": "XNYS", "NASDAQ": "XNYS", "XNAS": "XNYS", "USA": "XNYS",
    "UK": "XLON", "LSE": "XLON", "LONDON": "XLON",
    "DE": "XETR", "FRANKFURT": "XETR", "XFRA": "XETR",
    "JP": "XTKS", "TOKYO": "XTKS", "TSE": "XTKS", "JPX": "XTKS",
    "HK": "XHKG", "HONGKONG": "XHKG",
}

DEFAULT_CALENDAR = "XNYS"


def resolve_code(code: str | None) -> str:
    key = (code or DEFAULT_CALENDAR).strip().upper()
    return ALIASES.get(key, key)


def get_calendar(code: str | None = None) -> ExchangeCalendar:
    """Look up a built-in profile by code or alias."""
    resolved = resolve_code(code)
    if resolved not in CALENDARS:
        known = ", ".join(sorted(CALENDARS))
        raise ValueError(f"calendario desconocido: {code!r}. Disponibles: {known}")
    return CALENDARS[resolved]


def calendar_from_dict(payload: Mapping[str, Any]) -> ExchangeCalendar:
    """Build a calendar from a plain mapping (JSON file or inline config).

    Expected shape::

        {"code": "XSGO", "name": "Bolsa de Santiago",
         "timezone": "America/Santiago",
         "regular": [["09:30", "16:00"]],
         "premarket": ["09:00", "09:30"],
         "weekdays": [0, 1, 2, 3, 4],
         "holidays": ["2026-09-18", "2026-09-19"],
         "currency": "CLP"}
    """
    # Missing "regular" falls back to US hours; an explicitly empty one is a
    # config error, not an invitation to silently trade New York hours.
    if "regular" in payload and not payload["regular"]:
        raise ValueError("un calendario necesita al menos una ventana 'regular'")
    regular_spec = payload.get("regular") or [["09:30", "16:00"]]
    regular = tuple(_window(str(pair[0]), str(pair[1])) for pair in regular_spec)

    def optional(name: str) -> Window | None:
        spec = payload.get(name)
        if not spec:
            return None
        return _window(str(spec[0]), str(spec[1]))

    weekdays = tuple(int(day) for day in payload.get("weekdays", (0, 1, 2, 3, 4)))
    holidays = frozenset(
        day for day in (_as_date(item) for item in payload.get("holidays", ())) if day is not None
    )
    return ExchangeCalendar(
        code=str(payload.get("code", "CUSTOM")).upper(),
        name=str(payload.get("name", "Calendario personalizado")),
        timezone=str(payload.get("timezone", "UTC")),
        regular=regular,
        premarket=optional("premarket"),
        afterhours=optional("afterhours"),
        weekdays=weekdays or (0, 1, 2, 3, 4),
        holidays=holidays,
        currency=str(payload.get("currency", "USD")),
        notes=str(payload.get("notes", "Definido por el usuario.")),
    )


def load_calendar(
    code: str | None = None,
    *,
    path: str | Path | None = None,
    extra_holidays: Sequence[str] | None = None,
) -> ExchangeCalendar:
    """Resolve the calendar to use, from a JSON file or a built-in profile."""
    if path:
        file_path = Path(path)
        if not file_path.is_file():
            raise ValueError(f"no existe el archivo de calendario: {file_path}")
        payload = json.loads(file_path.read_text(encoding="utf-8"))
        calendar = calendar_from_dict(payload)
    else:
        calendar = get_calendar(code)
    if extra_holidays:
        calendar = calendar.with_holidays(extra_holidays)
    return calendar


def available() -> list[dict[str, str]]:
    """Every built-in profile, for the CLI to print."""
    return [
        {
            "code": calendar.code,
            "name": calendar.name,
            "timezone": calendar.timezone,
            "hours": " / ".join(
                f"{w.start.strftime('%H:%M')}-{w.end.strftime('%H:%M')}" for w in calendar.regular
            ),
            "currency": calendar.currency,
        }
        for calendar in CALENDARS.values()
    ]

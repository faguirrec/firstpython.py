"""Exchange calendars: sessions, holidays, breaks and custom profiles."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from trading_bot.calendars import (
    BREAK,
    CLOSED,
    OPEN,
    PREMARKET,
    AFTERHOURS,
    available,
    calendar_from_dict,
    get_calendar,
    load_calendar,
    resolve_code,
)

# All reference moments are UTC; the calendar converts to exchange-local time.
MON_10ET = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)
MON_07ET = datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)
MON_17ET = datetime(2026, 3, 2, 22, 0, tzinfo=timezone.utc)
MON_22ET = datetime(2026, 3, 3, 3, 0, tzinfo=timezone.utc)
SATURDAY = datetime(2026, 3, 7, 15, 0, tzinfo=timezone.utc)
CHRISTMAS = datetime(2026, 12, 25, 15, 0, tzinfo=timezone.utc)


def test_aliases_resolve_to_profiles():
    assert resolve_code("us") == "XNYS"
    assert resolve_code("NASDAQ") == "XNYS"
    assert resolve_code("tokyo") == "XTKS"
    assert resolve_code(None) == "XNYS"


def test_unknown_calendar_is_refused_with_the_options_listed():
    with pytest.raises(ValueError, match="XNYS"):
        get_calendar("XMARS")


def test_us_sessions_across_a_day():
    us = get_calendar("XNYS")
    assert us.session(MON_07ET) == PREMARKET
    assert us.session(MON_10ET) == OPEN
    assert us.session(MON_17ET) == AFTERHOURS
    assert us.session(MON_22ET) == CLOSED


def test_weekends_and_holidays_are_closed():
    us = get_calendar("XNYS")
    assert us.session(SATURDAY) == CLOSED
    assert us.session(CHRISTMAS) == CLOSED
    assert us.is_trading_day(date(2026, 12, 25)) is False
    assert us.is_trading_day(date(2026, 12, 24)) is True


def test_holidays_are_computed_so_the_calendar_never_expires():
    """A hardcoded table would make every 2030 holiday a trading day."""
    us = get_calendar("XNYS")
    for year in (2026, 2028, 2031, 2035):
        # Ten holidays a year, give or take one when New Year's Day is observed
        # in the neighbouring year.
        assert 9 <= len(us.holidays_for(year)) <= 11
    assert len(us.holidays_for(2027)) == 11      # keeps 2028's New Year observance
    # Independence Day 2028 is a Tuesday; 2026 falls on Saturday and moves back.
    assert us.is_trading_day(date(2028, 7, 4)) is False
    assert us.is_trading_day(date(2026, 7, 3)) is False
    # Good Friday is derived from Easter, not a table.
    assert us.is_trading_day(date(2031, 4, 11)) is False
    # An observed holiday that lands in the previous year is still caught.
    assert us.is_trading_day(date(2027, 12, 31)) is False


def test_only_the_regular_session_may_execute():
    us = get_calendar("XNYS")
    assert us.may_execute(MON_10ET) is True
    # Extended hours are monitoring only: Alpaca rejects fractional orders there.
    assert us.may_execute(MON_07ET) is False
    assert us.may_execute(MON_17ET) is False


def test_tokyo_lunch_break_is_its_own_session():
    tokyo = get_calendar("XTKS")
    morning = datetime(2026, 3, 2, 1, 0, tzinfo=timezone.utc)    # 10:00 JST
    lunch = datetime(2026, 3, 2, 3, 0, tzinfo=timezone.utc)      # 12:00 JST
    afternoon = datetime(2026, 3, 2, 5, 0, tzinfo=timezone.utc)  # 14:00 JST
    after = datetime(2026, 3, 2, 7, 0, tzinfo=timezone.utc)      # 16:00 JST

    assert tokyo.session(morning) == OPEN
    assert tokyo.session(lunch) == BREAK
    assert tokyo.session(afternoon) == OPEN
    assert tokyo.session(after) == CLOSED
    # A halt is not a tradable session.
    assert tokyo.may_execute(lunch) is False


def test_tokyo_closes_at_1530_local():
    tokyo = get_calendar("XTKS")
    assert tokyo.close_time.hour == 15
    assert tokyo.close_time.minute == 30
    assert tokyo.open_time.hour == 9


def test_hong_kong_also_has_a_break():
    hk = get_calendar("XHKG")
    lunch = datetime(2026, 3, 2, 4, 30, tzinfo=timezone.utc)   # 12:30 HKT
    assert hk.session(lunch) == BREAK


def test_next_open_and_close_are_utc_and_in_the_future():
    us = get_calendar("XNYS")
    nxt = us.next_open(MON_10ET)
    assert nxt is not None and nxt > MON_10ET
    assert nxt.hour == 14 and nxt.minute == 30       # 09:30 ET in March = 14:30 UTC

    close = us.next_close(MON_10ET)
    assert close is not None and close.hour == 21    # 16:00 ET


def test_next_open_skips_the_weekend():
    us = get_calendar("XNYS")
    nxt = us.next_open(SATURDAY)
    assert nxt is not None
    assert nxt.astimezone(us.zone).weekday() == 0    # Monday


def test_business_day_arithmetic_skips_holidays():
    us = get_calendar("XNYS")
    thursday = date(2026, 12, 24)
    # Christmas Day is a holiday, so T+1 lands on the 28th (Monday).
    assert us.next_business_day(thursday).isoformat() == "2026-12-28"
    assert us.business_days_between(date(2026, 12, 21), date(2026, 12, 28)) == 4


def test_custom_calendar_from_a_mapping():
    santiago = calendar_from_dict(
        {
            "code": "XSGO",
            "name": "Bolsa de Santiago",
            "timezone": "America/Santiago",
            "regular": [["09:30", "16:00"]],
            "holidays": ["2026-09-18", "2026-09-19"],
            "currency": "CLP",
        }
    )
    assert santiago.code == "XSGO"
    assert santiago.currency == "CLP"
    assert santiago.is_trading_day(date(2026, 9, 18)) is False
    local_noon = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)
    assert santiago.session(local_noon) == OPEN


def test_custom_calendar_needs_at_least_one_window():
    with pytest.raises(ValueError, match="regular"):
        calendar_from_dict({"code": "BAD", "regular": []})


def test_calendar_file_is_loaded(tmp_path):
    import json

    path = tmp_path / "cal.json"
    path.write_text(
        json.dumps(
            {"code": "XTST", "timezone": "UTC", "regular": [["10:00", "18:00"]],
             "weekdays": [0, 1, 2, 3, 4, 5]}
        ),
        encoding="utf-8",
    )
    calendar = load_calendar(path=path)
    assert calendar.code == "XTST"
    assert calendar.is_trading_day(date(2026, 3, 7)) is True     # Saturday is open here
    assert calendar.session(datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)) == OPEN


def test_missing_calendar_file_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="no existe"):
        load_calendar(path=tmp_path / "nope.json")


def test_extra_holidays_merge_into_a_profile():
    us = load_calendar("XNYS", extra_holidays=["2026-03-02"])
    assert us.session(MON_10ET) == CLOSED
    # The built-in holidays survive the merge.
    assert us.is_trading_day(date(2026, 12, 25)) is False


def test_describe_is_serialisable_and_complete():
    payload = get_calendar("XNYS").describe(MON_10ET)
    assert payload["session"] == OPEN
    assert payload["regular"] == [{"start": "09:30", "end": "16:00"}]
    assert payload["next_open"] and payload["next_close"]
    assert 9 <= len(payload["holidays_this_year"]) <= 11
    import json

    assert json.dumps(payload)


def test_available_lists_every_profile():
    rows = available()
    codes = {row["code"] for row in rows}
    assert {"XNYS", "XLON", "XETR", "XTKS", "XHKG"} <= codes
    tokyo = next(row for row in rows if row["code"] == "XTKS")
    assert "12:30-15:30" in tokyo["hours"]

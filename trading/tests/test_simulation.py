"""The offline simulator and the environment self-check."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from trading_bot.brokers.base import BrokerError
from trading_bot.brokers.simulator import SimulatedBroker
from trading_bot.calendars import get_calendar
from trading_bot.clock import clear_time_source
from trading_bot.config import RiskConfig, Settings
from trading_bot.db import Store
from trading_bot.simulation import FAIL, OK, default_start, run_simulation

OPEN_MOMENT = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)   # Monday 10:00 ET


@pytest.fixture(autouse=True)
def _release_clock():
    """No test may leak a simulated clock into the next one."""
    yield
    clear_time_source()


@pytest.fixture()
def sim_settings(tmp_path) -> Settings:
    return Settings(
        alpaca_api_key="sim", alpaca_secret_key="sim",
        universe=("AAPL", "MSFT"), benchmark="SPY",
        database_url=":memory:", log_file="",
    )


def broker(**kwargs) -> SimulatedBroker:
    params = {"start": OPEN_MOMENT, "seed": 11}
    params.update(kwargs)
    return SimulatedBroker(["AAPL", "MSFT", "SPY"], **params)


# ------------------------------------------------------------------- broker
def test_simulator_starts_flat_with_the_configured_equity():
    sim = broker(equity=30.0)
    account = sim.get_account()
    assert account.equity == pytest.approx(30.0)
    assert account.cash == pytest.approx(30.0)
    assert sim.get_positions() == []
    # A $30 pilot is a cash account: no leverage, no shorting.
    assert account.is_cash_account is True
    assert account.shorting_enabled is False


def test_simulator_never_reveals_future_bars():
    sim = broker()
    before = sim.get_bars("AAPL", limit=10_000)
    assert before, "expected warmup history"
    assert all(bar.timestamp <= sim.now for bar in before)

    sim.advance(timedelta(hours=3))
    after = sim.get_bars("AAPL", limit=10_000)
    assert len(after) > len(before)
    assert after[-1].timestamp > before[-1].timestamp
    assert all(bar.timestamp <= sim.now for bar in after)


def test_daily_aggregation_preserves_extremes():
    sim = broker()
    intraday = sim.get_bars("SPY", limit=200, timeframe="15Min")
    daily = sim.get_bars("SPY", limit=60, timeframe="1Day")
    assert daily and len(daily) < len(intraday)
    assert max(bar.high for bar in daily) == pytest.approx(
        max(bar.high for bar in sim.get_bars("SPY", limit=10_000))
    )


def test_marketable_limit_fills_immediately_and_moves_cash():
    sim = broker(equity=30.0)
    quote = sim.get_latest_quote("AAPL")
    result = sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=quote.ask * 1.001)
    assert result.status == "filled"
    assert result.filled_avg_price is not None
    # Never filled worse than the limit.
    assert result.filled_avg_price <= quote.ask * 1.001
    assert sim.cash < 30.0
    assert sim.get_position("AAPL").quantity == pytest.approx(0.05)


def test_unmarketable_limit_rests_then_fills_when_touched():
    sim = broker(equity=30.0, fill_probability=1.0)
    quote = sim.get_latest_quote("AAPL")
    result = sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=quote.bid * 0.98)
    assert result.status == "accepted"
    assert sim.get_positions() == []

    sim.advance(timedelta(days=1))
    # It either filled on a touch or expired with the day - never silently vanished.
    assert sim.get_order(result.broker_order_id).status in ("filled", "expired")


def test_order_outside_regular_hours_is_rejected_like_the_real_broker():
    sim = broker()
    sim.advance(timedelta(hours=8))          # past the close
    assert sim.session() != "open"
    with pytest.raises(BrokerError, match="market is"):
        sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=100.0)


def test_fractional_order_in_extended_hours_is_rejected():
    sim = broker()
    with pytest.raises(BrokerError, match="fractional"):
        sim.submit_limit_order(
            "AAPL", "buy", quantity=0.05, limit_price=100.0, extended_hours=True
        )


def test_buy_beyond_available_cash_is_rejected_not_overdrawn():
    sim = broker(equity=5.0)
    quote = sim.get_latest_quote("AAPL")
    result = sim.submit_limit_order("AAPL", "buy", quantity=10.0, limit_price=quote.ask * 1.01)
    assert result.status == "rejected"
    assert sim.cash == pytest.approx(5.0)


def test_selling_cannot_exceed_the_held_quantity():
    sim = broker(equity=30.0)
    quote = sim.get_latest_quote("AAPL")
    sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=quote.ask * 1.001)
    result = sim.submit_limit_order("AAPL", "sell", quantity=5.0, limit_price=quote.bid * 0.99)
    assert result.filled_qty <= 0.05
    assert sim.get_positions() == []


def test_average_entry_is_volume_weighted_across_two_fills():
    sim = broker(equity=30.0)
    first = sim.get_latest_quote("AAPL")
    sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=first.ask * 1.001)
    sim.advance(timedelta(minutes=45))
    second = sim.get_latest_quote("AAPL")
    sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=second.ask * 1.001)

    position = sim.get_position("AAPL")
    assert position.quantity == pytest.approx(0.10)
    low, high = sorted((first.ask, second.ask))
    assert low * 0.99 <= position.avg_entry_price <= high * 1.01


def test_outage_rate_raises_broker_errors():
    sim = broker(outage_rate=1.0)
    with pytest.raises(BrokerError, match="outage"):
        sim.get_account()


def test_reject_rate_produces_rejected_orders():
    sim = broker(reject_rate=1.0)
    quote = sim.get_latest_quote("AAPL")
    result = sim.submit_limit_order("AAPL", "buy", quantity=0.05, limit_price=quote.ask * 1.01)
    assert result.status == "rejected"
    assert sim.get_positions() == []


def test_same_seed_same_prices():
    first = broker(seed=99).get_bars("AAPL", limit=50)
    second = broker(seed=99).get_bars("AAPL", limit=50)
    assert [bar.close for bar in first] == [bar.close for bar in second]
    different = broker(seed=100).get_bars("AAPL", limit=50)
    assert [bar.close for bar in first] != [bar.close for bar in different]


def test_news_is_timestamped_to_simulated_now():
    sim = broker()
    articles = sim.get_news(symbols=["AAPL"], limit=3)
    assert articles
    assert all(article.published_at == sim.now for article in articles)


def test_simulator_follows_the_injected_calendar():
    tokyo = SimulatedBroker(["AAPL"], start=datetime(2026, 3, 2, 3, 0, tzinfo=timezone.utc),
                            calendar=get_calendar("XTKS"))
    assert tokyo.session() == "break"


# --------------------------------------------------------------- simulation
def test_default_start_lands_on_a_trading_day_open():
    calendar = get_calendar("XNYS")
    start = default_start(calendar, datetime(2026, 3, 4, 12, 0, tzinfo=timezone.utc))
    local = calendar.local(start)
    assert local.weekday() == 0                      # Monday of that week
    assert (local.hour, local.minute) == (9, 30)
    assert calendar.is_trading_day(local.date())


def test_simulation_passes_all_checks(sim_settings, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)                       # dashboard writes under here
    report = run_simulation(sim_settings, days=2, seed=5, step_minutes=15)

    assert report.passed, [check.as_dict() for check in report.failures]
    assert report.cycles > 0
    assert report.nightlies >= 1
    assert any(check.status == OK for check in report.checks)
    assert "RESULTADO" in report.text()


def test_simulation_never_trades_outside_the_session(sim_settings, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    report = run_simulation(sim_settings, days=2, seed=5, step_minutes=15)
    gate = next(c for c in report.checks if "horario de mercado" in c.name)
    assert gate.status == OK


def test_simulation_reports_every_decision_with_a_reason(sim_settings, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = Store(":memory:")
    run_simulation(sim_settings, days=2, seed=5, step_minutes=15, store=store)
    decisions = store.decisions_for_day()  # today's, under the simulated clock
    assert store._rows("SELECT id FROM decisions")          # noqa: SLF001
    assert all(row["reason"] for row in store._rows("SELECT reason FROM decisions"))  # noqa: SLF001
    store.close()


def test_simulation_releases_the_clock_afterwards(sim_settings, tmp_path, monkeypatch):
    from trading_bot.clock import time_source_active

    monkeypatch.chdir(tmp_path)
    run_simulation(sim_settings, days=1, seed=5, step_minutes=30)
    assert time_source_active() is False


def test_simulation_survives_broker_outages(sim_settings, tmp_path, monkeypatch):
    """An unreliable broker must not crash the run - the breaker absorbs it."""
    monkeypatch.chdir(tmp_path)
    report = run_simulation(
        sim_settings, days=1, seed=5, step_minutes=15, outage_rate=0.35
    )
    # The run completed and self-reported rather than crashing.
    assert report.cycles > 0
    assert report.checks
    assert not any(check.status == FAIL for check in report.checks), [
        c.as_dict() for c in report.failures
    ]


def test_simulation_with_a_tiny_trade_cap_still_validates(sim_settings, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    capped = Settings(**{**sim_settings.__dict__, "risk": RiskConfig(max_trades_per_day=1)})
    report = run_simulation(capped, days=2, seed=5, step_minutes=15)
    assert report.passed, [check.as_dict() for check in report.failures]


def test_simulation_accepts_an_explicit_start_date(sim_settings, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    report = run_simulation(
        sim_settings, days=1, seed=5, step_minutes=30, start=date(2026, 3, 2)
    )
    assert report.started_at.startswith("2026-03-02")


def test_the_harness_fails_when_a_fill_is_stranded(sim_settings, tmp_path, monkeypatch):
    """The checks must catch the very bug that motivated them."""
    from trading_bot.simulation import _collect, SimulationReport
    from trading_bot.brokers.simulator import SimulatedBroker
    from trading_bot.engine import TradingEngine

    monkeypatch.chdir(tmp_path)
    store = Store(":memory:")
    sim = SimulatedBroker(["AAPL"], start=OPEN_MOMENT, seed=3)
    engine = TradingEngine(sim_settings, store=store, broker=sim)

    # A filled entry with no trade row: exactly the orphan the audit found.
    store.record_order(
        {"symbol": "AAPL", "side": "buy", "quantity": 0.05, "status": "filled",
         "intent": "entry", "filled_qty": 0.05, "filled_avg_price": 100.0}
    )
    report = SimulationReport(days=1, cycles=1, news_cycles=0, nightlies=1)
    _collect(report, engine, store, sim, [], tmp_path)

    stranded = next(c for c in report.checks if "sin trade" in c.name.lower())
    assert stranded.status == FAIL
    store.close()


def test_the_harness_fails_on_an_oversized_position(sim_settings, tmp_path, monkeypatch):
    from trading_bot.simulation import _collect, SimulationReport
    from trading_bot.brokers.simulator import SimulatedBroker
    from trading_bot.engine import TradingEngine

    monkeypatch.chdir(tmp_path)
    store = Store(":memory:")
    sim = SimulatedBroker(["AAPL"], start=OPEN_MOMENT, seed=3)
    engine = TradingEngine(sim_settings, store=store, broker=sim)
    # $28 in one name against a ~$10 cap.
    store.open_trade({"symbol": "AAPL", "quantity": 0.28, "entry_price": 100.0})

    report = SimulationReport(days=1, cycles=1, news_cycles=0, nightlies=1)
    _collect(report, engine, store, sim, [], tmp_path)

    cap_check = next(c for c in report.checks if "Límite por posición" in c.name)
    assert cap_check.status == FAIL
    store.close()

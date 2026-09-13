"""Store, circuit breaker, scheduler and engine wiring."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from conftest import FakeBroker
from trading_bot.circuit_breaker import CircuitBreaker
from trading_bot.clock import business_days_between, local_session, next_business_day, parse_iso
from trading_bot.config import Settings, load_dotenv
from trading_bot.db import Store
from trading_bot.db.store import content_hash
from trading_bot.engine import TradingEngine
from trading_bot.scheduler import BotScheduler


# ------------------------------------------------------------------- store
def test_content_hash_ignores_case_and_punctuation():
    assert content_hash("Apple beats!", "AAPL") == content_hash("apple   beats", "aapl")
    assert content_hash("Apple beats", "AAPL") != content_hash("Apple misses", "AAPL")


def test_state_round_trips_structured_values(store: Store):
    store.set_state("kill_switch", {"active": True, "reason": "test"})
    assert store.get_state("kill_switch")["active"] is True
    assert store.get_state("missing", "fallback") == "fallback"


def test_day_trade_counter_only_counts_same_day_round_trips(store: Store):
    same_day = store.open_trade({"symbol": "AAPL", "quantity": 1, "entry_price": 10})
    store.close_trade(same_day, exit_price=11)
    overnight = store.open_trade(
        {"symbol": "MSFT", "quantity": 1, "entry_price": 10, "opened_day": "2020-01-02"}
    )
    store.close_trade(overnight, exit_price=11)
    assert store.day_trades_in_window() == 1


def test_equity_curve_keeps_the_last_snapshot_of_each_day(store: Store):
    for hour, equity in ((14, 30.0), (20, 31.0)):
        store.record_equity(
            {"equity": equity, "trading_day": "2026-03-02",
             "created_at": f"2026-03-02T{hour}:00:00+00:00"}
        )
    curve = store.daily_equity_curve()
    assert len(curve) == 1
    assert curve[0]["equity"] == 31.0


def test_orders_and_trades_link_back_to_their_decision(store: Store):
    decision_id = store.record_decision({"symbol": "AAPL", "action": "buy", "approved": True})
    order_id = store.record_order(
        {"symbol": "AAPL", "side": "buy", "quantity": 0.1, "decision_id": decision_id}
    )
    store.attach_order_to_decision(decision_id, order_id)
    assert store.get_order(order_id)["decision_id"] == decision_id
    assert store.decisions_for_day()[0]["order_id"] == order_id


# -------------------------------------------------------------------- clock
def test_session_classification():
    monday_open = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)      # 10:00 ET
    monday_pre = datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)       # 07:00 ET
    monday_after = datetime(2026, 3, 2, 22, 0, tzinfo=timezone.utc)     # 17:00 ET
    saturday = datetime(2026, 3, 7, 15, 0, tzinfo=timezone.utc)
    assert local_session(monday_open) == "open"
    assert local_session(monday_pre) == "premarket"
    assert local_session(monday_after) == "afterhours"
    assert local_session(saturday) == "closed"


def test_holidays_are_closed():
    christmas = datetime(2026, 12, 25, 15, 0, tzinfo=timezone.utc)
    assert local_session(christmas) == "closed"


def test_business_day_helpers_skip_weekends():
    friday = datetime(2026, 3, 6).date()
    assert next_business_day(friday).isoformat() == "2026-03-09"
    assert business_days_between(friday, next_business_day(friday, 3)) == 3


def test_parse_iso_accepts_z_suffix():
    assert parse_iso("2026-03-02T15:00:00Z").hour == 15
    assert parse_iso("not a date") is None
    assert parse_iso(None) is None


# ---------------------------------------------------------- circuit breaker
def test_breaker_trips_after_consecutive_failures(store: Store):
    breaker = CircuitBreaker(store, "trading", threshold=3, cooloff_minutes=10)
    assert breaker.record_failure("a") is False
    assert breaker.record_failure("b") is False
    assert breaker.record_failure("c") is True
    assert breaker.is_open() is True


def test_a_success_resets_the_failure_count(store: Store):
    breaker = CircuitBreaker(store, "trading", threshold=3)
    breaker.record_failure("a")
    breaker.record_success()
    assert breaker.state().failures == 0
    assert breaker.record_failure("b") is False


def test_breaker_closes_after_the_cooloff(store: Store):
    breaker = CircuitBreaker(store, "trading", threshold=1, cooloff_minutes=10)
    breaker.record_failure("boom")
    assert breaker.is_open() is True
    # Rewind the cool-off deadline to simulate the wait.
    state = store.get_state("circuit:trading")
    state["open_until"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    store.set_state("circuit:trading", state)
    assert breaker.is_open() is False


def test_trip_handler_is_called_once(store: Store):
    calls = []
    breaker = CircuitBreaker(store, "x", threshold=1, on_trip=lambda *args: calls.append(args))
    breaker.record_failure("boom")
    assert len(calls) == 1


# ------------------------------------------------------------------ config
def test_dotenv_loader_does_not_override_the_real_environment(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text('ALPACA_API_KEY=from_file\n# comment\nUNIVERSE="AAPL,MSFT"\n')
    monkeypatch.setenv("ALPACA_API_KEY", "from_env")
    load_dotenv(env_file)
    settings = Settings.from_env(dotenv=None)
    assert settings.alpaca_api_key == "from_env"
    assert settings.universe == ("AAPL", "MSFT")


def test_settings_validation_flags_missing_credentials():
    problems = Settings().validate()
    assert any("ALPACA_API_KEY" in problem for problem in problems)


def test_redacted_settings_never_leak_secrets():
    redacted = Settings(alpaca_api_key="secret-key", anthropic_api_key="sk-ant").redacted()
    assert redacted["alpaca_api_key"] == "***set***"
    assert "secret-key" not in str(redacted)


def test_paper_and_live_are_distinguished():
    assert Settings().is_paper is True
    assert Settings(alpaca_base_url="https://api.alpaca.markets").is_live is True


# --------------------------------------------------------------- scheduler
# These drive the scheduler through the real clock rather than patching its
# internals, so the session gating under test is the one that ships.
MONDAY_OPEN = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)       # 10:00 ET
MONDAY_AFTER_CLOSE = datetime(2026, 3, 2, 22, 0, tzinfo=timezone.utc)  # 17:00 ET
SATURDAY = datetime(2026, 3, 7, 15, 0, tzinfo=timezone.utc)


@pytest.fixture()
def frozen():
    """Pin the clock, and always release it so no test leaks a fake time."""
    from trading_bot.clock import clear_time_source, set_time_source

    def pin(moment: datetime) -> None:
        set_time_source(lambda: moment)

    yield pin
    clear_time_source()


def build_scheduler(settings, store, broker) -> BotScheduler:
    return BotScheduler(settings, TradingEngine(settings, store=store, broker=broker))


def test_scheduler_only_runs_jobs_allowed_in_the_current_session(settings, store, broker, frozen):
    frozen(SATURDAY)
    scheduler = build_scheduler(settings, store, broker)
    assert scheduler.session() == "closed"

    ran = scheduler.tick(now=10_000.0)
    assert "trading_cycle" not in ran
    assert "news_cycle" in ran


def test_scheduler_runs_the_trading_cycle_when_the_market_is_open(settings, store, broker, frozen):
    frozen(MONDAY_OPEN)
    scheduler = build_scheduler(settings, store, broker)
    assert scheduler.session() == "open"
    assert "trading_cycle" in scheduler.tick(now=10_000.0)


def test_jobs_respect_their_interval(settings, store, broker, frozen):
    frozen(MONDAY_OPEN)
    scheduler = build_scheduler(settings, store, broker)
    scheduler.tick(now=10_000.0)
    assert scheduler.tick(now=10_060.0) == []          # one minute later: nothing due
    assert "trading_cycle" in scheduler.tick(now=10_000.0 + 16 * 60)


def test_a_failing_job_does_not_stop_the_loop(settings, store, broker, frozen):
    frozen(MONDAY_OPEN)
    scheduler = build_scheduler(settings, store, broker)

    def explode():
        raise RuntimeError("boom")

    scheduler.jobs[0].func = explode
    ran = scheduler.tick(now=10_000.0)
    assert "trading_cycle" in ran and "news_cycle" in ran


def test_nightly_runs_once_per_day(settings, store, broker, frozen):
    frozen(MONDAY_AFTER_CLOSE)
    scheduler = build_scheduler(settings, store, broker)
    assert scheduler._nightly_if_due() is not None
    assert scheduler._nightly_if_due() is None


def test_nightly_does_not_run_before_the_exchange_closes(settings, store, broker, frozen):
    frozen(MONDAY_OPEN)
    scheduler = build_scheduler(settings, store, broker)
    assert scheduler._nightly_if_due() is None


def test_scheduler_windows_follow_the_configured_exchange(settings, store, broker, frozen):
    """Pointing the bot at Tokyo must move its whole schedule, not just a label."""
    from trading_bot.config import Settings as S

    tokyo = S(**{**settings.__dict__, "exchange": "XTKS"})
    frozen(datetime(2026, 3, 2, 3, 0, tzinfo=timezone.utc))     # 12:00 JST = lunch break
    scheduler = BotScheduler(tokyo, TradingEngine(tokyo, store=store, broker=broker))

    assert scheduler.calendar.code == "XTKS"
    assert scheduler.session() == "break"
    ran = scheduler.tick(now=10_000.0)
    assert "trading_cycle" not in ran      # no execution during the halt
    assert "news_cycle" in ran
    # Nightly is derived from Tokyo's 15:30 close, not New York's 16:00.
    assert scheduler._nightly_after().hour == 16


# ------------------------------------------------------------------ engine
def test_kill_switch_disables_entries_but_not_exits(settings, store, broker, frozen):
    """The worst moment to stop managing a losing position is when risk triggers."""
    frozen(MONDAY_OPEN)
    broker.set_position("AAPL", 0.1, 120.0, 100.0)      # 17% underwater
    trade_id = store.open_trade(
        {"symbol": "AAPL", "quantity": 0.1, "entry_price": 120.0, "opened_day": "2026-02-27"}
    )
    engine = TradingEngine(settings, store=store, broker=broker)
    engine.risk.engage_kill_switch("test")

    result = engine.trading_cycle()
    assert result["entries_disabled"].startswith("kill_switch")
    assert result["entries_submitted"] == 0
    # The stop loss still went out.
    assert result["exits_submitted"] == 1
    assert any(order["side"] == "sell" for order in broker.submitted)
    assert store.get_trade(trade_id) is not None


def test_engine_records_a_failure_against_the_breaker(settings, store, broker, monkeypatch):
    engine = TradingEngine(settings, store=store, broker=broker)
    monkeypatch.setattr(engine.trader, "run_cycle", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert "error" in engine.trading_cycle()
    assert engine.breaker.state().failures == 1


def test_open_breaker_disables_entries_but_keeps_reconciling(settings, store, broker, frozen):
    frozen(MONDAY_OPEN)
    engine = TradingEngine(settings, store=store, broker=broker)
    for _ in range(settings.risk.consecutive_error_limit):
        engine.breaker.record_failure("boom")

    result = engine.trading_cycle()
    assert result["entries_disabled"] == "circuit_open"
    assert result["entries_submitted"] == 0
    assert "fills" in result       # reconciliation still ran


def test_start_experiment_is_idempotent(settings, store, broker):
    engine = TradingEngine(settings, store=store, broker=broker)
    first = engine.start_experiment()
    second = engine.start_experiment()
    assert "started_at" in first
    assert "already_started" in second


def test_heartbeat_records_equity(settings, store, broker):
    engine = TradingEngine(settings, store=store, broker=broker)
    assert engine.heartbeat()["equity"] == pytest.approx(30.0)
    assert store.latest_equity() is not None


def test_status_reports_risk_and_metrics(settings, store, broker):
    engine = TradingEngine(settings, store=store, broker=broker)
    status = engine.status()
    assert status["mode"] == "paper"
    assert status["risk"]["trading_allowed"] is True
    assert "metrics" in status


def test_nightly_runs_learning_and_writes_a_report(settings, store, broker, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    engine = TradingEngine(settings, store=store, broker=broker)
    result = engine.nightly()
    assert "learning" in result
    assert "Resumen diario" in result["report"]
    assert result["dashboard"].endswith("dashboard.html")


def test_flatten_all_closes_everything(settings, store, broker):
    broker.set_position("AAPL", 0.1, 100.0, 101.0)
    engine = TradingEngine(settings, store=store, broker=broker)
    engine.flatten_all("panic")
    assert broker.get_positions() == []
    assert store.recent_events(kind="flatten_all")

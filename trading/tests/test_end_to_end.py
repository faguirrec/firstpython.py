"""End-to-end: several sessions of the full pipeline against the fake broker.

This is the closest thing to a rehearsal of the 30-day experiment that runs
offline: news in, signals fused, orders placed and filled, trades closed,
weights updated, reports and dashboard produced.
"""

from __future__ import annotations

import pytest

from conftest import BASE_TIME, FakeBroker, trending_prices
from trading_bot.brokers.base import NewsArticle
from trading_bot.config import Settings
from trading_bot.db import Store
from trading_bot.engine import TradingEngine
from trading_bot.reporting import final_report, write_dashboard


@pytest.fixture()
def engine(settings: Settings, store: Store) -> TradingEngine:
    broker = FakeBroker(
        equity=30.0,
        cash=30.0,
        prices={
            "AAPL": trending_prices(80, 100.0, drift=0.45),
            "MSFT": trending_prices(80, 200.0, drift=-0.45),
            "SPY": trending_prices(80, 500.0, drift=0.3),
        },
    )
    broker.news = [
        NewsArticle(
            external_id="n1",
            headline="Apple beats estimates and raises guidance",
            summary="Record quarter with strong growth.",
            url="https://example.test/1",
            author="wire",
            source="alpaca",
            symbols=("AAPL",),
            published_at=BASE_TIME,
        )
    ]
    return TradingEngine(settings, store=store, broker=broker)


def test_full_pipeline_from_news_to_final_report(engine: TradingEngine, store: Store, tmp_path):
    broker: FakeBroker = engine.broker  # type: ignore[assignment]

    # Day 0: mark the experiment and ingest the news.
    started = engine.start_experiment()
    assert "started_at" in started
    assert engine.news_cycle() == {"ingested": 1, "classified": 1}
    assert store.recent_sentiment("AAPL", hours=24 * 365)

    # Session 1: a cycle opens a position.
    report = engine.trading_cycle()
    assert report["entries_submitted"] == 1
    trade = store.open_trades()[0]
    assert trade["symbol"] == "AAPL"

    # The price runs past the take-profit threshold; the next cycle exits.
    entry = float(trade["entry_price"])
    broker.prices["AAPL"] = broker.prices["AAPL"] + [entry * 1.06]
    broker.set_position("AAPL", float(trade["quantity"]), entry, entry * 1.06)
    engine.trading_cycle()

    closed = store.closed_trades()
    assert len(closed) == 1
    assert closed[0]["exit_reason"] == "take_profit"
    assert closed[0]["net_pnl"] == pytest.approx(closed[0]["gross_pnl"] - closed[0]["fees"])

    # Nightly: grade the trade, move the weights, write the report.
    weights_before = store.weight_values()
    nightly = engine.nightly()
    assert nightly["learning"]["reviewed"] == 1
    assert store.weight_values() != weights_before
    assert "Resumen diario" in nightly["report"]

    # The final report reads the whole history back.
    report = final_report(engine.settings, store)
    assert report["metrics"]["trades_total"] == 1
    assert report["recommendation"] in {"continuar", "ajustar", "detener"}
    assert report["per_symbol"][0]["symbol"] == "AAPL"

    dashboard = write_dashboard(engine.settings, store, tmp_path / "dash.html")
    assert "AAPL" in dashboard.read_text(encoding="utf-8")


def test_every_executed_trade_has_a_recorded_justification(engine: TradingEngine, store: Store):
    engine.news_cycle()
    engine.trading_cycle()

    for trade in store.open_trades():
        decision_id = trade["decision_id"]
        assert decision_id is not None
        signals, expected_move = store.decision_signals(int(decision_id))
        # The justification must be complete enough to grade later.
        assert signals["components"]
        assert expected_move and expected_move > 0
        decision = next(d for d in store.decisions_for_day() if d["id"] == decision_id)
        assert decision["ev"]["ev"]["net_ev"] > 0
        assert decision["approved"] == 1


def test_drawdown_breach_stops_the_experiment(engine: TradingEngine, store: Store):
    broker: FakeBroker = engine.broker  # type: ignore[assignment]
    engine.trading_cycle()

    # A 25% equity collapse, past the 20% drawdown limit.
    broker.equity = 22.0
    broker.cash = 22.0
    result = engine.trading_cycle()

    assert engine.risk.kill_switch_active() is True
    assert store.get_state("kill_switch")["reason"] == "max_drawdown_breached"
    # Entries stay stopped even if equity recovers - but exits keep running.
    broker.equity = 30.0
    resumed = engine.trading_cycle()
    assert resumed["entries_disabled"].startswith("kill_switch")
    assert resumed["entries_submitted"] == 0


def test_daily_loss_limit_pauses_entries_without_killing_the_run(engine: TradingEngine, store: Store):
    broker: FakeBroker = engine.broker  # type: ignore[assignment]
    engine.heartbeat()                     # records the start-of-day equity
    broker.equity = 27.0                   # -10% on the day
    broker.cash = 27.0

    result = engine.trading_cycle()
    assert any("daily_loss_limit_reached" in note for note in result["notes"])
    assert engine.risk.kill_switch_active() is False

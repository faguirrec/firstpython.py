"""Metrics, reports and dashboard."""

from __future__ import annotations

import json

import pytest

from trading_bot.config import Settings
from trading_bot.db import Store
from trading_bot.metrics import (
    benchmark_return,
    compute_metrics,
    daily_snapshot,
    max_drawdown,
    sharpe_ratio,
    simple_returns,
)
from trading_bot.reporting import daily_report, final_report, write_dashboard


def seed(store: Store, *, results=((100.0, 103.0), (100.0, 98.0), (50.0, 52.0))) -> None:
    for day, (entry, exit_price) in enumerate(results, start=1):
        trade_id = store.open_trade(
            {
                "symbol": "AAPL",
                "quantity": 0.1,
                "entry_price": entry,
                "opened_day": f"2026-03-{day:02d}",
                "signals": {"components": {"trend": 0.7}},
            }
        )
        gross = (exit_price - entry) * 0.1
        store.close_trade(
            trade_id,
            exit_price=exit_price,
            gross_pnl=gross,
            fees=0.01,
            net_pnl=gross - 0.01,
            return_pct=(gross - 0.01) / (entry * 0.1),
            exit_reason="take_profit" if gross > 0 else "stop_loss",
            closed_day=f"2026-03-{day:02d}",
            closed_at=f"2026-03-{day:02d}T20:00:00+00:00",
        )
        store.record_equity(
            {
                "equity": 30.0 + gross,
                "trading_day": f"2026-03-{day:02d}",
                "benchmark_price": 500.0 + day,
                "created_at": f"2026-03-{day:02d}T20:00:00+00:00",
            }
        )


def test_max_drawdown_finds_the_worst_peak_to_trough():
    assert max_drawdown([30, 33, 30, 36]) == pytest.approx(-3 / 33)
    assert max_drawdown([30, 31, 32]) == 0.0
    assert max_drawdown([]) == 0.0


def test_sharpe_needs_at_least_two_observations():
    assert sharpe_ratio([0.01]) is None
    assert sharpe_ratio([0.01, 0.01, 0.01]) is None  # zero volatility
    assert sharpe_ratio(simple_returns([30, 31, 30.5, 32])) is not None


def test_benchmark_return_uses_first_and_last_price():
    curve = [{"benchmark_price": 500.0}, {"benchmark_price": None}, {"benchmark_price": 510.0}]
    assert benchmark_return(curve) == pytest.approx(0.02)
    assert benchmark_return([{"benchmark_price": 500.0}]) is None


def test_compute_metrics_is_net_of_fees(settings: Settings, store: Store):
    seed(store)
    metrics = compute_metrics(store, starting_equity=30.0)

    assert metrics.trades_total == 3
    assert metrics.wins == 2
    assert metrics.losses == 1
    assert metrics.total_fees == pytest.approx(0.03)
    assert metrics.net_pnl == pytest.approx(metrics.gross_pnl - metrics.total_fees)
    assert metrics.win_rate == pytest.approx(2 / 3)
    assert metrics.profit_factor is not None and metrics.profit_factor > 1


def test_fee_to_pnl_ratio_is_the_headline_risk_at_small_size(store: Store):
    # Tiny edge, same fees: the ratio is what tells you the account is too small.
    seed(store, results=((100.0, 100.05), (100.0, 100.05)))
    metrics = compute_metrics(store, starting_equity=30.0)
    assert metrics.fee_to_pnl_ratio > 1.0
    assert metrics.net_pnl < 0


def test_metrics_survive_an_empty_database(store: Store):
    metrics = compute_metrics(store, starting_equity=30.0)
    assert metrics.trades_total == 0
    assert metrics.win_rate == 0.0
    assert metrics.sharpe_ratio is None
    assert metrics.profit_factor is None
    assert json.dumps(metrics.as_dict())  # serialisable for the report


def test_daily_snapshot_is_persisted(store: Store):
    seed(store)
    snapshot = daily_snapshot(store, "2026-03-01")
    assert snapshot["trades_closed"] == 1
    assert snapshot["wins"] == 1
    saved = {row["trading_day"]: row for row in store.daily_metrics()}
    assert "2026-03-01" in saved


def test_daily_report_text_mentions_the_key_numbers(settings: Settings, store: Store):
    seed(store)
    report = daily_report(settings, store, "2026-03-02")
    assert "Resumen diario 2026-03-02" in report["text"]
    assert "P&L neto del día" in report["text"]
    assert report["daily"]["trades_closed"] == 1


def test_daily_report_counts_rejection_reasons(settings: Settings, store: Store):
    for reason in ("net_ev_not_positive", "net_ev_not_positive", "confidence_below_minimum"):
        store.record_decision(
            {"symbol": "AAPL", "action": "buy", "approved": False, "reason": reason,
             "trading_day": "2026-03-02"}
        )
    report = daily_report(settings, store, "2026-03-02")
    assert report["rejection_reasons"]["net_ev_not_positive"] == 2


def test_final_report_recommends_adjusting_on_a_small_sample(settings: Settings, store: Store):
    seed(store, results=((100.0, 103.0),))
    report = final_report(settings, store)
    assert report["recommendation"] == "ajustar"
    assert "Muestra insuficiente" in report["rationale"][0]


def test_final_report_recommends_stopping_when_costs_eat_the_edge(settings: Settings, store: Store):
    seed(store, results=tuple((100.0, 99.5) for _ in range(6)))
    report = final_report(settings, store)
    assert report["recommendation"] == "detener"
    assert any("negativo" in reason for reason in report["rationale"])


def test_final_report_recommends_continuing_on_a_solid_run(settings: Settings, store: Store):
    seed(store, results=tuple((100.0, 104.0) for _ in range(8)))
    report = final_report(settings, store)
    assert report["recommendation"] in {"continuar", "ajustar"}
    assert "Recomendación:" in report["text"]
    assert "no constituye asesoría financiera" in report["text"]


def test_dashboard_is_self_contained(settings: Settings, store: Store, tmp_path):
    seed(store)
    path = write_dashboard(settings, store, tmp_path / "dash.html")
    html = path.read_text(encoding="utf-8")

    assert path.exists()
    assert "<svg" in html                    # inline chart, not an image request
    assert "http://" not in html.replace("http://www.w3.org", "")
    assert "<script" not in html
    assert "AAPL" in html


def test_dashboard_handles_an_empty_database(settings: Settings, store: Store, tmp_path):
    html = write_dashboard(settings, store, tmp_path / "dash.html").read_text(encoding="utf-8")
    assert "Sin datos todavía" in html

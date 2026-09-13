"""The health endpoint: liveness, and not leaking account figures."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from conftest import FakeBroker
from trading_bot.clock import clear_time_source, iso, set_time_source
from trading_bot.config import Settings
from trading_bot.db import Store
from trading_bot.engine import TradingEngine
from trading_bot.health import HealthServer, HealthState

NOW = datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clock():
    set_time_source(lambda: NOW)
    yield
    clear_time_source()


@pytest.fixture()
def engine(settings: Settings, store: Store, broker: FakeBroker) -> TradingEngine:
    return TradingEngine(settings, store=store, broker=broker)


def serve(engine: TradingEngine, *, token: str = "") -> HealthServer:
    # Port 0 lets the OS pick a free one, so tests never collide.
    server = HealthServer(engine, port=0, host="127.0.0.1", token=token)
    assert server.start() is True
    return server


def fetch(server: HealthServer, path: str, *, token: str | None = None):
    port = server._server.server_address[1]
    url = f"http://127.0.0.1:{port}{path}"
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


# ---------------------------------------------------------------- liveness
def test_no_tick_recorded_is_unhealthy(engine: TradingEngine):
    healthy, payload = HealthState(engine).snapshot()
    assert healthy is False
    assert "no_tick_recorded" in payload["reasons"]


def test_a_fresh_tick_is_healthy(engine: TradingEngine):
    state = HealthState(engine)
    state.record_tick()
    healthy, payload = state.snapshot()
    assert healthy is True
    assert payload["status"] == "ok"
    assert payload["last_tick_age_seconds"] == pytest.approx(0.0, abs=1.0)


def test_a_stale_tick_is_unhealthy(engine: TradingEngine, store: Store):
    store.set_state("last_tick", iso(NOW - timedelta(hours=3)))
    healthy, payload = HealthState(engine, stale_after_minutes=45).snapshot()
    assert healthy is False
    assert "scheduler_stalled" in payload["reasons"]


def test_kill_switch_and_open_breaker_show_up_as_degraded(engine: TradingEngine):
    state = HealthState(engine)
    state.record_tick()
    engine.risk.engage_kill_switch("manual")
    for _ in range(engine.settings.risk.consecutive_error_limit):
        engine.breaker.record_failure("boom")

    healthy, payload = state.snapshot()
    assert healthy is False
    assert any(reason.startswith("kill_switch") for reason in payload["reasons"])
    assert "circuit_open" in payload["reasons"]


# ------------------------------------------------------------------ endpoint
def test_health_endpoint_returns_503_when_degraded(engine: TradingEngine):
    server = serve(engine)
    try:
        status, payload = fetch(server, "/health")
        assert status == 503
        assert payload["status"] == "degraded"
    finally:
        server.stop()


def test_health_endpoint_returns_200_when_ticking(engine: TradingEngine):
    server = serve(engine)
    server.record_tick()
    try:
        status, payload = fetch(server, "/health")
        assert status == 200
        assert payload["session"]
        assert payload["exchange"] == "XNYS"
    finally:
        server.stop()


def test_health_payload_carries_no_account_figures(engine: TradingEngine):
    """Anyone can reach /health, so it must not disclose equity or positions."""
    server = serve(engine)
    server.record_tick()
    try:
        _status, payload = fetch(server, "/health")
        body = json.dumps(payload).lower()
        for forbidden in ("equity", "cash", "position", "pnl", "buying_power"):
            assert forbidden not in body
    finally:
        server.stop()


def test_status_endpoint_is_refused_without_a_token(engine: TradingEngine):
    server = serve(engine)
    try:
        status, payload = fetch(server, "/status")
        assert status == 401
        assert "HEALTH_TOKEN" in payload["detail"]
    finally:
        server.stop()


def test_status_endpoint_rejects_a_wrong_token(engine: TradingEngine):
    server = serve(engine, token="s3cret")
    try:
        assert fetch(server, "/status", token="wrong")[0] == 401
        assert fetch(server, "/status?token=wrong")[0] == 401
    finally:
        server.stop()


def test_status_endpoint_serves_the_full_payload_with_the_token(engine: TradingEngine):
    server = serve(engine, token="s3cret")
    try:
        status, payload = fetch(server, "/status", token="s3cret")
        assert status == 200
        assert "metrics" in payload
        assert payload["mode"] == "paper"
    finally:
        server.stop()


def test_reading_status_does_not_engage_the_kill_switch(engine: TradingEngine, store: Store, broker):
    """A monitoring probe must never change the bot's state."""
    store.record_equity({"equity": 40.0})
    broker.equity = 30.0            # a 25% drawdown, past the limit
    server = serve(engine, token="t")
    try:
        assert fetch(server, "/status", token="t")[0] == 200
        assert engine.risk.kill_switch_active() is False
    finally:
        server.stop()


def test_unknown_routes_are_404(engine: TradingEngine):
    server = serve(engine)
    try:
        status, payload = fetch(server, "/admin")
        assert status == 404
        assert "/health" in payload["routes"]
    finally:
        server.stop()


def test_a_busy_port_does_not_stop_the_bot(engine: TradingEngine):
    """Operational nicety: failing to bind must never block trading."""
    first = serve(engine)
    port = first._server.server_address[1]
    try:
        second = HealthServer(engine, port=port, host="127.0.0.1")
        assert second.start() is False
    finally:
        first.stop()

"""A tiny HTTP health endpoint for unattended deployments.

A 24/7 bot needs something outside itself to notice when it dies. This exposes
just enough for a platform health check or an uptime monitor:

``GET /health``
    Public, no numbers. ``200`` while the scheduler is ticking; ``503`` when the
    last tick is stale, the kill switch is engaged, or the circuit breaker is
    open. This is the endpoint a load balancer or uptime monitor should poll.

``GET /status``
    The full status payload (equity, positions, risk state). Requires
    ``HEALTH_TOKEN`` via ``Authorization: Bearer <token>`` or ``?token=``, and is
    refused outright when no token is configured - account figures must not be
    readable by anyone who finds the URL.

Built on ``http.server`` in a daemon thread: no web framework, no extra
dependency, nothing to keep patched.
"""

from __future__ import annotations

import hmac
import json
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .clock import iso, parse_iso, utcnow
from .logging_setup import get_logger

log = get_logger(__name__)

LAST_TICK_KEY = "last_tick"
# How long without a scheduler tick before the bot is considered unhealthy.
DEFAULT_STALE_AFTER_MINUTES = 45.0


class HealthState:
    """Liveness facts, read from the same store the bot writes to."""

    def __init__(self, engine: Any, *, stale_after_minutes: float = DEFAULT_STALE_AFTER_MINUTES) -> None:
        self.engine = engine
        self.stale_after = timedelta(minutes=stale_after_minutes)

    def record_tick(self) -> None:
        self.engine.store.set_state(LAST_TICK_KEY, iso())

    def snapshot(self) -> tuple[bool, dict[str, Any]]:
        """``(healthy, payload)`` - payload carries no account figures."""
        store = self.engine.store
        last_tick = store.get_state(LAST_TICK_KEY)
        moment = parse_iso(last_tick) if isinstance(last_tick, str) else None
        age_seconds = (utcnow() - moment).total_seconds() if moment else None

        kill_switch = store.get_state("kill_switch") or {}
        breaker = self.engine.breaker.state()

        reasons: list[str] = []
        if moment is None:
            reasons.append("no_tick_recorded")
        elif utcnow() - moment > self.stale_after:
            reasons.append("scheduler_stalled")
        if kill_switch.get("active"):
            reasons.append(f"kill_switch:{kill_switch.get('reason', '')}")
        if breaker.open_until:
            reasons.append("circuit_open")

        payload = {
            "status": "ok" if not reasons else "degraded",
            "reasons": reasons,
            "session": self._session(),
            "exchange": getattr(self.engine, "calendar", None).code
            if getattr(self.engine, "calendar", None)
            else None,
            "mode": "paper" if self.engine.settings.is_paper else "live",
            "last_tick": last_tick if isinstance(last_tick, str) else None,
            "last_tick_age_seconds": round(age_seconds, 1) if age_seconds is not None else None,
            "checked_at": iso(),
        }
        return not reasons, payload

    def _session(self) -> str:
        calendar = getattr(self.engine, "calendar", None)
        if calendar is not None:
            return calendar.session()
        return "unknown"


def _handler_factory(state: HealthState, token: str):
    class Handler(BaseHTTPRequestHandler):
        # Silence the default stderr access log; the bot has its own logging.
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            log.debug("health_request", extra={"event": {"line": fmt % args}})

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorised(self, query: dict[str, list[str]]) -> bool:
            if not token:
                return False
            header = self.headers.get("Authorization", "")
            presented = header[7:] if header.startswith("Bearer ") else (query.get("token") or [""])[0]
            # Constant-time compare so the token cannot be guessed byte by byte.
            return hmac.compare_digest(presented, token)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            parsed = urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            query = parse_qs(parsed.query)

            if route in ("/", "/health", "/healthz"):
                healthy, payload = state.snapshot()
                self._send(200 if healthy else 503, payload)
                return

            if route == "/status":
                if not self._authorised(query):
                    self._send(
                        401,
                        {
                            "error": "unauthorized",
                            "detail": "define HEALTH_TOKEN y envía Authorization: Bearer <token>",
                        },
                    )
                    return
                try:
                    self._send(200, self.server.engine_status())  # type: ignore[attr-defined]
                except Exception as exc:  # noqa: BLE001 - never take the server down
                    self._send(500, {"error": str(exc)})
                return

            self._send(404, {"error": "not_found", "routes": ["/health", "/status"]})

    return Handler


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, status_provider) -> None:
        super().__init__(address, handler)
        self._status_provider = status_provider

    def engine_status(self) -> dict[str, Any]:
        return self._status_provider()


class HealthServer:
    """Runs the health endpoint in a daemon thread alongside the scheduler."""

    def __init__(
        self,
        engine: Any,
        *,
        port: int,
        host: str = "0.0.0.0",
        token: str = "",
        stale_after_minutes: float = DEFAULT_STALE_AFTER_MINUTES,
    ) -> None:
        self.engine = engine
        self.port = port
        self.host = host
        self.token = token
        self.state = HealthState(engine, stale_after_minutes=stale_after_minutes)
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        """Start listening. Returns False if the port could not be bound.

        Port ``0`` means "let the OS pick one"; whether the endpoint runs at all
        is decided by the caller, from ``HEALTH_PORT``.
        """
        if self.port < 0:
            return False
        try:
            self._server = _Server(
                (self.host, self.port),
                _handler_factory(self.state, self.token),
                self.engine.status,
            )
        except OSError as exc:
            # A health endpoint is an operational nicety: never block trading.
            log.warning(
                "health_server_unavailable",
                extra={"event": {"port": self.port, "error": str(exc)}},
            )
            return False

        self._thread = threading.Thread(
            target=self._server.serve_forever, name="health-server", daemon=True
        )
        self._thread.start()
        log.info(
            "health_server_started",
            extra={"event": {
                "port": self.port,
                "status_endpoint_protected": bool(self.token),
            }},
        )
        if not self.token:
            log.warning("health_status_endpoint_disabled_no_token")
        return True

    def record_tick(self) -> None:
        self.state.record_tick()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

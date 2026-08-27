"""Structured JSON logging.

Every decision the bot makes is emitted as one JSON object per line so the
30-day experiment can be reconstructed from the log alone. Use::

    log = get_logger(__name__)
    log.info("trade_decision", extra={"event": {"symbol": "AAPL", "action": "buy"}})
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"message", "asctime", "taskName"}

_CONFIGURED = False


class JsonFormatter(logging.Formatter):
    """Render a log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        event = getattr(record, "event", None)
        if isinstance(event, dict):
            payload["event"] = event
        for key, value in record.__dict__.items():
            if key in _RESERVED or key == "event":
                continue
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=_fallback, ensure_ascii=False)


class HumanFormatter(logging.Formatter):
    """Compact console format; the JSON file stays the machine-readable record."""

    def format(self, record: logging.LogRecord) -> str:
        stamp = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%H:%M:%S")
        base = f"{stamp} {record.levelname:<7} {record.name.split('.')[-1]:<14} {record.getMessage()}"
        event = getattr(record, "event", None)
        if isinstance(event, dict) and event:
            base += "  " + json.dumps(event, default=_fallback, ensure_ascii=False)
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


def _fallback(value: Any) -> str:
    return str(value)


def setup_logging(
    level: str = "INFO",
    log_file: str | os.PathLike[str] | None = "logs/trading_bot.jsonl",
    *,
    console: bool = True,
    force: bool = False,
) -> logging.Logger:
    """Install the JSON file handler and a readable console handler."""
    global _CONFIGURED
    root = logging.getLogger()
    if _CONFIGURED and not force:
        return root
    for handler in list(root.handlers):
        root.removeHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    if console:
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(HumanFormatter())
        root.addHandler(stream)

    if log_file:
        path = Path(log_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        rotating = RotatingFileHandler(path, maxBytes=8_000_000, backupCount=5, encoding="utf-8")
        rotating.setFormatter(JsonFormatter())
        root.addHandler(rotating)

    # Third-party libraries are chatty; keep the decision log readable.
    for noisy in ("urllib3", "httpx", "httpcore", "apscheduler.executors.default", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, level: int, message: str, **event: Any) -> None:
    """Log ``message`` with a structured ``event`` payload attached."""
    logger.log(level, message, extra={"event": event})

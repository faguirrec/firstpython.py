"""Alerting: Telegram and/or email, with logging as the always-on fallback.

Alerts are best-effort by design - a failed notification must never take the
trading loop down, so every send is wrapped and swallowed after logging.
"""

from __future__ import annotations

import json
import smtplib
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from typing import Any

from .config import Settings
from .logging_setup import get_logger

log = get_logger(__name__)

SEVERITY_PREFIX = {
    "info": "ℹ️",
    "warning": "⚠️",
    "error": "❌",
    "critical": "🚨",
}


class Alerter:
    """Sends operational alerts through whatever channels are configured."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def channels(self) -> list[str]:
        active = []
        if self.settings.telegram_bot_token and self.settings.telegram_chat_id:
            active.append("telegram")
        if self.settings.alert_email and self.settings.smtp_url:
            active.append("email")
        return active

    def send(self, subject: str, body: str = "", *, severity: str = "info", **context: Any) -> bool:
        """Send an alert. Returns True if at least one channel accepted it."""
        prefix = SEVERITY_PREFIX.get(severity, "")
        title = f"{prefix} {subject}".strip()
        text = title if not body else f"{title}\n\n{body}"
        if context:
            text += "\n\n" + json.dumps(context, default=str, indent=2)

        log.log(
            {"critical": 50, "error": 40, "warning": 30}.get(severity, 20),
            "alert",
            extra={"event": {"subject": subject, "severity": severity, **context}},
        )

        delivered = False
        if self.settings.telegram_bot_token and self.settings.telegram_chat_id:
            delivered |= self._send_telegram(text)
        if self.settings.alert_email and self.settings.smtp_url:
            delivered |= self._send_email(title, text)
        return delivered

    def _send_telegram(self, text: str) -> bool:
        url = f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/sendMessage"
        payload = urllib.parse.urlencode(
            {"chat_id": self.settings.telegram_chat_id, "text": text[:4000]}
        ).encode()
        try:
            request = urllib.request.Request(url, data=payload)
            with urllib.request.urlopen(request, timeout=10) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log.warning("telegram_alert_failed", extra={"event": {"error": str(exc)}})
            return False

    def _send_email(self, subject: str, body: str) -> bool:
        """Send through ``SMTP_URL`` (``smtp[s]://user:pass@host:port``)."""
        try:
            parsed = urllib.parse.urlparse(self.settings.smtp_url)
            message = EmailMessage()
            message["Subject"] = subject
            message["From"] = parsed.username or self.settings.alert_email
            message["To"] = self.settings.alert_email
            message.set_content(body)

            port = parsed.port or (465 if parsed.scheme == "smtps" else 587)
            if parsed.scheme == "smtps":
                server: smtplib.SMTP = smtplib.SMTP_SSL(parsed.hostname or "", port, timeout=15)
            else:
                server = smtplib.SMTP(parsed.hostname or "", port, timeout=15)
                server.starttls()
            with server:
                if parsed.username and parsed.password:
                    server.login(urllib.parse.unquote(parsed.username), urllib.parse.unquote(parsed.password))
                server.send_message(message)
            return True
        except Exception as exc:  # noqa: BLE001 - alerting must never raise
            log.warning("email_alert_failed", extra={"event": {"error": str(exc)}})
            return False

"""Configuration loaded from environment variables.

Secrets are never hardcoded: every credential comes from the environment (or a
`.env` file that is git-ignored). Tunables have conservative defaults sized for
the 30-day, USD $30 pilot described in the project spec.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

_TRUE = {"1", "true", "yes", "on", "y"}
_FALSE = {"0", "false", "no", "off", "n"}

PAPER_URL = "https://paper-api.alpaca.markets"
LIVE_URL = "https://api.alpaca.markets"


def load_dotenv(path: str | os.PathLike[str] | None = None, *, override: bool = False) -> dict[str, str]:
    """Minimal `.env` loader so the bot has no hard dependency on python-dotenv.

    Lines are `KEY=value`; `#` starts a comment, surrounding quotes are stripped.
    Values already present in the environment win unless ``override`` is set.
    """
    env_path = Path(path) if path is not None else Path(".env")
    loaded: dict[str, str] = {}
    if not env_path.is_file():
        return loaded
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.split(" #", 1)[0].strip().strip("'\"")
        if not key:
            continue
        loaded[key] = value
        if override or key not in os.environ:
            os.environ[key] = value
    return loaded


def env_str(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    lowered = raw.strip().lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ValueError(f"{name} must be a boolean-ish value, got {raw!r}")


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return tuple(default)
    return tuple(item.strip().upper() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class CostConfig:
    """Fee schedule used to turn a gross edge into a net expected value.

    Defaults follow Alpaca's commission-free US equity schedule plus the
    pass-through regulatory fees charged on *sells* only. Rates change over
    time, so they are all overridable from the environment.
    """

    commission_per_order: float = 0.0
    commission_per_share: float = 0.0
    # SEC Section 31 fee, charged on sale proceeds (rate per dollar of principal).
    sec_fee_rate: float = 0.0000278
    # FINRA Trading Activity Fee, charged per share sold, capped per order.
    taf_per_share: float = 0.000166
    taf_max_per_order: float = 8.30
    # Fallback half-spread assumption when no quote is available, in bps.
    default_half_spread_bps: float = 5.0
    # Extra slippage assumed on top of the half-spread, in bps per fill.
    slippage_bps: float = 2.0

    @classmethod
    def from_env(cls) -> "CostConfig":
        return cls(
            commission_per_order=env_float("COMMISSION_PER_ORDER", 0.0),
            commission_per_share=env_float("COMMISSION_PER_SHARE", 0.0),
            sec_fee_rate=env_float("SEC_FEE_RATE", 0.0000278),
            taf_per_share=env_float("TAF_PER_SHARE", 0.000166),
            taf_max_per_order=env_float("TAF_MAX_PER_ORDER", 8.30),
            default_half_spread_bps=env_float("DEFAULT_HALF_SPREAD_BPS", 5.0),
            slippage_bps=env_float("SLIPPAGE_BPS", 2.0),
        )


@dataclass(frozen=True)
class RiskConfig:
    """Hard limits. Every one of these is a stop, not a suggestion."""

    starting_equity: float = 30.0
    max_position_pct: float = 0.34          # share of equity in a single position
    min_position_notional: float = 1.00     # Alpaca's fractional-order floor
    max_open_positions: int = 3
    max_trades_per_day: int = 6
    max_daily_loss_pct: float = 0.06        # of start-of-day equity
    max_drawdown_pct: float = 0.20          # of peak equity, kills the experiment
    # Floors sized for a $30 account: a $6 position clearing 10 bps net is
    # half a cent of edge. Raising these much further means never trading.
    min_net_ev_usd: float = 0.005           # absolute net edge required
    min_net_ev_bps: float = 10.0            # net edge as bps of notional
    min_confidence: float = 0.35
    # PDT: FINRA allows 3 day trades per rolling 5 business days under $25k.
    pdt_equity_threshold: float = 25_000.0
    max_day_trades_window: int = 3
    day_trade_safety_buffer: int = 1        # stop one short of the limit
    consecutive_error_limit: int = 5        # circuit-breaker trip point
    take_profit_pct: float = 0.03
    stop_loss_pct: float = 0.02
    max_holding_days: int = 5

    @classmethod
    def from_env(cls) -> "RiskConfig":
        return cls(
            starting_equity=env_float("STARTING_EQUITY", 30.0),
            max_position_pct=env_float("MAX_POSITION_PCT", 0.34),
            min_position_notional=env_float("MIN_POSITION_NOTIONAL", 1.00),
            max_open_positions=env_int("MAX_OPEN_POSITIONS", 3),
            max_trades_per_day=env_int("MAX_TRADES_PER_DAY", 6),
            max_daily_loss_pct=env_float("MAX_DAILY_LOSS_PCT", 0.06),
            max_drawdown_pct=env_float("MAX_DRAWDOWN_PCT", 0.20),
            min_net_ev_usd=env_float("MIN_NET_EV_USD", 0.005),
            min_net_ev_bps=env_float("MIN_NET_EV_BPS", 10.0),
            min_confidence=env_float("MIN_CONFIDENCE", 0.35),
            pdt_equity_threshold=env_float("PDT_EQUITY_THRESHOLD", 25_000.0),
            max_day_trades_window=env_int("MAX_DAY_TRADES_WINDOW", 3),
            day_trade_safety_buffer=env_int("DAY_TRADE_SAFETY_BUFFER", 1),
            consecutive_error_limit=env_int("CONSECUTIVE_ERROR_LIMIT", 5),
            take_profit_pct=env_float("TAKE_PROFIT_PCT", 0.03),
            stop_loss_pct=env_float("STOP_LOSS_PCT", 0.02),
            max_holding_days=env_int("MAX_HOLDING_DAYS", 5),
        )


@dataclass(frozen=True)
class SignalConfig:
    """Technical indicator windows and the seed weights for signal fusion."""

    fast_ma: int = 10
    slow_ma: int = 30
    rsi_period: int = 14
    rsi_oversold: float = 30.0
    rsi_overbought: float = 70.0
    momentum_period: int = 10
    volume_lookback: int = 20
    bars_lookback: int = 120
    sentiment_half_life_hours: float = 12.0
    seed_weights: dict[str, float] = field(
        default_factory=lambda: {
            "trend": 1.0,
            "mean_reversion": 1.0,
            "momentum": 1.0,
            "volume": 0.5,
            "sentiment": 1.0,
            "regime": 0.75,
        }
    )
    # Expected move used to translate a fused score into a gross EV, in bps.
    edge_scale_bps: float = 120.0

    @classmethod
    def from_env(cls) -> "SignalConfig":
        return cls(
            fast_ma=env_int("FAST_MA", 10),
            slow_ma=env_int("SLOW_MA", 30),
            rsi_period=env_int("RSI_PERIOD", 14),
            rsi_oversold=env_float("RSI_OVERSOLD", 30.0),
            rsi_overbought=env_float("RSI_OVERBOUGHT", 70.0),
            momentum_period=env_int("MOMENTUM_PERIOD", 10),
            volume_lookback=env_int("VOLUME_LOOKBACK", 20),
            bars_lookback=env_int("BARS_LOOKBACK", 120),
            sentiment_half_life_hours=env_float("SENTIMENT_HALF_LIFE_HOURS", 12.0),
            edge_scale_bps=env_float("EDGE_SCALE_BPS", 120.0),
        )


@dataclass(frozen=True)
class Settings:
    """Top-level configuration for a run."""

    alpaca_api_key: str = ""
    alpaca_secret_key: str = ""
    alpaca_base_url: str = PAPER_URL
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    news_api_key: str = ""
    news_provider: str = "alpaca"
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    alert_email: str = ""
    smtp_url: str = ""
    database_url: str = "trading_bot.db"
    universe: tuple[str, ...] = ("SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMD", "TSLA", "F")
    benchmark: str = "SPY"
    experiment_days: int = 30
    dry_run: bool = False
    log_level: str = "INFO"
    log_file: str = "logs/trading_bot.jsonl"
    timezone: str = "America/New_York"
    trade_interval_minutes: int = 15
    news_interval_minutes: int = 20
    costs: CostConfig = field(default_factory=CostConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    signals: SignalConfig = field(default_factory=SignalConfig)

    @property
    def is_paper(self) -> bool:
        return "paper" in self.alpaca_base_url

    @property
    def is_live(self) -> bool:
        return not self.is_paper

    def redacted(self) -> dict[str, Any]:
        """Config snapshot safe to write into logs."""
        secret_names = {
            "alpaca_api_key",
            "alpaca_secret_key",
            "anthropic_api_key",
            "news_api_key",
            "telegram_bot_token",
            "smtp_url",
        }
        out: dict[str, Any] = {}
        for f in fields(self):
            value = getattr(self, f.name)
            if f.name in secret_names:
                out[f.name] = "***set***" if value else ""
            elif hasattr(value, "__dataclass_fields__"):
                out[f.name] = {k.name: getattr(value, k.name) for k in fields(value)}
            elif isinstance(value, tuple):
                out[f.name] = list(value)
            else:
                out[f.name] = value
        return out

    @classmethod
    def from_env(cls, *, dotenv: str | os.PathLike[str] | None = ".env") -> "Settings":
        if dotenv is not None:
            load_dotenv(dotenv)
        base_url = env_str("ALPACA_BASE_URL", PAPER_URL).rstrip("/")
        return cls(
            alpaca_api_key=env_str("ALPACA_API_KEY"),
            alpaca_secret_key=env_str("ALPACA_SECRET_KEY"),
            alpaca_base_url=base_url,
            anthropic_api_key=env_str("ANTHROPIC_API_KEY"),
            anthropic_model=env_str("ANTHROPIC_MODEL", "claude-sonnet-5"),
            news_api_key=env_str("NEWS_API_KEY"),
            news_provider=env_str("NEWS_PROVIDER", "alpaca").lower(),
            telegram_bot_token=env_str("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=env_str("TELEGRAM_CHAT_ID"),
            alert_email=env_str("ALERT_EMAIL"),
            smtp_url=env_str("SMTP_URL"),
            database_url=env_str("DATABASE_URL", "trading_bot.db"),
            universe=env_list("UNIVERSE", ("SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMD", "TSLA", "F")),
            benchmark=env_str("BENCHMARK", "SPY").upper(),
            experiment_days=env_int("EXPERIMENT_DAYS", 30),
            dry_run=env_bool("DRY_RUN", False),
            log_level=env_str("LOG_LEVEL", "INFO").upper(),
            log_file=env_str("LOG_FILE", "logs/trading_bot.jsonl"),
            timezone=env_str("TIMEZONE", "America/New_York"),
            trade_interval_minutes=env_int("TRADE_INTERVAL_MINUTES", 15),
            news_interval_minutes=env_int("NEWS_INTERVAL_MINUTES", 20),
            costs=CostConfig.from_env(),
            risk=RiskConfig.from_env(),
            signals=SignalConfig.from_env(),
        )

    def validate(self) -> list[str]:
        """Return a list of blocking problems; empty means good to run."""
        problems: list[str] = []
        if not self.alpaca_api_key or not self.alpaca_secret_key:
            problems.append("ALPACA_API_KEY / ALPACA_SECRET_KEY are required.")
        if self.alpaca_base_url not in (PAPER_URL, LIVE_URL) and "alpaca.markets" not in self.alpaca_base_url:
            problems.append(f"ALPACA_BASE_URL looks wrong: {self.alpaca_base_url!r}")
        if not self.universe:
            problems.append("UNIVERSE is empty; nothing to trade.")
        if self.risk.starting_equity <= 0:
            problems.append("STARTING_EQUITY must be positive.")
        if not 0 < self.risk.max_position_pct <= 1:
            problems.append("MAX_POSITION_PCT must be within (0, 1].")
        return problems

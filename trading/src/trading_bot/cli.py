"""Command line interface.

    python -m trading_bot check              # validate config + broker connectivity
    python -m trading_bot start-experiment   # mark day 0 of the 30-day run
    python -m trading_bot run                # the 24/7 scheduler
    python -m trading_bot cycle              # one trading cycle, then exit
    python -m trading_bot news               # one ingest + classify pass
    python -m trading_bot learn              # nightly learning loop
    python -m trading_bot report [--final]   # daily or final report
    python -m trading_bot dashboard          # rebuild the HTML dashboard
    python -m trading_bot status             # account, risk and metrics snapshot
    python -m trading_bot kill-switch on|off|status
    python -m trading_bot flatten            # cancel orders, close positions
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import timedelta, timezone
from typing import Any, Sequence

from .clock import utcnow
from .config import LIVE_URL, PAPER_URL, Settings
from .db import Store
from .engine import TradingEngine
from .logging_setup import setup_logging
from .reporting import daily_report, final_report, write_dashboard


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trading_bot", description="Autonomous multi-agent trading bot (Alpaca)."
    )
    parser.add_argument("--env-file", default=".env", help="path to the .env file (default: .env)")
    parser.add_argument("--log-level", default=None, help="override LOG_LEVEL")
    parser.add_argument("--json", action="store_true", help="print machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="validate configuration and broker connectivity")
    sub.add_parser("start-experiment", help="record day 0 of the experiment")
    run = sub.add_parser("run", help="run the 24/7 scheduler")
    run.add_argument("--poll-seconds", type=float, default=20.0)
    sub.add_parser("cycle", help="run a single trading cycle")
    news = sub.add_parser("news", help="ingest and classify news once")
    news.add_argument("--hours", type=float, default=6.0)
    sub.add_parser("learn", help="run the nightly learning loop")
    sub.add_parser("nightly", help="run the full post-close job")
    report = sub.add_parser("report", help="print the daily or final report")
    report.add_argument("--final", action="store_true", help="print the 30-day final report")
    report.add_argument("--day", default=None, help="YYYY-MM-DD (default: today)")
    dashboard = sub.add_parser("dashboard", help="write the HTML dashboard")
    dashboard.add_argument("--out", default="reports/dashboard.html")
    status_cmd = sub.add_parser("status", help="print account, risk and metrics status")
    status_cmd.add_argument(
        "--strict", action="store_true",
        help="exit non-zero when unhealthy (for container healthchecks)",
    )

    simulate = sub.add_parser(
        "simulate", help="validate the whole environment offline, no credentials needed"
    )
    simulate.add_argument("--days", type=int, default=5, help="simulated trading days (default 5)")
    simulate.add_argument("--seed", type=int, default=42, help="price seed; same seed, same run")
    simulate.add_argument("--step-minutes", type=int, default=5, help="simulation granularity")
    simulate.add_argument("--start", default=None, help="YYYY-MM-DD to start from")
    simulate.add_argument("--reject-rate", type=float, default=0.0,
                          help="fraction of orders the broker rejects, to exercise error paths")
    simulate.add_argument("--outage-rate", type=float, default=0.0,
                          help="fraction of API calls that fail, to exercise the circuit breaker")

    calendar_cmd = sub.add_parser("calendar", help="show or list exchange trading calendars")
    calendar_cmd.add_argument("--list", action="store_true", help="list the built-in profiles")

    backtest = sub.add_parser("backtest", help="replay the strategy over historical bars")
    _add_data_args(backtest)
    backtest.add_argument("--warmup", type=int, default=None, help="bars reserved to prime indicators")

    calibrate_cmd = sub.add_parser(
        "calibrate", help="grid-search the strategy parameters over history"
    )
    _add_data_args(calibrate_cmd)
    calibrate_cmd.add_argument("--min-trades", type=int, default=10,
                               help="closed trades required before a result counts (default 10)")
    calibrate_cmd.add_argument("--out-of-sample", type=float, default=0.3,
                               help="fraction of history held back for validation (0 disables)")
    kill = sub.add_parser("kill-switch", help="engage or release the kill switch")
    kill.add_argument("action", choices=["on", "off", "status"])
    kill.add_argument("--reason", default="manual")
    flatten = sub.add_parser("flatten", help="cancel all orders and close all positions")
    flatten.add_argument("--reason", default="manual")
    flatten.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    return parser


def _add_data_args(parser: argparse.ArgumentParser) -> None:
    """Arguments shared by the history-driven commands."""
    parser.add_argument("--symbols", default=None, help="comma-separated; defaults to UNIVERSE")
    parser.add_argument("--source", default="alpaca", choices=["alpaca", "csv", "yfinance"])
    parser.add_argument("--timeframe", default="1Day", help="1Day, 1Hour, 15Min ...")
    parser.add_argument("--limit", type=int, default=750, help="bars per symbol (alpaca source)")
    parser.add_argument("--days", type=int, default=730, help="lookback in days (yfinance source)")
    parser.add_argument("--csv-dir", default=".", help="directory holding <SYMBOL>.csv")
    parser.add_argument("--start", default=None, help="YYYY-MM-DD; overrides --limit/--days")
    parser.add_argument("--end", default=None, help="YYYY-MM-DD (default: today)")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = Settings.from_env(dotenv=args.env_file)
        setup_logging(args.log_level or settings.log_level, settings.log_file)
    except OSError as exc:
        # An unwritable log path or a full disk must say so once, not restart in
        # a loop under `restart: unless-stopped`.
        print(f"No se pudo inicializar la configuración o el logging: {exc}", file=sys.stderr)
        return 2

    if args.command == "check":
        return _check(settings, as_json=args.json)

    # Commands that never talk to the broker must work without credentials:
    # the calendar, the offline simulator, and reports read from the database.
    if args.command == "calendar":
        return _calendar(args, settings)
    if args.command == "simulate":
        return _simulate(args, settings)
    if args.command in ("report", "dashboard"):
        store = Store(settings.database_url)
        try:
            return _reporting(args, settings, store)
        finally:
            store.close()
    if args.command in ("backtest", "calibrate") and args.source != "alpaca":
        store = Store(settings.database_url)
        try:
            return _run_history_command(args, settings, broker=None)
        finally:
            store.close()

    try:
        engine = TradingEngine(settings)
    except (OSError, ValueError) as exc:
        print(f"No se pudo iniciar el motor: {exc}", file=sys.stderr)
        return 2
    try:
        return _dispatch(args, settings, engine)
    finally:
        engine.close()


def _dispatch(args: argparse.Namespace, settings: Settings, engine: TradingEngine) -> int:
    command = args.command

    if command == "start-experiment":
        _emit(engine.start_experiment(), as_json=args.json)
        return 0

    if command == "run":
        from .scheduler import BotScheduler

        BotScheduler(settings, engine).run_forever(poll_seconds=args.poll_seconds)
        return 0

    if command == "cycle":
        _emit(engine.trading_cycle(), as_json=args.json)
        return 0

    if command == "news":
        _emit(engine.news_cycle(lookback_hours=args.hours), as_json=args.json)
        return 0

    if command == "learn":
        _emit(engine.learning.run(), as_json=args.json)
        return 0

    if command == "nightly":
        _emit(engine.nightly(), as_json=args.json)
        return 0

    if command == "simulate":
        return _simulate(args, settings)

    if command == "calendar":
        return _calendar(args, settings)

    if command in ("backtest", "calibrate"):
        return _run_history_command(args, settings, broker=engine.broker)

    if command == "status":
        payload = engine.status()
        _emit(payload, as_json=True)
        # Exit code carries the verdict so a container healthcheck or an uptime
        # monitor can act on it; printing JSON and always returning 0 meant the
        # Docker HEALTHCHECK could never fail for any reason that mattered.
        if args.strict:
            return 0 if _status_is_healthy(payload, settings) else 1
        return 0

    if command == "kill-switch":
        if args.action == "on":
            engine.engage_kill_switch(args.reason)
        elif args.action == "off":
            engine.release_kill_switch(args.reason)
        _emit(engine.store.get_state("kill_switch") or {"active": False}, as_json=args.json)
        return 0

    if command == "flatten":
        if not args.yes and not _confirm(settings):
            print("Cancelado.")
            return 1
        _emit(engine.flatten_all(args.reason), as_json=args.json)
        return 0

    return 1


def _status_is_healthy(payload: dict[str, Any], settings: Settings) -> bool:
    """Whether `status` should report success to a healthcheck."""
    if payload.get("broker_error"):
        return False
    if (payload.get("kill_switch") or {}).get("active"):
        return False
    if (payload.get("circuit_trading") or {}).get("open_until"):
        return False
    last_tick = payload.get("last_tick_age_seconds")
    if last_tick is not None:
        # Two missed cycles means the scheduler is not running.
        return last_tick <= settings.trade_interval_minutes * 60 * 2
    return True


def _reporting(args: argparse.Namespace, settings: Settings, store: Store) -> int:
    """`report` and `dashboard` only read the database - no broker involved."""
    if args.command == "report":
        report = (
            final_report(settings, store)
            if args.final
            else daily_report(settings, store, args.day)
        )
        if args.json:
            print(json.dumps(report, indent=2, default=str))
        else:
            print(report["text"])
        return 0

    path = write_dashboard(settings, store, args.out)
    _emit({"dashboard": str(path)}, as_json=args.json)
    return 0


def _simulate(args: argparse.Namespace, settings: Settings) -> int:
    """Offline end-to-end validation; exit code 1 if any check failed."""
    from datetime import date as _date

    from .simulation import run_simulation

    start = _date.fromisoformat(args.start) if args.start else None
    report = run_simulation(
        settings,
        days=args.days,
        seed=args.seed,
        step_minutes=args.step_minutes,
        start=start,
        reject_rate=args.reject_rate,
        outage_rate=args.outage_rate,
    )
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, default=str))
    else:
        print(report.text())
    return 0 if report.passed else 1


def _calendar(args: argparse.Namespace, settings: Settings) -> int:
    from .calendars import available, load_calendar

    if args.list:
        rows = available()
        if args.json:
            print(json.dumps(rows, indent=2))
        else:
            print("Calendarios disponibles (EXCHANGE=...):")
            for row in rows:
                print(f"  {row['code']:<6} {row['hours']:<24} {row['timezone']:<20} {row['name']}")
            print("\n  Personalizado: define EXCHANGE_CALENDAR_FILE=ruta/a/calendario.json")
        return 0

    calendar = load_calendar(
        settings.exchange,
        path=settings.exchange_calendar_file or None,
        extra_holidays=settings.exchange_extra_holidays,
    )
    payload = calendar.describe()
    if args.json:
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(f"{payload['code']} — {payload['name']}")
        print(f"  Zona horaria:   {payload['timezone']} (hora local {payload['local_time']})")
        print(f"  Horario regular:" + " " + " / ".join(
            f"{w['start']}-{w['end']}" for w in payload["regular"]
        ))
        if payload["premarket"]:
            print(f"  Pre-market:     {payload['premarket']['start']}-{payload['premarket']['end']}")
        if payload["afterhours"]:
            print(f"  Post-market:    {payload['afterhours']['start']}-{payload['afterhours']['end']}")
        print(f"  Sesión actual:  {payload['session']}")
        print(f"  Próxima apertura: {payload['next_open']}")
        print(f"  Próximo cierre:   {payload['next_close']}")
        print(f"  Feriados este año: {', '.join(payload['holidays_this_year']) or 'ninguno'}")
        if payload["notes"]:
            print(f"  Nota: {payload['notes']}")
    return 0


def _load_history(args: argparse.Namespace, settings: Settings, broker: Any | None):
    """Load bars for the requested symbols, always including the benchmark."""
    from .backtest import load_bars

    symbols = [s.strip().upper() for s in args.symbols.split(",")] if args.symbols else list(
        settings.universe
    )
    if settings.benchmark not in symbols:
        symbols.append(settings.benchmark)

    start = _as_utc_date(getattr(args, "start", None))
    end = _as_utc_date(getattr(args, "end", None))
    limit = args.limit
    if start is not None:
        # An explicit range is the honest way to ask for "since 2020"; derive the
        # bar count from it so the broker request covers the whole window.
        span_days = max((_as_utc_date(args.end) or utcnow()) - start, timedelta(days=1)).days
        limit = max(limit, _bars_for(span_days, args.timeframe))

    return load_bars(
        symbols,
        source=args.source,
        broker=broker,
        timeframe=args.timeframe,
        limit=limit,
        days=args.days,
        csv_dir=args.csv_dir,
        start=start,
        end=end,
    )


def _as_utc_date(value: str | None):
    if not value:
        return None
    from datetime import datetime as _dt

    try:
        return _dt.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise SystemExit(f"Fecha inválida {value!r}: usa YYYY-MM-DD") from exc


def _bars_for(span_days: int, timeframe: str) -> int:
    """How many bars of ``timeframe`` fit in a calendar span."""
    from .brokers.alpaca import _timeframe_parts

    amount, unit = _timeframe_parts(timeframe)
    amount = max(amount, 1)
    trading_days = span_days * 252 / 365
    per_day = {"day": 1 / amount, "week": 1 / (5 * amount), "hour": 6.5 / amount}.get(
        unit, 390 / amount
    )
    return int(trading_days * per_day) + 10


def _run_history_command(
    args: argparse.Namespace, settings: Settings, *, broker: Any | None = None
) -> int:
    from .backtest import calibrate, run_backtest

    bars = _load_history(args, settings, broker)
    if not bars:
        print("No se pudieron cargar barras. Revisa --source, las credenciales o los símbolos.")
        return 1

    if args.command == "backtest":
        try:
            result = run_backtest(settings, bars, warmup=args.warmup)
        except ValueError as exc:
            print(f"No se pudo simular: {exc}")
            return 1
        if args.json:
            print(json.dumps(result.summary(), indent=2, default=str))
        else:
            print(_backtest_text(result, settings))
        return 0

    report = calibrate(
        settings,
        bars,
        min_trades=args.min_trades,
        out_of_sample_fraction=args.out_of_sample,
    )
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, default=str))
    else:
        print(report.text())
    return 0


def _backtest_text(result: Any, settings: Settings) -> str:
    summary = result.summary()
    metrics = result.metrics
    span = ""
    first, last = result.metrics.extra.get("span_years"), None
    if summary["start"] and summary["end"]:
        from .clock import parse_iso

        a, b = parse_iso(summary["start"]), parse_iso(summary["end"])
        if a and b:
            span = f", {(b - a).days / 365.25:.1f} años"
    lines = [
        f"Backtest {', '.join(summary['symbols'])}",
        f"  Periodo:        {(summary['start'] or '')[:10]} → {(summary['end'] or '')[:10]}"
        f"  ({summary['bars']} barras{span})",
        f"  Capital inicial:${metrics.start_equity:,.2f}  →  final ${metrics.current_equity:,.2f}",
        f"  P&L neto:       ${metrics.net_pnl:,.4f}  ({metrics.return_pct * 100:+.2f}%)",
        f"  Trades:         {metrics.trades_total} "
        f"({metrics.wins}W/{metrics.losses}L, win rate {metrics.win_rate * 100:.1f}%)",
        f"  Expectativa:    ${metrics.expectancy:,.5f} por trade",
        f"  Costos totales: ${metrics.total_fees:,.4f}"
        + (
            f"  (fees/P&L bruto: {metrics.fee_to_pnl_ratio:.2f})"
            if metrics.fee_to_pnl_ratio is not None
            else ""
        ),
        f"  Drawdown máx.:  {metrics.max_drawdown_pct * 100:.2f}%",
        f"  Benchmark {settings.benchmark}:  "
        + (
            f"{metrics.benchmark_return_pct * 100:+.2f}%  "
            f"(exceso {metrics.excess_return_pct * 100:+.2f}%)"
            if metrics.benchmark_return_pct is not None
            else "sin datos"
        ),
    ]
    if summary.get("universe_buy_hold_pct") is not None:
        lines.append(
            f"  Comprar y mantener la misma canasta:  "
            f"{summary['universe_buy_hold_pct'] * 100:+.2f}%  "
            f"(exceso {summary['excess_vs_universe_pct'] * 100:+.2f}%)"
        )
        lines.append(
            "    ↑ esta es la comparación que aísla la estrategia de la elección de símbolos"
        )
    if summary["top_rejections"]:
        lines.append("  Motivos de rechazo: " + ", ".join(
            f"{k}={v}" for k, v in summary["top_rejections"].items()
        ))
    if metrics.trades_total < 10:
        lines.append("")
        lines.append("  AVISO: menos de 10 trades cerrados; la muestra no permite concluir nada.")
    lines.append("")
    lines.append("  El backtest no incluye sentimiento de noticias (no es reproducible")
    lines.append("  hacia atrás) y asume que el stop se ejecuta antes que el objetivo")
    lines.append("  cuando ambos caben en la misma barra.")
    return "\n".join(lines)


def _check(settings: Settings, *, as_json: bool = True) -> int:
    """Validate configuration and, if credentials exist, reach the broker."""
    problems = settings.validate()
    from .calendars import load_calendar

    result: dict[str, Any] = {
        "mode": "paper" if settings.is_paper else "live",
        "base_url": settings.alpaca_base_url,
        "exchange": settings.exchange,
        "universe": list(settings.universe),
        "database": settings.database_url,
        "problems": problems,
        "news_sources": ["alpaca"] + ([settings.news_provider] if settings.news_api_key else []),
        "sentiment": "claude" if settings.anthropic_api_key else "lexicon-fallback",
    }

    if not problems:
        result["calendar"] = load_calendar(
            settings.exchange,
            path=settings.exchange_calendar_file or None,
            extra_holidays=settings.exchange_extra_holidays,
        ).describe()
        try:
            engine = TradingEngine(settings)
            account = engine.broker.get_account()
            posture = engine.risk.account_posture(account)
            result["account"] = {
                "equity": account.equity,
                "cash": account.cash,
                "buying_power": account.buying_power,
                **posture.as_dict(),
            }
            result["session"] = engine.broker.session()
            result["market_data"] = engine.data.describe()
            engine.close()
        except Exception as exc:  # noqa: BLE001 - report, do not crash
            result["broker_error"] = str(exc)

    if settings.is_live:
        result["warning"] = (
            "ALPACA_BASE_URL apunta a LIVE: se operará con dinero real. "
            f"Usa {PAPER_URL} para paper trading."
        )

    _emit(result, as_json=True)
    return 1 if problems or "broker_error" in result else 0


def _confirm(settings: Settings) -> bool:
    mode = "PAPER" if settings.is_paper else "LIVE (dinero real)"
    answer = input(f"Cerrar TODAS las posiciones en {mode}. Escribe 'si' para confirmar: ")
    return answer.strip().lower() in {"si", "sí", "yes", "y"}


def _emit(payload: Any, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, default=str))
    elif isinstance(payload, dict):
        for key, value in payload.items():
            print(f"{key}: {value}")
    else:
        print(payload)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

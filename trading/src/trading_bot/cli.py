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
from typing import Any, Sequence

from .config import LIVE_URL, PAPER_URL, Settings
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
    sub.add_parser("status", help="print account, risk and metrics status")
    kill = sub.add_parser("kill-switch", help="engage or release the kill switch")
    kill.add_argument("action", choices=["on", "off", "status"])
    kill.add_argument("--reason", default="manual")
    flatten = sub.add_parser("flatten", help="cancel all orders and close all positions")
    flatten.add_argument("--reason", default="manual")
    flatten.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = Settings.from_env(dotenv=args.env_file)
    setup_logging(args.log_level or settings.log_level, settings.log_file)

    if args.command == "check":
        return _check(settings, as_json=args.json)

    engine = TradingEngine(settings)
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

    if command == "report":
        report = (
            final_report(settings, engine.store)
            if args.final
            else daily_report(settings, engine.store, args.day)
        )
        if args.json:
            print(json.dumps(report, indent=2, default=str))
        else:
            print(report["text"])
        return 0

    if command == "dashboard":
        path = write_dashboard(settings, engine.store, args.out)
        _emit({"dashboard": str(path)}, as_json=args.json)
        return 0

    if command == "status":
        _emit(engine.status(), as_json=True)
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


def _check(settings: Settings, *, as_json: bool = True) -> int:
    """Validate configuration and, if credentials exist, reach the broker."""
    problems = settings.validate()
    result: dict[str, Any] = {
        "mode": "paper" if settings.is_paper else "live",
        "base_url": settings.alpaca_base_url,
        "universe": list(settings.universe),
        "database": settings.database_url,
        "problems": problems,
        "news_sources": ["alpaca"] + ([settings.news_provider] if settings.news_api_key else []),
        "sentiment": "claude" if settings.anthropic_api_key else "lexicon-fallback",
    }

    if not problems:
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

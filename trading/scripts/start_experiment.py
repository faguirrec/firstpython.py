#!/usr/bin/env python3
"""Arranque del experimento de 30 días.

Hace las verificaciones previas, marca el día 0 y deja el bot corriendo con el
logging listo para el reporte final:

    python scripts/start_experiment.py                 # verifica y arranca
    python scripts/start_experiment.py --dry-run       # sin enviar órdenes
    python scripts/start_experiment.py --check-only    # solo verifica

En modo live pide confirmación explícita: con $30 el error caro no es perder el
capital, es creer que estabas en paper.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from trading_bot.config import PAPER_URL, Settings  # noqa: E402
from trading_bot.engine import TradingEngine  # noqa: E402
from trading_bot.logging_setup import setup_logging  # noqa: E402
from trading_bot.scheduler import BotScheduler  # noqa: E402


def preflight(engine: TradingEngine) -> list[str]:
    """Comprobaciones que deben pasar antes de arriesgar capital."""
    problems: list[str] = []
    settings = engine.settings

    account = engine.broker.get_account()
    posture = engine.risk.account_posture(account)

    print(f"  Modo:            {'PAPER' if settings.is_paper else 'LIVE'}")
    print(f"  Cuenta:          {'cash' if posture.is_cash_account else 'margin'}")
    print(f"  Equity:          ${account.equity:,.2f}")
    print(f"  Efectivo usable: ${posture.settled_cash:,.2f}")
    print(f"  Day trades:      {posture.day_trades_used} usados, {posture.day_trades_remaining} disponibles")
    print(f"  PDT restringido: {'sí' if posture.pdt_restricted else 'no'}")
    print(f"  Sesión:          {engine.broker.session()}")
    print(f"  Universo:        {', '.join(settings.universe)}")
    print(f"  Sentimiento:     {'Claude' if settings.anthropic_api_key else 'léxico de respaldo'}")
    print(f"  Alertas:         {', '.join(engine.alerter.channels) or 'solo logs'}")

    if account.trading_blocked or account.account_blocked:
        problems.append("La cuenta está bloqueada para operar.")
    if account.equity <= 0:
        problems.append("La cuenta no tiene equity.")
    if posture.settled_cash < settings.risk.min_position_notional:
        problems.append(
            f"Efectivo liquidado (${posture.settled_cash:,.2f}) por debajo del mínimo "
            f"por orden (${settings.risk.min_position_notional:,.2f})."
        )
    if account.equity < settings.risk.starting_equity * 0.5:
        problems.append(
            f"El equity (${account.equity:,.2f}) está muy por debajo del capital "
            f"declarado (${settings.risk.starting_equity:,.2f}); ajusta STARTING_EQUITY."
        )
    if not settings.anthropic_api_key:
        print("  AVISO: sin ANTHROPIC_API_KEY, NewsPulse usa el clasificador léxico.")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Arranca el experimento de 30 días.")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--dry-run", action="store_true", help="registra decisiones sin operar")
    parser.add_argument("--check-only", action="store_true", help="solo verifica y sale")
    parser.add_argument("--yes", action="store_true", help="omite la confirmación en modo live")
    args = parser.parse_args()

    if args.dry_run:
        os.environ["DRY_RUN"] = "true"

    settings = Settings.from_env(dotenv=args.env_file)
    setup_logging(settings.log_level, settings.log_file)

    problems = settings.validate()
    if problems:
        print("Configuración incompleta:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print("Verificación previa")
    engine = TradingEngine(settings)
    try:
        problems = preflight(engine)
        if problems:
            print("\nNo se puede arrancar:")
            for problem in problems:
                print(f"  - {problem}")
            return 1

        if settings.is_live and not args.yes:
            print(f"\nATENCIÓN: vas a operar con DINERO REAL. Para paper usa {PAPER_URL}.")
            if input("Escribe 'operar en live' para continuar: ").strip().lower() != "operar en live":
                print("Cancelado.")
                return 1

        if args.check_only:
            print("\nTodo listo. Vuelve a correr sin --check-only para arrancar.")
            return 0

        started = engine.start_experiment()
        print(f"\nExperimento: {json.dumps(started, default=str)}")
        print(f"Duración:    {settings.experiment_days} días")
        print(f"Base de datos: {settings.database_url}")
        print(f"Logs:          {settings.log_file}")
        print("\nCorriendo. Ctrl-C para detener (el estado queda en la base de datos).")
        print("Kill switch:   python -m trading_bot kill-switch on")
        print("Reporte final: python -m trading_bot report --final\n")

        BotScheduler(settings, engine).run_forever()
        return 0
    finally:
        engine.close()


if __name__ == "__main__":
    sys.exit(main())

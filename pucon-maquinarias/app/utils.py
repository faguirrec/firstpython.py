"""Utilidades de formato y validación."""
import re
from datetime import date, datetime


# --- RUT chileno ----------------------------------------------------------- #
def _dv(cuerpo: str) -> str:
    suma, factor = 0, 2
    for d in reversed(cuerpo):
        suma += int(d) * factor
        factor = 2 if factor == 7 else factor + 1
    resto = 11 - suma % 11
    return "0" if resto == 11 else "K" if resto == 10 else str(resto)


def normalizar_rut(texto: str) -> str | None:
    """Devuelve el RUT como `12345678-5`, o None si no es válido."""
    limpio = re.sub(r"[.\s-]", "", (texto or "")).upper()
    if not re.fullmatch(r"\d{7,8}[\dK]", limpio):
        return None
    cuerpo, dv = limpio[:-1], limpio[-1]
    return f"{cuerpo}-{dv}" if _dv(cuerpo) == dv else None


def formatear_rut(rut: str | None) -> str:
    if not rut or "-" not in rut:
        return rut or ""
    cuerpo, dv = rut.split("-")
    return f"{int(cuerpo):,}".replace(",", ".") + f"-{dv}"


# --- Números y fechas ------------------------------------------------------ #
def clp(valor) -> str:
    """1234567 -> $1.234.567"""
    v = int(valor or 0)
    signo = "-" if v < 0 else ""
    return f"{signo}${abs(v):,}".replace(",", ".")


def fecha_corta(valor) -> str:
    if not valor:
        return "—"
    return valor.strftime("%d-%m-%Y")


def entero(texto, defecto: int = 0) -> int:
    """Lee un entero de un formulario tolerando $, puntos y espacios."""
    if texto is None:
        return defecto
    limpio = re.sub(r"[^\d-]", "", str(texto))
    try:
        return int(limpio)
    except ValueError:
        return defecto


def entero_opcional(texto) -> int | None:
    if texto is None or not str(texto).strip():
        return None
    v = entero(texto, -1)
    return v if v > 0 else None


def parse_fecha(texto) -> date | None:
    try:
        return datetime.strptime((texto or "").strip(), "%Y-%m-%d").date()
    except ValueError:
        return None


MESES = ["", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

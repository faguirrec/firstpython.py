import time

from flask import Blueprint, flash, redirect, render_template, request, session, url_for, g

from ..extensions import db
from ..models import Usuario
from .comun import ruta_interna

bp = Blueprint("auth", __name__)

# Freno básico a la fuerza bruta: máximo de fallos por IP en una ventana.
# En memoria alcanza mientras corra una sola instancia.
_INTENTOS: dict[str, list[float]] = {}
MAX_FALLOS, VENTANA_S = 8, 15 * 60


def _bloqueado(clave: str) -> bool:
    ahora = time.time()
    recientes = [t for t in _INTENTOS.get(clave, []) if ahora - t < VENTANA_S]
    _INTENTOS[clave] = recientes
    return len(recientes) >= MAX_FALLOS


def _destino_seguro(destino: str | None) -> str:
    """Sólo redirige a rutas internas, para que /login?siguiente= no sirva de phishing."""
    return ruta_interna(destino) or url_for("dashboard.inicio")


@bp.route("/login", methods=["GET", "POST"])
def login():
    if g.get("usuario"):
        return redirect(url_for("dashboard.inicio"))
    if request.method == "POST":
        ip = request.remote_addr or "?"
        if _bloqueado(ip):
            flash("Demasiados intentos fallidos. Espera unos minutos.", "error")
            return render_template("login.html"), 429
        email = (request.form.get("email") or "").strip().lower()
        usuario = Usuario.query.filter_by(email=email).first()
        if usuario and usuario.activo and usuario.check_password(request.form.get("password", "")):
            _INTENTOS.pop(ip, None)
            session.clear()
            session["uid"] = usuario.id
            session.permanent = True
            return redirect(_destino_seguro(request.args.get("siguiente")))
        _INTENTOS.setdefault(ip, []).append(time.time())
        flash("Correo o contraseña incorrectos.", "error")
    return render_template("login.html")


@bp.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


@bp.route("/cuenta", methods=["GET", "POST"])
def cuenta():
    if request.method == "POST":
        actual = request.form.get("actual", "")
        nueva = request.form.get("nueva", "")
        if not g.usuario.check_password(actual):
            flash("La contraseña actual no es correcta.", "error")
        elif len(nueva) < 8:
            flash("La nueva contraseña debe tener al menos 8 caracteres.", "error")
        else:
            g.usuario.set_password(nueva)
            db.session.commit()
            flash("Contraseña actualizada.", "ok")
            return redirect(url_for("auth.cuenta"))
    return render_template("cuenta.html")

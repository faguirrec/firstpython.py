import logging
import os
import secrets
from datetime import date, timedelta

from flask import Flask, abort, g, redirect, render_template, request, session, url_for

from . import utils
from .extensions import db, migrate
from .models import Usuario

log = logging.getLogger(__name__)

# Rutas accesibles sin sesión iniciada.
RUTAS_PUBLICAS = {"auth.login", "salud", "static"}


def _uri_base_de_datos(base: str) -> str:
    uri = os.environ.get("DATABASE_URL")
    if not uri:
        os.makedirs(base, exist_ok=True)
        return "sqlite:///" + os.path.join(base, "pucon.db")
    # Los proveedores entregan "postgres://" o "postgresql://". SQLAlchemy 2.1
    # asume el driver psycopg 3 con ese esquema, pero en requirements.txt va
    # psycopg2: se fija el driver para que no dependa de la versión instalada.
    for esquema in ("postgres://", "postgresql://"):
        if uri.startswith(esquema):
            uri = "postgresql+psycopg2://" + uri[len(esquema):]
    return uri


def create_app(config: dict | None = None) -> Flask:
    app = Flask(__name__)
    en_produccion = os.environ.get("FLASK_ENV") == "production" or bool(os.environ.get("RENDER"))

    secreto = os.environ.get("SECRET_KEY")
    if not secreto:
        if en_produccion:
            raise RuntimeError("Falta SECRET_KEY: sin ella las sesiones no son seguras.")
        secreto = secrets.token_hex(32)  # sólo desarrollo: las sesiones no sobreviven reinicios

    app.config.update(
        SECRET_KEY=secreto,
        SQLALCHEMY_DATABASE_URI=_uri_base_de_datos(app.instance_path),
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=en_produccion,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
    )
    if config:
        app.config.update(config)

    if os.environ.get("TRUST_PROXY"):
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    migrate.init_app(app, db, directory=os.path.join(os.path.dirname(app.root_path), "migrations"))

    app.jinja_env.filters.update(
        clp=utils.clp, fecha=utils.fecha_corta, rut=utils.formatear_rut,
    )
    app.jinja_env.globals.update(hoy=date.today)

    from .views import register
    register(app)
    _registrar_seguridad(app)
    _registrar_contexto(app)
    _registrar_errores(app)

    with app.app_context():
        if app.config.get("TESTING"):
            db.create_all()
        else:
            # El esquema evoluciona con migraciones (carpeta migrations/), así los
            # cambios futuros no borran los datos del cliente.
            from flask_migrate import upgrade
            upgrade()
        from .seed import arrancar
        arrancar(app)

    from .seed import registrar_comandos
    registrar_comandos(app)
    return app


def _registrar_seguridad(app: Flask) -> None:
    @app.before_request
    def exigir_sesion_y_csrf():
        g.usuario = None
        uid = session.get("uid")
        if uid:
            usuario = db.session.get(Usuario, uid)
            if usuario and usuario.activo:
                g.usuario = usuario
            else:
                session.clear()

        if request.method == "POST":
            enviado = request.form.get("_csrf", "")
            esperado = session.get("_csrf", "")
            if not esperado or not secrets.compare_digest(enviado, esperado):
                abort(400, "Formulario vencido o inválido. Vuelve atrás y reintenta.")

        if request.endpoint in RUTAS_PUBLICAS or request.endpoint is None:
            return None
        if g.usuario is None:
            if "/api/" in request.path:
                abort(401)
            return redirect(url_for("auth.login", siguiente=request.full_path.rstrip("?")))
        return None

    @app.after_request
    def cabeceras(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        if request.endpoint != "static":
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp


def _registrar_contexto(app: Flask) -> None:
    def token_csrf() -> str:
        if "_csrf" not in session:
            session["_csrf"] = secrets.token_urlsafe(32)
        return session["_csrf"]

    @app.context_processor
    def inyectar():
        from . import services
        return {
            "csrf_token": token_csrf,
            "usuario": g.get("usuario"),
            "empresa": services.todos_los_settings(),
        }


def _registrar_errores(app: Flask) -> None:
    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    def error(e):
        return render_template("error.html", codigo=e.code, mensaje=e.description), e.code

    @app.errorhandler(500)
    def error_interno(e):
        db.session.rollback()
        return render_template("error.html", codigo=500,
                               mensaje="Algo salió mal de nuestro lado."), 500

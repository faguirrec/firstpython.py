from flask import jsonify


def register(app):
    from . import (
        arriendos, auth, clientes, cotizaciones, dashboard, finanzas, inventario, admin,
    )
    for modulo in (auth, dashboard, clientes, inventario, cotizaciones, arriendos, finanzas, admin):
        app.register_blueprint(modulo.bp)

    @app.get("/salud", endpoint="salud")
    def salud():
        from ..extensions import db
        db.session.execute(db.text("select 1"))
        return jsonify(ok=True)

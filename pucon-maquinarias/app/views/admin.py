from flask import Blueprint, flash, g, redirect, render_template, request, url_for

from .. import services
from ..extensions import db
from ..models import Usuario
from .comun import solo_admin

bp = Blueprint("admin", __name__)

CAMPOS_EMPRESA = [
    "empresa_nombre", "empresa_rut", "empresa_giro", "empresa_direccion",
    "empresa_telefono", "empresa_email", "iva_pct", "validez_dias",
    "condiciones_cotizacion", "condiciones_arriendo",
]


@bp.route("/configuracion", methods=["GET", "POST"])
@solo_admin
def configuracion():
    if request.method == "POST":
        try:
            iva = int(request.form.get("iva_pct", ""))
            validez = int(request.form.get("validez_dias", ""))
            assert 0 <= iva <= 100 and 1 <= validez <= 365
        except (ValueError, AssertionError):
            flash("IVA (0–100) y validez (1–365 días) deben ser números válidos.", "error")
            return redirect(url_for("admin.configuracion"))
        for campo in CAMPOS_EMPRESA:
            services.guardar_setting(campo, (request.form.get(campo) or "").strip())
        db.session.commit()
        flash("Configuración guardada.", "ok")
        return redirect(url_for("admin.configuracion"))
    return render_template("configuracion.html", cfg=services.todos_los_settings())


@bp.get("/usuarios")
@solo_admin
def usuarios():
    return render_template("usuarios.html", usuarios=Usuario.query.order_by(Usuario.nombre).all(),
                           roles=Usuario.ROLES)


@bp.post("/usuarios")
@solo_admin
def crear_usuario():
    nombre = (request.form.get("nombre") or "").strip()
    email = (request.form.get("email") or "").strip().lower()
    clave = request.form.get("password", "")
    rol = request.form.get("rol")
    if not nombre or "@" not in email or rol not in Usuario.ROLES:
        flash("Completa nombre, correo y rol.", "error")
    elif len(clave) < 8:
        flash("La contraseña debe tener al menos 8 caracteres.", "error")
    elif Usuario.query.filter_by(email=email).first():
        flash("Ya existe un usuario con ese correo.", "error")
    else:
        u = Usuario(nombre=nombre, email=email, rol=rol)
        u.set_password(clave)
        db.session.add(u)
        db.session.commit()
        flash("Usuario creado.", "ok")
    return redirect(url_for("admin.usuarios"))


@bp.post("/usuarios/<int:id>/activar")
@solo_admin
def alternar_usuario(id):
    u = db.get_or_404(Usuario, id)
    if u.id == g.usuario.id:
        flash("No puedes desactivar tu propia cuenta.", "error")
    else:
        u.activo = not u.activo
        db.session.commit()
        flash("Usuario activado." if u.activo else "Usuario desactivado.", "ok")
    return redirect(url_for("admin.usuarios"))


@bp.post("/usuarios/<int:id>/clave")
@solo_admin
def restablecer_clave(id):
    u = db.get_or_404(Usuario, id)
    clave = request.form.get("password", "")
    if len(clave) < 8:
        flash("La contraseña debe tener al menos 8 caracteres.", "error")
    else:
        u.set_password(clave)
        db.session.commit()
        flash(f"Contraseña de {u.nombre} restablecida.", "ok")
    return redirect(url_for("admin.usuarios"))

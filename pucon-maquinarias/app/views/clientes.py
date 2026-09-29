from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from sqlalchemy import or_

from ..extensions import db
from ..models import Cliente
from ..utils import formatear_rut, normalizar_rut
from .comun import respuesta_csv, ruta_interna, solo_admin

bp = Blueprint("clientes", __name__, url_prefix="/clientes")


def _leer(form, cliente: Cliente | None = None):
    errores = []
    nombre = (form.get("nombre") or "").strip()
    if not nombre:
        errores.append("El nombre es obligatorio.")
    rut = None
    if (form.get("rut") or "").strip():
        rut = normalizar_rut(form["rut"])
        if rut is None:
            errores.append("El RUT no es válido.")
        else:
            otro = Cliente.query.filter_by(rut=rut).first()
            if otro and (cliente is None or otro.id != cliente.id):
                errores.append(f"Ya existe un cliente con ese RUT: {otro.nombre}.")
    email = (form.get("email") or "").strip() or None
    if email and "@" not in email:
        errores.append("El correo no parece válido.")
    tipo = form.get("tipo") if form.get("tipo") in Cliente.TIPOS else "persona"
    datos = {
        "tipo": tipo, "nombre": nombre, "rut": rut, "email": email,
        "contacto": (form.get("contacto") or "").strip() or None,
        "telefono": (form.get("telefono") or "").strip() or None,
        "direccion": (form.get("direccion") or "").strip() or None,
        "ciudad": (form.get("ciudad") or "").strip() or None,
        "notas": (form.get("notas") or "").strip() or None,
    }
    return datos, errores


@bp.get("/")
def lista():
    q = (request.args.get("q") or "").strip()
    consulta = Cliente.query.filter_by(activo=True)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(or_(
            Cliente.nombre.ilike(like), Cliente.rut.ilike(like.replace(".", "")),
            Cliente.email.ilike(like), Cliente.telefono.ilike(like),
            Cliente.contacto.ilike(like)))
    clientes = consulta.order_by(Cliente.nombre).all()
    return render_template("clientes/lista.html", clientes=clientes, q=q)


@bp.route("/nuevo", methods=["GET", "POST"])
def nuevo():
    if request.method == "POST":
        datos, errores = _leer(request.form)
        if not errores:
            cliente = Cliente(**datos)
            db.session.add(cliente)
            db.session.commit()
            flash("Cliente creado.", "ok")
            siguiente = ruta_interna(request.args.get("siguiente"))
            if siguiente:
                return redirect(f"{siguiente}{'&' if '?' in siguiente else '?'}cliente={cliente.id}")
            return redirect(url_for("clientes.detalle", id=cliente.id))
        for e in errores:
            flash(e, "error")
        return render_template("clientes/form.html", c=datos, titulo="Nuevo cliente"), 422
    return render_template("clientes/form.html", c={"tipo": "persona"}, titulo="Nuevo cliente")


@bp.get("/<int:id>")
def detalle(id):
    c = db.get_or_404(Cliente, id)
    return render_template("clientes/detalle.html", c=c)


@bp.route("/<int:id>/editar", methods=["GET", "POST"])
def editar(id):
    c = db.get_or_404(Cliente, id)
    if request.method == "POST":
        datos, errores = _leer(request.form, c)
        if not errores:
            for k, v in datos.items():
                setattr(c, k, v)
            db.session.commit()
            flash("Cliente actualizado.", "ok")
            return redirect(url_for("clientes.detalle", id=c.id))
        for e in errores:
            flash(e, "error")
        datos["id"] = c.id
        return render_template("clientes/form.html", c=datos, titulo="Editar cliente"), 422
    return render_template("clientes/form.html", c=c, titulo="Editar cliente")


@bp.post("/<int:id>/eliminar")
@solo_admin
def eliminar(id):
    c = db.get_or_404(Cliente, id)
    if c.arriendos or c.cotizaciones:
        # Con historial no se borra: se archiva para no perder los documentos.
        c.activo = False
        flash("El cliente tiene historial, así que se archivó en vez de borrarse.", "info")
    else:
        db.session.delete(c)
        flash("Cliente eliminado.", "ok")
    db.session.commit()
    return redirect(url_for("clientes.lista"))


@bp.get("/exportar.csv")
def exportar():
    filas = [
        (c.nombre, formatear_rut(c.rut), c.tipo, c.contacto or "", c.email or "",
         c.telefono or "", c.direccion or "", c.ciudad or "", c.saldo_pendiente)
        for c in Cliente.query.filter_by(activo=True).order_by(Cliente.nombre)
    ]
    return respuesta_csv(
        "clientes.csv",
        ["Nombre", "RUT", "Tipo", "Contacto", "Correo", "Teléfono", "Dirección", "Ciudad", "Saldo pendiente"],
        filas,
    )

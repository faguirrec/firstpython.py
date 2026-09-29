from flask import Blueprint, flash, g, redirect, render_template, request, url_for
from sqlalchemy import or_

from .. import services
from ..extensions import db
from ..models import Arriendo, ArriendoItem, Cliente, Cotizacion, CotizacionItem, hoy
from ..utils import entero
from .comun import catalogo_para_formulario, leer_documento, como_objeto

bp = Blueprint("cotizaciones", __name__, url_prefix="/cotizaciones")


def _formulario(cotizacion, titulo, status=200):
    clientes = Cliente.query.filter_by(activo=True).order_by(Cliente.nombre).all()
    return render_template(
        "cotizaciones/form.html", c=como_objeto(cotizacion), titulo=titulo, clientes=clientes,
        catalogo=catalogo_para_formulario(),
    ), status


def _aplicar(cot: Cotizacion, datos: dict, items: list[dict], form) -> None:
    for k, v in datos.items():
        setattr(cot, k, v)
    cot.validez_dias = max(1, entero(form.get("validez_dias"), int(services.setting("validez_dias") or 7)))
    cot.items = [
        CotizacionItem(equipo_id=i["equipo"].id, cantidad=i["cantidad"],
                       precio_unitario=i["precio_unitario"], descuento_pct=i["descuento_pct"])
        for i in items
    ]


def _borrador_desde_form(form, datos, items):
    """Estructura ligera para volver a pintar el formulario tras un error."""
    return {
        "cliente_id": entero(form.get("cliente_id"), 0), "validez_dias": form.get("validez_dias"),
        "flete": datos["flete"], "notas": datos["notas"],
        "fecha_inicio": datos["fecha_inicio"], "fecha_fin": datos["fecha_fin"],
        "items": [
            {"equipo_id": i["equipo"].id, "cantidad": i["cantidad"],
             "precio_unitario": i["precio_unitario"], "descuento_pct": i["descuento_pct"]}
            for i in items
        ],
    }


@bp.get("/")
def lista():
    q = (request.args.get("q") or "").strip()
    estado = request.args.get("estado", "")
    consulta = Cotizacion.query.join(Cliente)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(or_(Cotizacion.numero.ilike(like), Cliente.nombre.ilike(like)))
    cotizaciones = consulta.order_by(Cotizacion.id.desc()).all()
    if estado:
        cotizaciones = [c for c in cotizaciones if c.estado_efectivo == estado]
    return render_template("cotizaciones/lista.html", cotizaciones=cotizaciones, q=q, estado=estado)


@bp.route("/nueva", methods=["GET", "POST"])
def nueva():
    if request.method == "POST":
        datos, items, errores = leer_documento(request.form)
        cliente = db.session.get(Cliente, entero(request.form.get("cliente_id"), 0))
        if cliente is None:
            errores.append("Elige un cliente.")
        if errores:
            for e in errores:
                flash(e, "error")
            return _formulario(_borrador_desde_form(request.form, datos, items), "Nueva cotización", 422)
        cot = Cotizacion(numero=services.siguiente_numero("COT"), cliente_id=cliente.id,
                         iva_pct=services.iva_pct(), creado_por_id=g.usuario.id,
                         fecha_inicio=datos["fecha_inicio"], fecha_fin=datos["fecha_fin"])
        _aplicar(cot, datos, items, request.form)
        db.session.add(cot)
        db.session.commit()
        flash(f"Cotización {cot.numero} creada.", "ok")
        avisos = services.faltantes([(i["equipo"], i["cantidad"]) for i in items],
                                    cot.fecha_inicio, cot.fecha_fin)
        for a in avisos:
            flash("Ojo, hoy no alcanzaría el stock — " + a, "info")
        return redirect(url_for("cotizaciones.detalle", id=cot.id))
    from datetime import timedelta
    borrador = {
        "cliente_id": entero(request.args.get("cliente"), 0),
        "validez_dias": services.setting("validez_dias"), "flete": 0,
        "fecha_inicio": hoy(), "fecha_fin": hoy() + timedelta(days=1), "items": [],
        "notas": None,
    }
    return _formulario(borrador, "Nueva cotización")


@bp.get("/<int:id>")
def detalle(id):
    c = db.get_or_404(Cotizacion, id)
    return render_template("cotizaciones/detalle.html", c=c)


@bp.get("/<int:id>/imprimir")
def imprimir(id):
    c = db.get_or_404(Cotizacion, id)
    return render_template("cotizaciones/imprimir.html", c=c)


@bp.route("/<int:id>/editar", methods=["GET", "POST"])
def editar(id):
    cot = db.get_or_404(Cotizacion, id)
    if not cot.editable:
        flash("Esta cotización ya no se puede editar.", "error")
        return redirect(url_for("cotizaciones.detalle", id=id))
    if request.method == "POST":
        datos, items, errores = leer_documento(request.form)
        cliente = db.session.get(Cliente, entero(request.form.get("cliente_id"), 0))
        if cliente is None:
            errores.append("Elige un cliente.")
        if errores:
            for e in errores:
                flash(e, "error")
            b = _borrador_desde_form(request.form, datos, items)
            b["id"], b["numero"] = cot.id, cot.numero
            return _formulario(b, f"Editar {cot.numero}", 422)
        cot.cliente_id = cliente.id
        _aplicar(cot, datos, items, request.form)
        if cot.estado == "enviada":
            cot.estado = "borrador"  # cambió lo que se había enviado
        db.session.commit()
        flash("Cotización actualizada.", "ok")
        return redirect(url_for("cotizaciones.detalle", id=cot.id))
    return _formulario(cot, f"Editar {cot.numero}")


@bp.post("/<int:id>/estado")
def cambiar_estado(id):
    cot = db.get_or_404(Cotizacion, id)
    nuevo = request.form.get("estado")
    if cot.arriendo is not None:
        flash("La cotización ya se convirtió en arriendo.", "error")
    elif nuevo in ("borrador", "enviada", "aceptada", "rechazada"):
        cot.estado = nuevo
        db.session.commit()
        flash(f"Cotización marcada como {Cotizacion.ESTADOS[nuevo].lower()}.", "ok")
    return redirect(url_for("cotizaciones.detalle", id=id))


@bp.post("/<int:id>/duplicar")
def duplicar(id):
    o = db.get_or_404(Cotizacion, id)
    n = Cotizacion(
        numero=services.siguiente_numero("COT"), cliente_id=o.cliente_id, iva_pct=services.iva_pct(),
        validez_dias=o.validez_dias, fecha_inicio=o.fecha_inicio, fecha_fin=o.fecha_fin,
        flete=o.flete, notas=o.notas, creado_por_id=g.usuario.id,
        items=[CotizacionItem(equipo_id=i.equipo_id, cantidad=i.cantidad,
                              precio_unitario=i.precio_unitario, descuento_pct=i.descuento_pct)
               for i in o.items],
    )
    db.session.add(n)
    db.session.commit()
    flash(f"Copia creada como {n.numero}.", "ok")
    return redirect(url_for("cotizaciones.editar", id=n.id))


@bp.post("/<int:id>/convertir")
def convertir(id):
    cot = db.get_or_404(Cotizacion, id)
    if cot.arriendo is not None:
        return redirect(url_for("arriendos.detalle", id=cot.arriendo.id))
    errores = services.faltantes([(i.equipo, i.cantidad) for i in cot.items],
                                 max(cot.fecha_inicio, hoy()), cot.fecha_fin)
    if errores:
        for e in errores:
            flash(e, "error")
        return redirect(url_for("cotizaciones.detalle", id=id))
    arr = Arriendo(
        numero=services.siguiente_numero("ARR"), cliente_id=cot.cliente_id, cotizacion_id=cot.id,
        fecha_inicio=cot.fecha_inicio, fecha_fin=cot.fecha_fin, flete=cot.flete,
        iva_pct=cot.iva_pct, garantia_monto=cot.garantia_total, notas=cot.notas,
        creado_por_id=g.usuario.id,
        items=[ArriendoItem(equipo_id=i.equipo_id, cantidad=i.cantidad,
                            precio_unitario=i.precio_unitario, descuento_pct=i.descuento_pct)
               for i in cot.items],
    )
    cot.estado = "aceptada"
    db.session.add(arr)
    db.session.commit()
    flash(f"Arriendo {arr.numero} creado y equipos reservados.", "ok")
    return redirect(url_for("arriendos.detalle", id=arr.id))


@bp.post("/<int:id>/eliminar")
def eliminar(id):
    cot = db.get_or_404(Cotizacion, id)
    if cot.arriendo is not None or cot.estado == "aceptada":
        flash("No se puede eliminar una cotización aceptada o con arriendo.", "error")
        return redirect(url_for("cotizaciones.detalle", id=id))
    db.session.delete(cot)
    db.session.commit()
    flash("Cotización eliminada.", "ok")
    return redirect(url_for("cotizaciones.lista"))

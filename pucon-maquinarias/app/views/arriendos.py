from datetime import timedelta

from flask import Blueprint, flash, g, redirect, render_template, request, url_for
from sqlalchemy import or_

from .. import services
from ..extensions import db
from ..models import Arriendo, ArriendoItem, Cliente, Pago, hoy
from ..utils import entero, parse_fecha
from .comun import catalogo_para_formulario, leer_documento, como_objeto, solo_admin

bp = Blueprint("arriendos", __name__, url_prefix="/arriendos")


def _formulario(arr, titulo, status=200):
    clientes = Cliente.query.filter_by(activo=True).order_by(Cliente.nombre).all()
    return render_template(
        "arriendos/form.html", a=como_objeto(arr), titulo=titulo, clientes=clientes,
        catalogo=catalogo_para_formulario(),
    ), status


def _aplicar(arr: Arriendo, datos: dict, items: list[dict], form) -> None:
    for k, v in datos.items():
        setattr(arr, k, v)
    arr.lugar_uso = (form.get("lugar_uso") or "").strip() or None
    arr.garantia_monto = max(0, entero(form.get("garantia_monto"), 0))
    arr.items = [
        ArriendoItem(equipo_id=i["equipo"].id, cantidad=i["cantidad"],
                     precio_unitario=i["precio_unitario"], descuento_pct=i["descuento_pct"])
        for i in items
    ]


def _borrador(form, datos, items):
    return {
        "cliente_id": entero(form.get("cliente_id"), 0), "flete": datos["flete"],
        "notas": datos["notas"], "fecha_inicio": datos["fecha_inicio"],
        "fecha_fin": datos["fecha_fin"], "lugar_uso": form.get("lugar_uso"),
        "garantia_monto": entero(form.get("garantia_monto"), 0),
        "items": [
            {"equipo_id": i["equipo"].id, "cantidad": i["cantidad"],
             "precio_unitario": i["precio_unitario"], "descuento_pct": i["descuento_pct"]}
            for i in items
        ],
    }


def _entregar(arr: Arriendo) -> list[str]:
    """Pasa un arriendo reservado a 'en arriendo'. Devuelve errores si no hay stock.

    Si se entrega en una fecha distinta a la reservada, se conserva la duración
    pactada: el arriendo corre desde hoy por la misma cantidad de días.
    """
    inicio, fin = arr.fecha_inicio, arr.fecha_fin
    if inicio != hoy():
        inicio, fin = hoy(), hoy() + timedelta(days=arr.dias)
    errores = services.faltantes([(i.equipo, i.cantidad) for i in arr.items],
                                 inicio, fin, excluir_arriendo_id=arr.id)
    if errores:
        return errores
    arr.fecha_inicio, arr.fecha_fin = inicio, fin
    arr.estado = "activo"
    return []


@bp.get("/")
def lista():
    q = (request.args.get("q") or "").strip()
    estado = request.args.get("estado", "")
    consulta = Arriendo.query.join(Cliente)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(or_(Arriendo.numero.ilike(like), Cliente.nombre.ilike(like)))
    if estado in Arriendo.ESTADOS:
        consulta = consulta.filter(Arriendo.estado == estado)
    elif estado == "atrasado":
        consulta = consulta.filter(Arriendo.estado == "activo", Arriendo.fecha_fin < hoy())
    arriendos = consulta.order_by(Arriendo.id.desc()).all()
    if estado == "por_cobrar":
        arriendos = [a for a in arriendos if a.saldo > 0]
    return render_template("arriendos/lista.html", arriendos=arriendos, q=q, estado=estado)


@bp.route("/nuevo", methods=["GET", "POST"])
def nuevo():
    if request.method == "POST":
        datos, items, errores = leer_documento(request.form)
        cliente = db.session.get(Cliente, entero(request.form.get("cliente_id"), 0))
        if cliente is None:
            errores.append("Elige un cliente.")
        entregar = request.form.get("accion") == "entregar"
        if entregar and datos["fecha_inicio"] and datos["fecha_inicio"] > hoy():
            errores.append("Para entregar ahora, la fecha de inicio no puede ser futura.")
        if not errores:
            errores = services.faltantes([(i["equipo"], i["cantidad"]) for i in items],
                                         datos["fecha_inicio"], datos["fecha_fin"])
        if errores:
            for e in errores:
                flash(e, "error")
            return _formulario(_borrador(request.form, datos, items), "Nuevo arriendo", 422)
        arr = Arriendo(numero=services.siguiente_numero("ARR"), cliente_id=cliente.id,
                       iva_pct=services.iva_pct(), creado_por_id=g.usuario.id,
                       fecha_inicio=datos["fecha_inicio"], fecha_fin=datos["fecha_fin"])
        _aplicar(arr, datos, items, request.form)
        if entregar:
            arr.estado = "activo"
        db.session.add(arr)
        db.session.commit()
        flash(f"Arriendo {arr.numero} " + ("entregado." if entregar else "reservado."), "ok")
        return redirect(url_for("arriendos.detalle", id=arr.id))
    borrador = {
        "cliente_id": entero(request.args.get("cliente"), 0), "flete": 0,
        "fecha_inicio": hoy(), "fecha_fin": hoy() + timedelta(days=1),
        "items": [], "notas": None, "lugar_uso": None, "garantia_monto": 0,
    }
    return _formulario(borrador, "Nuevo arriendo")


@bp.get("/<int:id>")
def detalle(id):
    a = db.get_or_404(Arriendo, id)
    return render_template("arriendos/detalle.html", a=a, metodos=Pago.METODOS)


@bp.get("/<int:id>/imprimir")
def imprimir(id):
    a = db.get_or_404(Arriendo, id)
    return render_template("arriendos/imprimir.html", a=a)


@bp.route("/<int:id>/editar", methods=["GET", "POST"])
def editar(id):
    arr = db.get_or_404(Arriendo, id)
    if not arr.editable:
        flash("Sólo se puede editar un arriendo reservado.", "error")
        return redirect(url_for("arriendos.detalle", id=id))
    if request.method == "POST":
        datos, items, errores = leer_documento(request.form)
        cliente = db.session.get(Cliente, entero(request.form.get("cliente_id"), 0))
        if cliente is None:
            errores.append("Elige un cliente.")
        if not errores:
            errores = services.faltantes([(i["equipo"], i["cantidad"]) for i in items],
                                         datos["fecha_inicio"], datos["fecha_fin"],
                                         excluir_arriendo_id=arr.id)
        if errores:
            for e in errores:
                flash(e, "error")
            b = _borrador(request.form, datos, items)
            b["id"], b["numero"] = arr.id, arr.numero
            return _formulario(b, f"Editar {arr.numero}", 422)
        arr.cliente_id = cliente.id
        _aplicar(arr, datos, items, request.form)
        db.session.commit()
        flash("Arriendo actualizado.", "ok")
        return redirect(url_for("arriendos.detalle", id=arr.id))
    return _formulario(arr, f"Editar {arr.numero}")


@bp.post("/<int:id>/entregar")
def entregar(id):
    arr = db.get_or_404(Arriendo, id)
    if arr.estado != "reservado":
        flash("Este arriendo no está en estado reservado.", "error")
        return redirect(url_for("arriendos.detalle", id=id))
    errores = _entregar(arr)
    if errores:
        for e in errores:
            flash(e, "error")
    else:
        db.session.commit()
        flash("Equipos entregados: el arriendo está en curso.", "ok")
    return redirect(url_for("arriendos.detalle", id=id))


@bp.route("/<int:id>/devolver", methods=["GET", "POST"])
def devolver(id):
    arr = db.get_or_404(Arriendo, id)
    if arr.estado != "activo":
        flash("Sólo se pueden devolver equipos de un arriendo en curso.", "error")
        return redirect(url_for("arriendos.detalle", id=id))
    fecha = parse_fecha(request.form.get("fecha")) or hoy()
    dias_extra = max(0, (fecha - arr.fecha_fin).days)

    if request.method == "POST":
        recibido_algo = False
        for item in arr.items:
            cant = min(item.pendiente, max(0, entero(request.form.get(f"devuelve_{item.id}"), 0)))
            if cant:
                item.cantidad_devuelta += cant
                recibido_algo = True
            nota = (request.form.get(f"nota_{item.id}") or "").strip()
            if nota:
                item.notas_devolucion = nota
        if not recibido_algo:
            db.session.rollback()
            flash("Indica cuántas unidades se devuelven.", "error")
            return redirect(url_for("arriendos.devolver", id=id))
        arr.recargo += max(0, entero(request.form.get("recargo"), 0))
        if arr.pendiente_devolver == 0:
            arr.estado = "finalizado"
            arr.fecha_devolucion = fecha
            flash("Devolución completa: el arriendo quedó finalizado y los equipos disponibles.", "ok")
        else:
            flash("Devolución parcial registrada.", "ok")
        db.session.commit()
        return redirect(url_for("arriendos.detalle", id=id))

    # Sugerencia de recargo: precio diario efectivo de lo pendiente × días de atraso.
    sugerido = 0
    if dias_extra:
        for i in arr.items:
            precio_dia = i.precio_unitario * (100 - i.descuento_pct) / 100 / arr.dias
            sugerido += round(precio_dia * i.pendiente * dias_extra)
    return render_template("arriendos/devolver.html", a=arr, dias_extra=dias_extra, sugerido=sugerido, fecha=fecha)


@bp.post("/<int:id>/cancelar")
def cancelar(id):
    arr = db.get_or_404(Arriendo, id)
    if arr.estado != "reservado":
        flash("Sólo se puede cancelar un arriendo reservado.", "error")
    else:
        arr.estado = "cancelado"
        db.session.commit()
        flash("Arriendo cancelado: los equipos quedaron liberados.", "ok")
    return redirect(url_for("arriendos.detalle", id=id))


@bp.post("/<int:id>/pagos")
def pagar(id):
    arr = db.get_or_404(Arriendo, id)
    monto = entero(request.form.get("monto"), 0)
    metodo = request.form.get("metodo")
    if arr.estado == "cancelado":
        flash("No se registran pagos en un arriendo cancelado.", "error")
    elif monto <= 0 or metodo not in Pago.METODOS:
        flash("Indica un monto y un método de pago válidos.", "error")
    else:
        db.session.add(Pago(
            arriendo_id=arr.id, monto=monto, metodo=metodo,
            fecha=parse_fecha(request.form.get("fecha")) or hoy(),
            referencia=(request.form.get("referencia") or "").strip() or None,
            usuario_id=g.usuario.id))
        db.session.commit()
        flash("Pago registrado.", "ok")
    return redirect(url_for("arriendos.detalle", id=id))


@bp.post("/pagos/<int:id>/eliminar")
@solo_admin
def eliminar_pago(id):
    p = db.get_or_404(Pago, id)
    arriendo_id = p.arriendo_id
    db.session.delete(p)
    db.session.commit()
    flash("Pago eliminado.", "ok")
    return redirect(url_for("arriendos.detalle", id=arriendo_id))


@bp.post("/<int:id>/garantia")
def garantia(id):
    arr = db.get_or_404(Arriendo, id)
    arr.garantia_devuelta = request.form.get("devuelta") == "1"
    db.session.commit()
    flash("Garantía marcada como devuelta." if arr.garantia_devuelta else "Garantía marcada como retenida.", "ok")
    return redirect(url_for("arriendos.detalle", id=id))

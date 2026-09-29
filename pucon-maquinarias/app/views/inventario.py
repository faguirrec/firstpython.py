from flask import (
    Blueprint, flash, g, jsonify, redirect, render_template, request, url_for,
)
from sqlalchemy import or_

from .. import services
from ..extensions import db
from ..models import (
    Arriendo, ArriendoItem, Categoria, Equipo, Mantencion, MovimientoInventario, hoy,
)
from ..utils import entero, entero_opcional, parse_fecha
from .comun import respuesta_csv, solo_admin

bp = Blueprint("inventario", __name__, url_prefix="/inventario")


def _leer(form, equipo: Equipo | None = None):
    errores = []
    codigo = (form.get("codigo") or "").strip().upper()
    nombre = (form.get("nombre") or "").strip()
    if not codigo:
        errores.append("El código es obligatorio.")
    else:
        otro = Equipo.query.filter_by(codigo=codigo).first()
        if otro and (equipo is None or otro.id != equipo.id):
            errores.append(f"El código {codigo} ya lo usa «{otro.nombre}».")
    if not nombre:
        errores.append("El nombre es obligatorio.")
    tarifa_dia = entero(form.get("tarifa_dia"), 0)
    if tarifa_dia <= 0:
        errores.append("La tarifa diaria debe ser mayor a cero.")
    datos = {
        "codigo": codigo, "nombre": nombre,
        "categoria_id": entero(form.get("categoria_id"), 0) or None,
        "marca": (form.get("marca") or "").strip() or None,
        "modelo": (form.get("modelo") or "").strip() or None,
        "descripcion": (form.get("descripcion") or "").strip() or None,
        "ubicacion": (form.get("ubicacion") or "").strip() or None,
        "tarifa_dia": tarifa_dia,
        "tarifa_semana": entero_opcional(form.get("tarifa_semana")),
        "tarifa_mes": entero_opcional(form.get("tarifa_mes")),
        "garantia": max(0, entero(form.get("garantia"), 0)),
        "valor_reposicion": max(0, entero(form.get("valor_reposicion"), 0)),
    }
    return datos, errores


def _categorias():
    return Categoria.query.order_by(Categoria.nombre).all()


@bp.get("/")
def lista():
    q = (request.args.get("q") or "").strip()
    categoria = entero(request.args.get("categoria"), 0)
    estado = request.args.get("estado", "")
    consulta = Equipo.query.filter_by(activo=True)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(or_(
            Equipo.nombre.ilike(like), Equipo.codigo.ilike(like),
            Equipo.marca.ilike(like), Equipo.modelo.ilike(like)))
    if categoria:
        consulta = consulta.filter(Equipo.categoria_id == categoria)
    equipos = consulta.order_by(Equipo.codigo).all()
    stock = services.resumen_stock([e.id for e in equipos])
    if estado == "disponible":
        equipos = [e for e in equipos if stock[e.id]["disponible"] > 0]
    elif estado == "agotado":
        equipos = [e for e in equipos if stock[e.id]["disponible"] == 0]
    elif estado == "mantencion":
        equipos = [e for e in equipos if stock[e.id]["en_mantencion"] > 0]
    totales = {
        k: sum(stock[e.id][k] for e in equipos)
        for k in ("total", "en_arriendo", "en_mantencion", "disponible")
    }
    return render_template(
        "inventario/lista.html", equipos=equipos, stock=stock, totales=totales,
        categorias=_categorias(), q=q, categoria=categoria, estado=estado,
    )


@bp.get("/en-arriendo")
def en_arriendo():
    """Qué hay afuera ahora, con quién y hasta cuándo."""
    filas = (
        db.session.execute(
            db.select(ArriendoItem, Arriendo)
            .join(Arriendo, ArriendoItem.arriendo_id == Arriendo.id)
            .where(Arriendo.estado == "activo")
            .order_by(Arriendo.fecha_fin)
        ).all()
    )
    filas = [(i, a) for i, a in filas if i.pendiente > 0]
    return render_template("inventario/en_arriendo.html", filas=filas)


@bp.route("/nuevo", methods=["GET", "POST"])
def nuevo():
    if request.method == "POST":
        datos, errores = _leer(request.form)
        cantidad = max(0, entero(request.form.get("cantidad_total"), 1))
        if cantidad < 1:
            errores.append("La cantidad inicial debe ser al menos 1.")
        if not errores:
            equipo = Equipo(cantidad_total=cantidad, **datos)
            db.session.add(equipo)
            db.session.flush()
            db.session.add(MovimientoInventario(
                equipo_id=equipo.id, tipo="ingreso", cantidad=cantidad,
                motivo="Ingreso inicial", usuario_id=g.usuario.id))
            db.session.commit()
            flash("Equipo agregado al inventario.", "ok")
            return redirect(url_for("inventario.detalle", id=equipo.id))
        for e in errores:
            flash(e, "error")
        datos["cantidad_total"] = cantidad
        return render_template("inventario/form.html", e=datos, categorias=_categorias(),
                               titulo="Nuevo equipo", nuevo=True), 422
    return render_template("inventario/form.html", e={"cantidad_total": 1}, categorias=_categorias(),
                           titulo="Nuevo equipo", nuevo=True)


@bp.get("/<int:id>")
def detalle(id):
    e = db.get_or_404(Equipo, id)
    stock = services.resumen_stock([e.id])[e.id]
    lineas = (
        db.session.execute(
            db.select(ArriendoItem, Arriendo)
            .join(Arriendo, ArriendoItem.arriendo_id == Arriendo.id)
            .where(ArriendoItem.equipo_id == e.id, Arriendo.estado != "cancelado")
            .order_by(Arriendo.fecha_inicio.desc()).limit(30)
        ).all()
    )
    return render_template("inventario/detalle.html", e=e, stock=stock, lineas=lineas)


@bp.route("/<int:id>/editar", methods=["GET", "POST"])
def editar(id):
    e = db.get_or_404(Equipo, id)
    if request.method == "POST":
        datos, errores = _leer(request.form, e)
        if not errores:
            for k, v in datos.items():
                setattr(e, k, v)
            db.session.commit()
            flash("Equipo actualizado.", "ok")
            return redirect(url_for("inventario.detalle", id=e.id))
        for err in errores:
            flash(err, "error")
        datos["id"] = e.id
        datos["cantidad_total"] = e.cantidad_total
        return render_template("inventario/form.html", e=datos, categorias=_categorias(),
                               titulo="Editar equipo"), 422
    return render_template("inventario/form.html", e=e, categorias=_categorias(), titulo="Editar equipo")


@bp.post("/<int:id>/movimiento")
def movimiento(id):
    """Ingreso, baja o ajuste de la cantidad total."""
    e = db.get_or_404(Equipo, id)
    tipo = request.form.get("tipo")
    cantidad = entero(request.form.get("cantidad"), 0)
    motivo = (request.form.get("motivo") or "").strip()
    if tipo not in MovimientoInventario.TIPOS or cantidad < 1:
        flash("Indica el tipo de movimiento y una cantidad válida.", "error")
        return redirect(url_for("inventario.detalle", id=id))
    if tipo in ("baja", "ajuste") and not motivo:
        flash("Las bajas y ajustes necesitan un motivo.", "error")
        return redirect(url_for("inventario.detalle", id=id))
    if tipo == "ajuste":
        # El ajuste fija la cantidad total al valor contado.
        delta = cantidad - e.cantidad_total
        if delta == 0:
            flash("La cantidad contada es igual a la registrada.", "info")
            return redirect(url_for("inventario.detalle", id=id))
    else:
        delta = cantidad if tipo == "ingreso" else -cantidad
    stock = services.resumen_stock([e.id])[e.id]
    nuevo_total = e.cantidad_total + delta
    if nuevo_total < stock["en_arriendo"] + stock["en_mantencion"]:
        flash("No se puede dejar menos unidades que las que están arrendadas o en mantención.", "error")
        return redirect(url_for("inventario.detalle", id=id))
    e.cantidad_total = nuevo_total
    db.session.add(MovimientoInventario(
        equipo_id=e.id, tipo=tipo, cantidad=delta, motivo=motivo or None, usuario_id=g.usuario.id))
    db.session.commit()
    flash(f"Inventario actualizado: ahora hay {nuevo_total} unidad(es) en total.", "ok")
    return redirect(url_for("inventario.detalle", id=id))


@bp.post("/<int:id>/mantencion")
def abrir_mantencion(id):
    e = db.get_or_404(Equipo, id)
    cantidad = entero(request.form.get("cantidad"), 1)
    motivo = (request.form.get("motivo") or "").strip()
    stock = services.resumen_stock([e.id])[e.id]
    if not motivo or cantidad < 1:
        flash("Indica el motivo y la cantidad.", "error")
    elif cantidad > stock["disponible"]:
        flash(f"Sólo hay {stock['disponible']} unidad(es) disponible(s) para enviar a mantención.", "error")
    else:
        db.session.add(Mantencion(equipo_id=e.id, cantidad=cantidad, motivo=motivo))
        db.session.commit()
        flash("Equipo enviado a mantención.", "ok")
    return redirect(url_for("inventario.detalle", id=id))


@bp.post("/mantenciones/<int:id>/cerrar")
def cerrar_mantencion(id):
    m = db.get_or_404(Mantencion, id)
    if m.abierta:
        m.fecha_fin = parse_fecha(request.form.get("fecha_fin")) or hoy()
        m.costo = max(0, entero(request.form.get("costo"), 0))
        db.session.commit()
        flash("Mantención cerrada: las unidades vuelven a estar disponibles.", "ok")
    return redirect(url_for("inventario.detalle", id=m.equipo_id))


@bp.post("/<int:id>/eliminar")
@solo_admin
def eliminar(id):
    e = db.get_or_404(Equipo, id)
    if ArriendoItem.query.filter_by(equipo_id=e.id).first() or e.mantenciones:
        e.activo = False
        flash("El equipo tiene historial: se dio de baja del catálogo, pero se conserva su historial.", "info")
    else:
        MovimientoInventario.query.filter_by(equipo_id=e.id).delete()
        db.session.delete(e)
        flash("Equipo eliminado.", "ok")
    db.session.commit()
    return redirect(url_for("inventario.lista"))


@bp.get("/exportar.csv")
def exportar():
    equipos = Equipo.query.filter_by(activo=True).order_by(Equipo.codigo).all()
    stock = services.resumen_stock([e.id for e in equipos])
    filas = [
        (e.codigo, e.nombre, e.categoria.nombre if e.categoria else "", e.marca or "",
         e.modelo or "", stock[e.id]["total"], stock[e.id]["en_arriendo"],
         stock[e.id]["en_mantencion"], stock[e.id]["disponible"],
         e.tarifa_dia, e.tarifa_semana or "", e.tarifa_mes or "", e.garantia, e.valor_reposicion)
        for e in equipos
    ]
    return respuesta_csv(
        "inventario.csv",
        ["Código", "Equipo", "Categoría", "Marca", "Modelo", "Total", "En arriendo",
         "En mantención", "Disponible", "Tarifa día", "Tarifa semana", "Tarifa mes",
         "Garantía", "Valor reposición"],
        filas,
    )


# --- Categorías ------------------------------------------------------------- #
@bp.post("/categorias")
def crear_categoria():
    nombre = (request.form.get("nombre") or "").strip()
    if nombre and not Categoria.query.filter(db.func.lower(Categoria.nombre) == nombre.lower()).first():
        db.session.add(Categoria(nombre=nombre))
        db.session.commit()
        flash("Categoría creada.", "ok")
    else:
        flash("Escribe un nombre de categoría que no exista.", "error")
    return redirect(request.referrer or url_for("inventario.lista"))


@bp.post("/categorias/<int:id>/eliminar")
@solo_admin
def eliminar_categoria(id):
    c = db.get_or_404(Categoria, id)
    if c.equipos:
        flash("La categoría tiene equipos: muévelos antes de borrarla.", "error")
    else:
        db.session.delete(c)
        db.session.commit()
        flash("Categoría eliminada.", "ok")
    return redirect(url_for("inventario.lista"))


# --- API para el editor de líneas de cotizaciones/arriendos ---------------- #
@bp.get("/api/<int:id>/cotizar")
def api_cotizar(id):
    """Precio sugerido y disponibilidad de un equipo para un período."""
    e = db.get_or_404(Equipo, id)
    desde, hasta = parse_fecha(request.args.get("desde")), parse_fecha(request.args.get("hasta"))
    dias = max(1, (hasta - desde).days) if desde and hasta else max(1, entero(request.args.get("dias"), 1))
    disponible = None
    if desde and hasta and hasta > desde:
        disponible = services.disponible_entre(
            e, desde, hasta, entero(request.args.get("excluir"), 0) or None)
    return jsonify(
        precio=services.precio_equipo(e, dias), dias=dias,
        disponible=disponible, garantia=e.garantia,
    )

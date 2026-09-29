"""Helpers compartidos por las vistas."""
import csv
import io
from functools import wraps
from types import SimpleNamespace

from flask import Response, abort, g

from .. import services
from ..extensions import db
from ..models import Equipo
from ..utils import entero, parse_fecha


def solo_admin(vista):
    @wraps(vista)
    def envuelta(*a, **kw):
        if not g.usuario or not g.usuario.es_admin:
            abort(403, "Esta acción es sólo para administradores.")
        return vista(*a, **kw)
    return envuelta


def respuesta_csv(nombre: str, encabezados: list[str], filas) -> Response:
    """CSV con BOM y `;` como separador para que Excel en español lo abra bien."""
    salida = io.StringIO()
    escritor = csv.writer(salida, delimiter=";")
    escritor.writerow(encabezados)
    escritor.writerows(filas)
    cuerpo = "﻿" + salida.getvalue()
    return Response(
        cuerpo, mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )


def leer_documento(form, *, arriendo_id_excluir: int | None = None):
    """Lee y valida el formulario común de cotización/arriendo.

    Devuelve (datos, items, errores). `items` es una lista de dicts listos para
    crear líneas; los errores son mensajes para mostrar al usuario.
    """
    errores: list[str] = []
    inicio = parse_fecha(form.get("fecha_inicio"))
    fin = parse_fecha(form.get("fecha_fin"))
    if not inicio or not fin:
        errores.append("Indica las fechas de inicio y término.")
    elif fin <= inicio:
        errores.append("La fecha de término debe ser posterior a la de inicio.")

    ids = form.getlist("item_equipo")
    cantidades = form.getlist("item_cantidad")
    precios = form.getlist("item_precio")
    descuentos = form.getlist("item_descuento")

    def en(lista, i):
        return lista[i] if i < len(lista) else None  # tolera formularios armados a mano

    items = []
    for i, equipo_id in enumerate(ids):
        if not equipo_id:
            continue
        equipo = db.session.get(Equipo, entero(equipo_id))
        cantidad = entero(en(cantidades, i), 0)
        if equipo is None or cantidad < 1:
            errores.append("Hay una línea con equipo o cantidad inválidos.")
            continue
        items.append({
            "equipo": equipo,
            "cantidad": cantidad,
            "precio_unitario": max(0, entero(en(precios, i), 0)),
            "descuento_pct": min(100, max(0, entero(en(descuentos, i), 0))),
        })
    if not items:
        errores.append("Agrega al menos un equipo.")

    datos = {
        "fecha_inicio": inicio,
        "fecha_fin": fin,
        "flete": max(0, entero(form.get("flete"), 0)),
        "notas": (form.get("notas") or "").strip() or None,
    }
    return datos, items, errores


def catalogo_para_formulario():
    """Equipos activos con lo que el editor de líneas necesita en el navegador."""
    equipos = (
        Equipo.query.filter_by(activo=True).order_by(Equipo.nombre).all()
    )
    stock = services.resumen_stock([e.id for e in equipos])
    return [
        {
            "id": e.id, "codigo": e.codigo, "nombre": e.nombre,
            "categoria": e.categoria.nombre if e.categoria else "",
            "tarifa_dia": e.tarifa_dia, "garantia": e.garantia,
            "total": stock[e.id]["total"],
        }
        for e in equipos
    ]


def como_objeto(doc):
    """Los borradores para repintar un formulario son dicts; las plantillas los
    leen como objetos (un dict con clave `items` chocaría con dict.items)."""
    if not isinstance(doc, dict):
        return doc
    return SimpleNamespace(**{**doc, "items": [SimpleNamespace(**i) for i in doc.get("items", [])]})


def ruta_interna(destino: str | None) -> str | None:
    """Devuelve `destino` sólo si es una ruta del propio sitio (evita redirecciones abiertas)."""
    if destino and destino.startswith("/") and not destino.startswith("//") and "\\" not in destino:
        return destino
    return None

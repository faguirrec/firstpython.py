from flask import Blueprint, render_template, request

from .. import services
from ..extensions import db
from ..models import Arriendo, Mantencion, Pago, hoy
from ..utils import MESES, formatear_rut, parse_fecha
from .comun import respuesta_csv

bp = Blueprint("finanzas", __name__, url_prefix="/finanzas")


@bp.get("/")
def resumen():
    ingresos = services.ingresos_por_mes(12)
    inicio_mes = services.primer_dia_mes(hoy())
    mant_mes = int(db.session.scalar(
        db.select(db.func.coalesce(db.func.sum(Mantencion.costo), 0))
        .where(Mantencion.fecha_fin >= inicio_mes)
    ))
    por_cobrar = sorted(
        (a for a in Arriendo.query.filter(Arriendo.estado != "cancelado").all() if a.saldo > 0),
        key=lambda a: a.fecha_fin,
    )
    pagos = Pago.query.order_by(Pago.fecha.desc(), Pago.id.desc()).limit(30).all()
    facturado = sum(a.total for a in Arriendo.query.filter(Arriendo.estado != "cancelado").all())
    maximo = max((m for _, m in ingresos), default=0) or 1
    return render_template(
        "finanzas.html", ingresos=ingresos, maximo=maximo, por_cobrar=por_cobrar,
        total_por_cobrar=sum(a.saldo for a in por_cobrar), pagos=pagos,
        mant_mes=mant_mes, facturado=facturado, meses=MESES,
    )


@bp.get("/pagos.csv")
def exportar_pagos():
    desde = parse_fecha(request.args.get("desde"))
    consulta = Pago.query.order_by(Pago.fecha, Pago.id)
    if desde:
        consulta = consulta.filter(Pago.fecha >= desde)
    filas = [
        (p.fecha.isoformat(), p.arriendo.numero, p.arriendo.cliente.nombre,
         formatear_rut(p.arriendo.cliente.rut), Pago.METODOS[p.metodo], p.referencia or "", p.monto)
        for p in consulta
    ]
    return respuesta_csv(
        "pagos.csv", ["Fecha", "Arriendo", "Cliente", "RUT", "Método", "Referencia", "Monto"], filas)

from flask import Blueprint, render_template

from .. import services
from ..models import Arriendo, Cotizacion, hoy

bp = Blueprint("dashboard", __name__)


@bp.get("/")
def inicio():
    ind = services.indicadores()
    ingresos = services.ingresos_por_mes(6)
    maximo = max((m for _, m in ingresos), default=0) or 1
    proximas = (
        Arriendo.query.filter_by(estado="reservado")
        .order_by(Arriendo.fecha_inicio).limit(5).all()
    )
    cotizaciones = (
        Cotizacion.query.filter(Cotizacion.estado.in_(("borrador", "enviada")))
        .order_by(Cotizacion.fecha.desc()).limit(5).all()
    )
    return render_template(
        "dashboard.html", ind=ind, ingresos=ingresos, maximo=maximo,
        proximas=proximas, cotizaciones=cotizaciones, hoy=hoy(),
    )

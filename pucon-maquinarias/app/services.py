"""Reglas de negocio: precios, disponibilidad, numeración y resúmenes."""
from datetime import date, timedelta

from sqlalchemy import func

from .extensions import db
from .models import (
    Arriendo, ArriendoItem, Contador, Equipo, Mantencion, Pago, Setting, hoy,
)

# --------------------------------------------------------------------------- #
# Configuración
# --------------------------------------------------------------------------- #
DEFAULTS = {
    "empresa_nombre": "Pucón Maquinarias",
    "empresa_rut": "",
    "empresa_giro": "Arriendo de maquinaria y equipos",
    "empresa_direccion": "Pucón, Región de La Araucanía",
    "empresa_telefono": "",
    "empresa_email": "",
    "iva_pct": "19",
    "validez_dias": "7",
    "condiciones_cotizacion": (
        "Precios en pesos chilenos. La cotización no reserva los equipos hasta "
        "confirmar el arriendo. Se requiere garantía en efectivo o transferencia, "
        "que se devuelve al recibir los equipos en buen estado."
    ),
    "condiciones_arriendo": (
        "El arrendatario recibe los equipos en buen estado y se obliga a devolverlos "
        "en la fecha pactada y en las mismas condiciones. Los daños, pérdidas o "
        "faltantes se cobran según el valor de reposición. Cada día de atraso se "
        "cobra según la tarifa vigente. El combustible y los consumibles son de "
        "cargo del arrendatario."
    ),
}


def setting(clave: str) -> str:
    fila = db.session.get(Setting, clave)
    return fila.valor if fila else DEFAULTS.get(clave, "")


def todos_los_settings() -> dict:
    valores = dict(DEFAULTS)
    valores.update({s.clave: s.valor for s in Setting.query.all()})
    return valores


def guardar_setting(clave: str, valor: str) -> None:
    fila = db.session.get(Setting, clave)
    if fila:
        fila.valor = valor
    else:
        db.session.add(Setting(clave=clave, valor=valor))


def iva_pct() -> int:
    try:
        return int(setting("iva_pct"))
    except ValueError:
        return 19


# --------------------------------------------------------------------------- #
# Numeración correlativa
# --------------------------------------------------------------------------- #
def siguiente_numero(prefijo: str) -> str:
    fila = db.session.execute(
        db.select(Contador).where(Contador.prefijo == prefijo).with_for_update()
    ).scalar_one_or_none()
    if fila is None:
        fila = Contador(prefijo=prefijo, valor=0)
        db.session.add(fila)
    fila.valor += 1
    db.session.flush()
    return f"{prefijo}-{fila.valor:04d}"


# --------------------------------------------------------------------------- #
# Precios
# --------------------------------------------------------------------------- #
def precio_por_dias(dias: int, tarifa_dia: int, tarifa_semana: int | None = None,
                    tarifa_mes: int | None = None) -> int:
    """Precio de UNA unidad por `dias` días, tomando la combinación más barata.

    Si hay tarifa semanal o mensual se combinan con días sueltos, y también se
    considera redondear hacia arriba al período completo: 6 días pueden salir
    más baratos como una semana que como 6 tarifas diarias.
    """
    dias = max(1, dias)
    mejor = tarifa_dia * dias
    if tarifa_semana:
        semanas, resto = divmod(dias, 7)
        mejor = min(mejor, semanas * tarifa_semana + resto * tarifa_dia)
        mejor = min(mejor, (semanas + (1 if resto else 0)) * tarifa_semana)
    if tarifa_mes:
        meses, resto = divmod(dias, 30)
        resto_precio = precio_por_dias(resto, tarifa_dia, tarifa_semana) if resto else 0
        mejor = min(mejor, meses * tarifa_mes + resto_precio)
        mejor = min(mejor, (meses + (1 if resto else 0)) * tarifa_mes)
    return mejor


def precio_equipo(equipo: Equipo, dias: int) -> int:
    return precio_por_dias(dias, equipo.tarifa_dia, equipo.tarifa_semana, equipo.tarifa_mes)


# --------------------------------------------------------------------------- #
# Stock y disponibilidad
# --------------------------------------------------------------------------- #
def _fin_efectivo(arriendo: Arriendo) -> date:
    """Hasta cuándo ocupa stock un arriendo: si está atrasado, hasta hoy."""
    fin = max(arriendo.fecha_fin, arriendo.fecha_inicio + timedelta(days=1))
    if arriendo.estado == "activo":
        fin = max(fin, hoy() + timedelta(days=1))
    return fin


def _lineas_vigentes(equipo_id: int | None = None, excluir_arriendo_id: int | None = None):
    q = (
        db.select(ArriendoItem, Arriendo)
        .join(Arriendo, ArriendoItem.arriendo_id == Arriendo.id)
        .where(Arriendo.estado.in_(("reservado", "activo")))
    )
    if equipo_id is not None:
        q = q.where(ArriendoItem.equipo_id == equipo_id)
    if excluir_arriendo_id is not None:
        q = q.where(Arriendo.id != excluir_arriendo_id)
    return [(i, a) for i, a in db.session.execute(q).all() if i.pendiente > 0]


def resumen_stock(equipo_ids=None) -> dict[int, dict]:
    """Stock actual por equipo: total, en arriendo, en mantención, reservado, disponible."""
    q = db.select(Equipo.id, Equipo.cantidad_total)
    if equipo_ids is not None:
        q = q.where(Equipo.id.in_(list(equipo_ids)))
    resumen = {
        id_: {"total": total, "en_arriendo": 0, "en_mantencion": 0, "reservado": 0}
        for id_, total in db.session.execute(q).all()
    }
    for item, arr in _lineas_vigentes():
        if item.equipo_id in resumen:
            clave = "en_arriendo" if arr.estado == "activo" else "reservado"
            resumen[item.equipo_id][clave] += item.pendiente
    mant = db.session.execute(
        db.select(Mantencion.equipo_id, func.sum(Mantencion.cantidad))
        .where(Mantencion.fecha_fin.is_(None)).group_by(Mantencion.equipo_id)
    ).all()
    for equipo_id, cant in mant:
        if equipo_id in resumen:
            resumen[equipo_id]["en_mantencion"] = int(cant)
    for r in resumen.values():
        r["disponible"] = max(0, r["total"] - r["en_arriendo"] - r["en_mantencion"])
    return resumen


def disponible_entre(equipo: Equipo, desde: date, hasta: date,
                     excluir_arriendo_id: int | None = None) -> int:
    """Unidades libres durante todo el período [desde, hasta).

    Se toma el pico de ocupación dentro del rango, no la suma: dos reservas que
    no se pisan entre sí no deben bloquearse mutuamente.
    """
    hasta = max(hasta, desde + timedelta(days=1))
    intervalos = []
    for item, arr in _lineas_vigentes(equipo.id, excluir_arriendo_id):
        ini, fin = arr.fecha_inicio, _fin_efectivo(arr)
        if arr.estado == "activo":
            ini = min(ini, hoy())
        if ini < hasta and fin > desde:
            intervalos.append((ini, fin, item.pendiente))
    puntos = {desde} | {i for i, _, _ in intervalos if desde <= i < hasta}
    pico = max(
        (sum(c for ini, fin, c in intervalos if ini <= p < fin) for p in puntos),
        default=0,
    )
    en_mantencion = int(db.session.scalar(
        db.select(func.coalesce(func.sum(Mantencion.cantidad), 0))
        .where(Mantencion.equipo_id == equipo.id, Mantencion.fecha_fin.is_(None))
    ))
    return max(0, equipo.cantidad_total - en_mantencion - pico)


def faltantes(items, desde: date, hasta: date, excluir_arriendo_id: int | None = None) -> list[str]:
    """Mensajes de error por cada línea que pide más de lo disponible."""
    pedido: dict[int, int] = {}
    for equipo, cantidad in items:
        pedido[equipo.id] = pedido.get(equipo.id, 0) + cantidad
    errores = []
    equipos = {e.id: e for e, _ in items}
    for equipo_id, cantidad in pedido.items():
        equipo = equipos[equipo_id]
        libre = disponible_entre(equipo, desde, hasta, excluir_arriendo_id)
        if cantidad > libre:
            errores.append(
                f"{equipo.nombre}: pides {cantidad} y sólo hay {libre} disponible(s) en esas fechas."
            )
    return errores


# --------------------------------------------------------------------------- #
# Dashboard y finanzas
# --------------------------------------------------------------------------- #
def primer_dia_mes(d: date) -> date:
    return d.replace(day=1)


def sumar_meses(d: date, n: int) -> date:
    idx = d.year * 12 + (d.month - 1) + n
    return date(idx // 12, idx % 12 + 1, 1)


def ingresos_por_mes(meses: int = 6) -> list[tuple[date, int]]:
    inicio = sumar_meses(primer_dia_mes(hoy()), -(meses - 1))
    filas = db.session.execute(
        db.select(Pago.fecha, Pago.monto).where(Pago.fecha >= inicio)
    ).all()
    totales = {sumar_meses(inicio, i): 0 for i in range(meses)}
    for fecha, monto in filas:
        totales[primer_dia_mes(fecha)] += monto
    return list(totales.items())


def indicadores() -> dict:
    stock = resumen_stock()
    total = sum(r["total"] for r in stock.values())
    en_arriendo = sum(r["en_arriendo"] for r in stock.values())
    en_mant = sum(r["en_mantencion"] for r in stock.values())
    activos = Arriendo.query.filter_by(estado="activo").all()
    reservados = Arriendo.query.filter_by(estado="reservado").count()
    mes = primer_dia_mes(hoy())
    ingresos_mes = int(db.session.scalar(
        db.select(func.coalesce(func.sum(Pago.monto), 0)).where(Pago.fecha >= mes)
    ))
    por_cobrar = sum(
        a.saldo for a in Arriendo.query.filter(Arriendo.estado != "cancelado").all()
        if a.saldo > 0
    )
    return {
        "unidades_total": total,
        "en_arriendo": en_arriendo,
        "en_mantencion": en_mant,
        "disponibles": max(0, total - en_arriendo - en_mant),
        "utilizacion": round(100 * en_arriendo / total) if total else 0,
        "arriendos_activos": len(activos),
        "atrasados": [a for a in activos if a.atrasado],
        "vencen_hoy": [a for a in activos if a.por_vencer_hoy],
        "reservados": reservados,
        "ingresos_mes": ingresos_mes,
        "por_cobrar": por_cobrar,
    }

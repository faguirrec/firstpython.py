"""Modelos de datos.

Todos los montos son enteros en pesos chilenos (CLP no tiene decimales), así se
evitan errores de redondeo con flotantes.
"""
from datetime import date, datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def hoy() -> date:
    return date.today()


def ahora() -> datetime:
    return datetime.now().replace(microsecond=0)


# --------------------------------------------------------------------------- #
# Usuarios y configuración
# --------------------------------------------------------------------------- #
class Usuario(db.Model):
    __tablename__ = "usuario"
    ROLES = {"admin": "Administrador", "operador": "Operador"}

    id = db.Column(db.Integer, primary_key=True)
    nombre = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(200), nullable=False, unique=True)
    password_hash = db.Column(db.String(300), nullable=False)
    rol = db.Column(db.String(20), nullable=False, default="operador")
    activo = db.Column(db.Boolean, nullable=False, default=True)
    creado = db.Column(db.DateTime, nullable=False, default=ahora)

    def set_password(self, clave: str) -> None:
        self.password_hash = generate_password_hash(clave)

    def check_password(self, clave: str) -> bool:
        return check_password_hash(self.password_hash, clave)

    @property
    def es_admin(self) -> bool:
        return self.rol == "admin"


class Setting(db.Model):
    """Configuración clave/valor editable desde la app."""
    __tablename__ = "setting"
    clave = db.Column(db.String(60), primary_key=True)
    valor = db.Column(db.Text, nullable=False, default="")


class Contador(db.Model):
    """Correlativos de documentos (COT-0001, ARR-0001...)."""
    __tablename__ = "contador"
    prefijo = db.Column(db.String(10), primary_key=True)
    valor = db.Column(db.Integer, nullable=False, default=0)


# --------------------------------------------------------------------------- #
# Clientes
# --------------------------------------------------------------------------- #
class Cliente(db.Model):
    __tablename__ = "cliente"
    TIPOS = {"persona": "Persona", "empresa": "Empresa"}

    id = db.Column(db.Integer, primary_key=True)
    tipo = db.Column(db.String(10), nullable=False, default="persona")
    nombre = db.Column(db.String(200), nullable=False)  # nombre o razón social
    rut = db.Column(db.String(12), unique=True)  # normalizado: 12345678-5
    contacto = db.Column(db.String(120))  # persona de contacto en una empresa
    email = db.Column(db.String(200))
    telefono = db.Column(db.String(40))
    direccion = db.Column(db.String(250))
    ciudad = db.Column(db.String(80))
    notas = db.Column(db.Text)
    activo = db.Column(db.Boolean, nullable=False, default=True)
    creado = db.Column(db.DateTime, nullable=False, default=ahora)

    cotizaciones = db.relationship("Cotizacion", back_populates="cliente")
    arriendos = db.relationship("Arriendo", back_populates="cliente")

    @property
    def saldo_pendiente(self) -> int:
        return sum(a.saldo for a in self.arriendos if a.estado != "cancelado")


# --------------------------------------------------------------------------- #
# Inventario
# --------------------------------------------------------------------------- #
class Categoria(db.Model):
    __tablename__ = "categoria"
    id = db.Column(db.Integer, primary_key=True)
    nombre = db.Column(db.String(80), nullable=False, unique=True)

    equipos = db.relationship("Equipo", back_populates="categoria")


class Equipo(db.Model):
    """Un producto del catálogo, con una cantidad de unidades idénticas.

    Una máquina única (una mini excavadora) tiene cantidad_total = 1; algo que
    se tiene en varias unidades (andamios, vallas) tiene la cantidad que
    corresponda. La disponibilidad se calcula a partir de los arriendos y las
    mantenciones: no se guarda, para que no pueda quedar desincronizada.
    """
    __tablename__ = "equipo"

    id = db.Column(db.Integer, primary_key=True)
    codigo = db.Column(db.String(30), nullable=False, unique=True)
    nombre = db.Column(db.String(160), nullable=False)
    categoria_id = db.Column(db.Integer, db.ForeignKey("categoria.id"))
    marca = db.Column(db.String(80))
    modelo = db.Column(db.String(80))
    descripcion = db.Column(db.Text)
    ubicacion = db.Column(db.String(80))
    cantidad_total = db.Column(db.Integer, nullable=False, default=1)
    tarifa_dia = db.Column(db.Integer, nullable=False, default=0)
    tarifa_semana = db.Column(db.Integer)  # opcional
    tarifa_mes = db.Column(db.Integer)  # opcional
    garantia = db.Column(db.Integer, nullable=False, default=0)  # por unidad
    valor_reposicion = db.Column(db.Integer, nullable=False, default=0)
    activo = db.Column(db.Boolean, nullable=False, default=True)
    creado = db.Column(db.DateTime, nullable=False, default=ahora)

    categoria = db.relationship("Categoria", back_populates="equipos")
    movimientos = db.relationship(
        "MovimientoInventario", back_populates="equipo",
        order_by="MovimientoInventario.id.desc()")
    mantenciones = db.relationship(
        "Mantencion", back_populates="equipo", order_by="Mantencion.id.desc()")

    @property
    def etiqueta(self) -> str:
        return f"{self.codigo} · {self.nombre}"


class MovimientoInventario(db.Model):
    """Bitácora de cambios en la cantidad total: ingresos, bajas y ajustes."""
    __tablename__ = "movimiento_inventario"
    TIPOS = {"ingreso": "Ingreso", "baja": "Baja", "ajuste": "Ajuste"}

    id = db.Column(db.Integer, primary_key=True)
    equipo_id = db.Column(db.Integer, db.ForeignKey("equipo.id"), nullable=False)
    tipo = db.Column(db.String(10), nullable=False)
    cantidad = db.Column(db.Integer, nullable=False)  # con signo: +entra, -sale
    motivo = db.Column(db.String(250))
    usuario_id = db.Column(db.Integer, db.ForeignKey("usuario.id"))
    fecha = db.Column(db.DateTime, nullable=False, default=ahora)

    equipo = db.relationship("Equipo", back_populates="movimientos")
    usuario = db.relationship("Usuario")


class Mantencion(db.Model):
    """Unidades fuera de servicio por reparación o mantención.

    Mientras `fecha_fin` sea nula, esas unidades no están disponibles.
    """
    __tablename__ = "mantencion"

    id = db.Column(db.Integer, primary_key=True)
    equipo_id = db.Column(db.Integer, db.ForeignKey("equipo.id"), nullable=False)
    cantidad = db.Column(db.Integer, nullable=False, default=1)
    motivo = db.Column(db.String(250), nullable=False)
    fecha_inicio = db.Column(db.Date, nullable=False, default=hoy)
    fecha_fin = db.Column(db.Date)
    costo = db.Column(db.Integer, nullable=False, default=0)
    notas = db.Column(db.Text)

    equipo = db.relationship("Equipo", back_populates="mantenciones")

    @property
    def abierta(self) -> bool:
        return self.fecha_fin is None


# --------------------------------------------------------------------------- #
# Documentos: cotizaciones y arriendos comparten estructura de líneas y totales
# --------------------------------------------------------------------------- #
def subtotal_linea(cantidad: int, precio_unitario: int, descuento_pct: int) -> int:
    """Subtotal de una línea, con redondeo al peso (half-up, sin flotantes)."""
    return (cantidad * precio_unitario * (100 - descuento_pct) + 50) // 100


class LineaMixin:
    cantidad = db.Column(db.Integer, nullable=False, default=1)
    # Precio de UNA unidad por todo el período (no por día).
    precio_unitario = db.Column(db.Integer, nullable=False, default=0)
    descuento_pct = db.Column(db.Integer, nullable=False, default=0)

    @property
    def subtotal(self) -> int:
        return subtotal_linea(self.cantidad, self.precio_unitario, self.descuento_pct)


class DocumentoMixin:
    """Fechas y totales comunes a cotización y arriendo."""

    @property
    def dias(self) -> int:
        return max(1, (self.fecha_fin - self.fecha_inicio).days)

    @property
    def neto_items(self) -> int:
        return sum(i.subtotal for i in self.items)

    @property
    def neto(self) -> int:
        return self.neto_items + (self.flete or 0) + (getattr(self, "recargo", 0) or 0)

    @property
    def iva(self) -> int:
        return (self.neto * self.iva_pct + 50) // 100

    @property
    def total(self) -> int:
        return self.neto + self.iva

    @property
    def garantia_total(self) -> int:
        return sum(i.cantidad * (i.equipo.garantia if i.equipo else 0) for i in self.items)


class Cotizacion(DocumentoMixin, db.Model):
    __tablename__ = "cotizacion"
    ESTADOS = {
        "borrador": "Borrador", "enviada": "Enviada", "aceptada": "Aceptada",
        "rechazada": "Rechazada", "vencida": "Vencida",
    }

    id = db.Column(db.Integer, primary_key=True)
    numero = db.Column(db.String(20), nullable=False, unique=True)
    cliente_id = db.Column(db.Integer, db.ForeignKey("cliente.id"), nullable=False)
    estado = db.Column(db.String(12), nullable=False, default="borrador")
    fecha = db.Column(db.Date, nullable=False, default=hoy)
    validez_dias = db.Column(db.Integer, nullable=False, default=7)
    fecha_inicio = db.Column(db.Date, nullable=False)
    fecha_fin = db.Column(db.Date, nullable=False)
    flete = db.Column(db.Integer, nullable=False, default=0)  # despacho / retiro
    iva_pct = db.Column(db.Integer, nullable=False, default=19)
    notas = db.Column(db.Text)
    creado_por_id = db.Column(db.Integer, db.ForeignKey("usuario.id"))
    creado = db.Column(db.DateTime, nullable=False, default=ahora)

    cliente = db.relationship("Cliente", back_populates="cotizaciones")
    creado_por = db.relationship("Usuario")
    items = db.relationship(
        "CotizacionItem", back_populates="cotizacion",
        cascade="all, delete-orphan", order_by="CotizacionItem.id")
    arriendo = db.relationship("Arriendo", back_populates="cotizacion", uselist=False)

    @property
    def fecha_vencimiento(self) -> date:
        return self.fecha + timedelta(days=self.validez_dias)

    @property
    def estado_efectivo(self) -> str:
        """Una cotización sin respuesta pasada su validez figura como vencida."""
        if self.estado in ("borrador", "enviada") and hoy() > self.fecha_vencimiento:
            return "vencida"
        return self.estado

    @property
    def editable(self) -> bool:
        return self.arriendo is None and self.estado in ("borrador", "enviada", "vencida")


class CotizacionItem(LineaMixin, db.Model):
    __tablename__ = "cotizacion_item"
    id = db.Column(db.Integer, primary_key=True)
    cotizacion_id = db.Column(db.Integer, db.ForeignKey("cotizacion.id"), nullable=False)
    equipo_id = db.Column(db.Integer, db.ForeignKey("equipo.id"), nullable=False)

    cotizacion = db.relationship("Cotizacion", back_populates="items")
    equipo = db.relationship("Equipo")


class Arriendo(DocumentoMixin, db.Model):
    __tablename__ = "arriendo"
    ESTADOS = {
        "reservado": "Reservado", "activo": "En arriendo",
        "finalizado": "Finalizado", "cancelado": "Cancelado",
    }

    id = db.Column(db.Integer, primary_key=True)
    numero = db.Column(db.String(20), nullable=False, unique=True)
    cliente_id = db.Column(db.Integer, db.ForeignKey("cliente.id"), nullable=False)
    cotizacion_id = db.Column(db.Integer, db.ForeignKey("cotizacion.id"), unique=True)
    estado = db.Column(db.String(12), nullable=False, default="reservado")
    fecha_inicio = db.Column(db.Date, nullable=False)  # salida
    fecha_fin = db.Column(db.Date, nullable=False)  # devolución prevista
    fecha_devolucion = db.Column(db.Date)  # devolución real (al finalizar)
    lugar_uso = db.Column(db.String(250))  # obra o dirección de destino
    flete = db.Column(db.Integer, nullable=False, default=0)
    recargo = db.Column(db.Integer, nullable=False, default=0)  # días extra
    iva_pct = db.Column(db.Integer, nullable=False, default=19)
    garantia_monto = db.Column(db.Integer, nullable=False, default=0)
    garantia_devuelta = db.Column(db.Boolean, nullable=False, default=False)
    notas = db.Column(db.Text)
    creado_por_id = db.Column(db.Integer, db.ForeignKey("usuario.id"))
    creado = db.Column(db.DateTime, nullable=False, default=ahora)

    cliente = db.relationship("Cliente", back_populates="arriendos")
    cotizacion = db.relationship("Cotizacion", back_populates="arriendo")
    creado_por = db.relationship("Usuario")
    items = db.relationship(
        "ArriendoItem", back_populates="arriendo",
        cascade="all, delete-orphan", order_by="ArriendoItem.id")
    pagos = db.relationship(
        "Pago", back_populates="arriendo", cascade="all, delete-orphan",
        order_by="Pago.fecha, Pago.id")

    @property
    def pagado(self) -> int:
        return sum(p.monto for p in self.pagos)

    @property
    def saldo(self) -> int:
        if self.estado == "cancelado":
            return 0
        return self.total - self.pagado

    @property
    def pendiente_devolver(self) -> int:
        return sum(i.pendiente for i in self.items)

    @property
    def atrasado(self) -> bool:
        return self.estado == "activo" and hoy() > self.fecha_fin

    @property
    def dias_atraso(self) -> int:
        return (hoy() - self.fecha_fin).days if self.atrasado else 0

    @property
    def por_vencer_hoy(self) -> bool:
        return self.estado == "activo" and hoy() == self.fecha_fin

    @property
    def editable(self) -> bool:
        return self.estado == "reservado"


class ArriendoItem(LineaMixin, db.Model):
    __tablename__ = "arriendo_item"
    id = db.Column(db.Integer, primary_key=True)
    arriendo_id = db.Column(db.Integer, db.ForeignKey("arriendo.id"), nullable=False)
    equipo_id = db.Column(db.Integer, db.ForeignKey("equipo.id"), nullable=False)
    cantidad_devuelta = db.Column(db.Integer, nullable=False, default=0)
    notas_devolucion = db.Column(db.String(250))

    arriendo = db.relationship("Arriendo", back_populates="items")
    equipo = db.relationship("Equipo")

    @property
    def pendiente(self) -> int:
        return self.cantidad - self.cantidad_devuelta


class Pago(db.Model):
    __tablename__ = "pago"
    METODOS = {
        "efectivo": "Efectivo", "transferencia": "Transferencia",
        "debito": "Tarjeta de débito", "credito": "Tarjeta de crédito",
        "cheque": "Cheque",
    }

    id = db.Column(db.Integer, primary_key=True)
    arriendo_id = db.Column(db.Integer, db.ForeignKey("arriendo.id"), nullable=False)
    fecha = db.Column(db.Date, nullable=False, default=hoy)
    monto = db.Column(db.Integer, nullable=False)
    metodo = db.Column(db.String(20), nullable=False, default="transferencia")
    referencia = db.Column(db.String(120))
    usuario_id = db.Column(db.Integer, db.ForeignKey("usuario.id"))

    arriendo = db.relationship("Arriendo", back_populates="pagos")
    usuario = db.relationship("Usuario")


"""Arranque inicial y datos de demostración."""
import os
from datetime import timedelta

import click

from . import services
from .extensions import db
from .models import (
    Arriendo, ArriendoItem, Categoria, Cliente, Cotizacion, CotizacionItem, Equipo,
    Mantencion, MovimientoInventario, Pago, Usuario, hoy,
)
from .utils import _dv


def arrancar(app) -> None:
    """Crea el primer administrador desde variables de entorno si no hay usuarios.

    Sirve para desplegar en un hosting sin acceso a terminal: se declara
    ADMIN_EMAIL y ADMIN_PASSWORD, y en el primer arranque queda listo el acceso.
    """
    email, clave = os.environ.get("ADMIN_EMAIL"), os.environ.get("ADMIN_PASSWORD")
    if email and clave and Usuario.query.count() == 0:
        crear_admin(email, clave, os.environ.get("ADMIN_NOMBRE", "Administrador"))
        app.logger.info("Administrador inicial creado: %s", email)
    if os.environ.get("SEED_DEMO") == "1" and Equipo.query.count() == 0:
        cargar_demo()
        app.logger.info("Datos de demostración cargados.")


def crear_admin(email: str, clave: str, nombre: str = "Administrador") -> Usuario:
    u = Usuario(nombre=nombre, email=email.strip().lower(), rol="admin")
    u.set_password(clave)
    db.session.add(u)
    db.session.commit()
    return u


def _rut(cuerpo: int) -> str:
    return f"{cuerpo}-{_dv(str(cuerpo))}"


def cargar_demo() -> None:
    cats = {n: Categoria(nombre=n) for n in (
        "Construcción", "Jardín y forestal", "Energía", "Limpieza", "Andamios y escaleras",
        "Herramientas eléctricas", "Movimiento de tierra")}
    db.session.add_all(cats.values())

    def eq(codigo, nombre, cat, marca, modelo, cant, dia, sem, mes, gar, rep, ubic="Bodega Pucón"):
        e = Equipo(codigo=codigo, nombre=nombre, categoria=cats[cat], marca=marca, modelo=modelo,
                   cantidad_total=cant, tarifa_dia=dia, tarifa_semana=sem, tarifa_mes=mes,
                   garantia=gar, valor_reposicion=rep, ubicacion=ubic)
        db.session.add(e)
        db.session.flush()
        db.session.add(MovimientoInventario(
            equipo_id=e.id, tipo="ingreso", cantidad=cant, motivo="Ingreso inicial (demo)"))
        return e

    rotomartillo = eq("HE-001", "Rotomartillo demoledor 10 kg", "Herramientas eléctricas", "Bosch", "GSH 11 E", 3, 25000, 120000, 380000, 60000, 950000)
    placa = eq("CO-001", "Placa compactadora 90 kg", "Construcción", "Wacker", "WP1550", 2, 38000, 190000, 600000, 100000, 1800000)
    betonera = eq("CO-002", "Betonera 150 L", "Construcción", "Kushiro", "BE-150", 3, 22000, 105000, 330000, 50000, 480000)
    generador = eq("EN-001", "Generador 5 kVA", "Energía", "Honda", "EG5000", 2, 45000, 230000, 700000, 120000, 1500000)
    hidro = eq("LI-001", "Hidrolavadora 200 bar", "Limpieza", "Karcher", "HD 6/15", 2, 28000, 140000, 430000, 60000, 650000)
    andamio = eq("AN-001", "Andamio modular (cuerpo)", "Andamios y escaleras", "Layher", "Allround", 40, 3500, 15000, 42000, 5000, 95000)
    escalera = eq("AN-002", "Escalera telescópica 5 m", "Andamios y escaleras", "Little Giant", "Velocity", 4, 9000, 40000, 110000, 20000, 210000)
    motosierra = eq("JF-001", "Motosierra 20\"", "Jardín y forestal", "Stihl", "MS 261", 3, 20000, 95000, 290000, 50000, 780000)
    cortacesped = eq("JF-002", "Cortadora de pasto autopropulsada", "Jardín y forestal", "Honda", "HRX 476", 2, 18000, 85000, 260000, 40000, 620000)
    desmalezadora = eq("JF-003", "Desmalezadora a bencina", "Jardín y forestal", "Stihl", "FS 120", 3, 15000, 70000, 210000, 30000, 380000)
    mini = eq("MT-001", "Mini excavadora 1,8 t", "Movimiento de tierra", "Kubota", "KX018-4", 1, 140000, 680000, 2000000, 500000, 22000000, "Patio")
    eq("HE-002", "Taladro percutor", "Herramientas eléctricas", "Makita", "HP2050", 6, 9000, 40000, 120000, 20000, 140000)
    eq("CO-003", "Vibrador de hormigón", "Construcción", "Wacker", "IREN 38", 2, 20000, 95000, 290000, 40000, 520000)
    torre = eq("EN-002", "Torre de iluminación LED", "Energía", "Generac", "LT-4", 1, 60000, 300000, 900000, 150000, 3200000)
    db.session.flush()

    ruts = [_rut(n) for n in (76123456, 9876543, 12345678, 77894560, 15678901)]
    clientes = [
        Cliente(tipo="empresa", nombre="Constructora Villarrica SpA", rut=ruts[0], contacto="Marcela Soto",
                email="compras@constructoravillarrica.cl", telefono="+56 9 5555 1201",
                direccion="Av. Pedro de Valdivia 450", ciudad="Villarrica"),
        Cliente(tipo="persona", nombre="Jorge Contreras Muñoz", rut=ruts[1], email="jcontreras@example.cl",
                telefono="+56 9 5555 3344", direccion="Camino a Caburgua km 4", ciudad="Pucón",
                notas="Cliente frecuente, buen pagador."),
        Cliente(tipo="persona", nombre="Andrea Pinto Ríos", rut=ruts[2], telefono="+56 9 5555 7788",
                direccion="Los Notros 120", ciudad="Pucón"),
        Cliente(tipo="empresa", nombre="Hotel Lago Azul Ltda.", rut=ruts[3], contacto="Rodrigo Vera",
                email="mantencion@hotellagoazul.cl", telefono="+56 45 244 0000",
                direccion="Costanera 800", ciudad="Pucón", notas="Factura a 30 días."),
        Cliente(tipo="persona", nombre="Tomás Fuentes Ibáñez", rut=ruts[4], telefono="+56 9 5555 9090",
                ciudad="Curarrehue"),
    ]
    db.session.add_all(clientes)
    db.session.flush()
    c_constr, c_jorge, c_andrea, c_hotel, c_tomas = clientes

    def arriendo(cliente, inicio, fin, lineas, estado, lugar=None, flete=0, garantia=None, pagos=(), dev=None):
        arr = Arriendo(
            numero=services.siguiente_numero("ARR"), cliente_id=cliente.id, estado=estado,
            fecha_inicio=hoy() + timedelta(days=inicio), fecha_fin=hoy() + timedelta(days=fin),
            lugar_uso=lugar, flete=flete, iva_pct=19,
        )
        dias = max(1, fin - inicio)
        for equipo, cant in lineas:
            arr.items.append(ArriendoItem(
                equipo_id=equipo.id, cantidad=cant, precio_unitario=services.precio_equipo(equipo, dias)))
        arr.garantia_monto = garantia if garantia is not None else sum(e.garantia * c for e, c in lineas)
        if estado == "finalizado":
            arr.fecha_devolucion = hoy() + timedelta(days=dev if dev is not None else fin)
            for i in arr.items:
                i.cantidad_devuelta = i.cantidad
            arr.garantia_devuelta = True
        for dia, monto, metodo in pagos:
            arr.pagos.append(Pago(fecha=hoy() + timedelta(days=dia), monto=monto, metodo=metodo))
        db.session.add(arr)
        db.session.flush()
        return arr

    # Historial cerrado (alimenta ingresos de meses anteriores)
    a = arriendo(c_constr, -75, -68, [(placa, 1), (betonera, 2)], "finalizado", "Obra Los Robles")
    a.pagos.append(Pago(fecha=hoy() + timedelta(days=-68), monto=a.total, metodo="transferencia"))
    a = arriendo(c_hotel, -50, -43, [(hidro, 1), (andamio, 12)], "finalizado", "Hotel Lago Azul")
    a.pagos.append(Pago(fecha=hoy() + timedelta(days=-42), monto=a.total, metodo="transferencia"))
    a = arriendo(c_jorge, -20, -18, [(motosierra, 1), (desmalezadora, 1)], "finalizado")
    a.pagos.append(Pago(fecha=hoy() + timedelta(days=-18), monto=a.total, metodo="efectivo"))

    # En curso: uno al día, uno atrasado, uno que vence hoy
    a = arriendo(c_constr, -5, 9, [(mini, 1), (generador, 1)], "activo", "Loteo Los Notros",
                 flete=45000)
    a.pagos.append(Pago(fecha=hoy() + timedelta(days=-5), monto=a.total // 2, metodo="transferencia"))
    a = arriendo(c_andrea, -6, -2, [(rotomartillo, 1), (escalera, 1)], "activo", "Los Notros 120",
                 pagos=[(-6, 30000, "efectivo")])
    arriendo(c_tomas, -3, 0, [(cortacesped, 1)], "activo", pagos=[(-3, 20000, "efectivo")])

    # Reservas futuras
    arriendo(c_hotel, 3, 10, [(andamio, 20), (hidro, 1), (generador, 1)], "reservado", "Hotel Lago Azul",
             flete=30000)
    arriendo(c_jorge, 7, 9, [(betonera, 1), (rotomartillo, 1)], "reservado", "Camino a Caburgua km 4")

    # Cotizaciones
    cot = Cotizacion(
        numero=services.siguiente_numero("COT"), cliente_id=c_hotel.id, estado="enviada",
        fecha=hoy(), validez_dias=7, fecha_inicio=hoy() + timedelta(days=14),
        fecha_fin=hoy() + timedelta(days=28), iva_pct=19,
        notas="Incluye retiro en el hotel. Precio válido sujeto a disponibilidad.")
    for equipo, cant in ((andamio, 30), (torre, 1)):
        cot.items.append(CotizacionItem(
            equipo_id=equipo.id, cantidad=cant, precio_unitario=services.precio_equipo(equipo, 14)))
    db.session.add(cot)
    cot2 = Cotizacion(
        numero=services.siguiente_numero("COT"), cliente_id=c_andrea.id, estado="borrador",
        fecha=hoy(), validez_dias=7, fecha_inicio=hoy() + timedelta(days=2),
        fecha_fin=hoy() + timedelta(days=3), iva_pct=19)
    cot2.items.append(CotizacionItem(
        equipo_id=desmalezadora.id, cantidad=1, precio_unitario=services.precio_equipo(desmalezadora, 1)))
    db.session.add(cot2)

    # Una unidad en mantención
    db.session.add(Mantencion(
        equipo_id=placa.id, cantidad=1, motivo="Cambio de correa y aceite", fecha_inicio=hoy() - timedelta(days=2)))
    db.session.commit()


def registrar_comandos(app) -> None:
    @app.cli.command("crear-admin")
    @click.argument("email")
    @click.option("--nombre", default="Administrador")
    @click.password_option()
    def _crear_admin(email, nombre, password):
        """Crea un usuario administrador."""
        crear_admin(email, password, nombre)
        click.echo(f"Administrador {email} creado.")

    @app.cli.command("cargar-demo")
    def _cargar_demo():
        """Carga clientes, inventario y arriendos de ejemplo (sólo en base vacía)."""
        if Equipo.query.count():
            click.echo("La base ya tiene equipos; no se carga la demo.")
            return
        cargar_demo()
        click.echo("Datos de demostración cargados.")

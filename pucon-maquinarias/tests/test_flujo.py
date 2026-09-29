from datetime import date, timedelta

from app import services
from app.extensions import db
from app.models import Arriendo, Cliente, Cotizacion, Equipo, MovimientoInventario, hoy


def _crear_base(app, cantidad=2):
    with app.app_context():
        c = Cliente(nombre="Cliente Prueba", tipo="persona")
        e = Equipo(codigo="T-1", nombre="Placa", cantidad_total=cantidad, tarifa_dia=10000,
                   tarifa_semana=50000, garantia=20000)
        db.session.add_all([c, e])
        db.session.commit()
        return c.id, e.id


def _form_doc(cliente_id, equipo_id, cantidad, inicio, fin, precio="10000", **extra):
    return {
        "cliente_id": cliente_id, "fecha_inicio": inicio.isoformat(), "fecha_fin": fin.isoformat(),
        "item_equipo": [equipo_id], "item_cantidad": [cantidad], "item_precio": [precio],
        "item_descuento": ["0"], "flete": "0", **extra,
    }


def test_requiere_login(app):
    c = app.test_client()
    r = c.get("/clientes/")
    assert r.status_code == 302 and "/login" in r.headers["Location"]
    assert c.get("/salud").status_code == 200


def test_post_sin_csrf_es_rechazado(cli):
    r = cli.c.post("/clientes/nuevo", data={"nombre": "X"})
    assert r.status_code == 400


def test_login_no_redirige_a_sitios_externos(app):
    from tests.conftest import Cliente as HttpCliente
    c = HttpCliente(app)
    r = c.c.post("/login?siguiente=//evil.com", data={
        "email": "admin@pucon.cl", "password": "clave-segura-1", "_csrf": c._token()})
    assert r.headers["Location"] == "/"


def test_login_incorrecto(app):
    from tests.conftest import Cliente as HttpCliente
    c = HttpCliente(app)
    r = c.login(clave="mala")
    assert r.status_code == 200 and "incorrectos" in r.get_data(as_text=True)


def test_paginas_principales_cargan(cli):
    for url in ("/", "/clientes/", "/clientes/nuevo", "/inventario/", "/inventario/nuevo",
                "/inventario/en-arriendo", "/cotizaciones/", "/cotizaciones/nueva", "/arriendos/",
                "/arriendos/nuevo", "/finanzas/", "/usuarios", "/configuracion", "/cuenta"):
        r = cli.get(url)
        assert r.status_code == 200, url


def test_crear_cliente_valida_rut_y_duplicados(cli, app):
    r = cli.post("/clientes/nuevo", {"nombre": "Ana", "rut": "12.345.678-9"}, token_url="/clientes/nuevo")
    assert r.status_code == 422 and "RUT no es válido" in r.get_data(as_text=True)
    r = cli.post("/clientes/nuevo", {"nombre": "Ana", "rut": "12.345.678-5"}, token_url="/clientes/nuevo")
    assert r.status_code == 302
    r = cli.post("/clientes/nuevo", {"nombre": "Otra", "rut": "12345678-5"}, token_url="/clientes/nuevo")
    assert r.status_code == 422 and "Ya existe" in r.get_data(as_text=True)


def test_crear_equipo_registra_movimiento(cli, app):
    r = cli.post("/inventario/nuevo", {
        "codigo": "x-9", "nombre": "Taladro", "tarifa_dia": "9000", "cantidad_total": "5"},
        token_url="/inventario/nuevo")
    assert r.status_code == 302
    with app.app_context():
        e = Equipo.query.filter_by(codigo="X-9").one()
        assert e.cantidad_total == 5
        assert MovimientoInventario.query.filter_by(equipo_id=e.id, tipo="ingreso").one().cantidad == 5


def test_ajustes_de_inventario(cli, app):
    _, eid = _crear_base(app, cantidad=3)
    url = f"/inventario/{eid}/movimiento"
    cli.post(url, {"tipo": "ingreso", "cantidad": "2"}, token_url="/inventario/")
    cli.post(url, {"tipo": "baja", "cantidad": "1", "motivo": "Robo"}, token_url="/inventario/")
    cli.post(url, {"tipo": "baja", "cantidad": "1"}, token_url="/inventario/")  # sin motivo: rechazada
    cli.post(url, {"tipo": "ajuste", "cantidad": "10", "motivo": "Conteo"}, token_url="/inventario/")
    with app.app_context():
        assert db.session.get(Equipo, eid).cantidad_total == 10
        assert MovimientoInventario.query.filter_by(equipo_id=eid).count() == 3


def test_flujo_completo_cotizacion_a_devolucion(cli, app):
    cid, eid = _crear_base(app, cantidad=2)
    inicio = hoy()
    fin = inicio + timedelta(days=3)

    r = cli.post("/cotizaciones/nueva", _form_doc(cid, eid, 2, inicio, fin, "30000"),
                 token_url="/cotizaciones/nueva")
    assert r.status_code == 302
    with app.app_context():
        cot = Cotizacion.query.one()
        assert cot.numero == "COT-0001"
        assert cot.neto == 60000 and cot.iva == 11400 and cot.total == 71400
        assert cot.garantia_total == 40000
        cot_id = cot.id

    r = cli.post(f"/cotizaciones/{cot_id}/convertir", token_url="/cotizaciones/")
    assert r.status_code == 302
    with app.app_context():
        arr = Arriendo.query.one()
        assert arr.estado == "reservado" and arr.numero == "ARR-0001"
        assert arr.garantia_monto == 40000
        assert db.session.get(Cotizacion, cot_id).estado == "aceptada"
        arr_id = arr.id
        assert services.resumen_stock([eid])[eid]["reservado"] == 2

    cli.post(f"/arriendos/{arr_id}/entregar", token_url="/arriendos/")
    with app.app_context():
        s = services.resumen_stock([eid])[eid]
        assert s["en_arriendo"] == 2 and s["disponible"] == 0

    cli.post(f"/arriendos/{arr_id}/pagos", {"monto": "30000", "metodo": "efectivo"}, token_url="/arriendos/")
    with app.app_context():
        assert db.session.get(Arriendo, arr_id).saldo == 41400

    # Devolución parcial y luego total
    with app.app_context():
        item_id = db.session.get(Arriendo, arr_id).items[0].id
    cli.post(f"/arriendos/{arr_id}/devolver", {f"devuelve_{item_id}": "1", "recargo": "0"}, token_url="/arriendos/")
    with app.app_context():
        a = db.session.get(Arriendo, arr_id)
        assert a.estado == "activo" and a.pendiente_devolver == 1
        assert services.resumen_stock([eid])[eid]["disponible"] == 1
    cli.post(f"/arriendos/{arr_id}/devolver", {f"devuelve_{item_id}": "1", "recargo": "0"}, token_url="/arriendos/")
    with app.app_context():
        a = db.session.get(Arriendo, arr_id)
        assert a.estado == "finalizado" and a.fecha_devolucion == hoy()
        assert services.resumen_stock([eid])[eid]["disponible"] == 2


def test_no_permite_sobrearrendar(cli, app):
    cid, eid = _crear_base(app, cantidad=2)
    inicio, fin = hoy() + timedelta(days=1), hoy() + timedelta(days=4)
    r = cli.post("/arriendos/nuevo", _form_doc(cid, eid, 2, inicio, fin, accion="reservar"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 302
    # Mismas fechas, una unidad más de lo que queda: rechazado
    r = cli.post("/arriendos/nuevo", _form_doc(cid, eid, 1, inicio, fin, accion="reservar"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 422 and "sólo hay 0" in r.get_data(as_text=True)
    # Fechas que no se cruzan: permitido (la salida coincide con la devolución anterior)
    r = cli.post("/arriendos/nuevo", _form_doc(cid, eid, 2, fin, fin + timedelta(days=2), accion="reservar"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 302
    with app.app_context():
        assert Arriendo.query.count() == 2


def test_mantencion_reduce_disponibilidad(cli, app):
    cid, eid = _crear_base(app, cantidad=2)
    cli.post(f"/inventario/{eid}/mantencion", {"cantidad": "1", "motivo": "Aceite"}, token_url="/inventario/")
    with app.app_context():
        assert services.resumen_stock([eid])[eid]["disponible"] == 1
        assert services.resumen_stock([eid])[eid]["en_mantencion"] == 1
    r = cli.post("/arriendos/nuevo", _form_doc(cid, eid, 2, hoy(), hoy() + timedelta(days=1), accion="entregar"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 422
    with app.app_context():
        from app.models import Mantencion
        mid = Mantencion.query.one().id
    cli.post(f"/inventario/mantenciones/{mid}/cerrar", {"costo": "15000"}, token_url="/inventario/")
    with app.app_context():
        assert services.resumen_stock([eid])[eid]["disponible"] == 2


def test_atraso_y_recargo(cli, app):
    cid, eid = _crear_base(app, cantidad=1)
    inicio = hoy() - timedelta(days=5)
    fin = hoy() - timedelta(days=3)
    r = cli.post("/arriendos/nuevo", _form_doc(cid, eid, 1, inicio, fin, "20000", accion="entregar"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 302
    with app.app_context():
        a = Arriendo.query.one()
        assert a.atrasado and a.dias_atraso == 3
        aid = a.id
        # sigue ocupando stock hoy aunque la fecha prevista ya pasó
        assert services.resumen_stock([eid])[eid]["disponible"] == 0
    page = cli.get(f"/arriendos/{aid}/devolver").get_data(as_text=True)
    assert "3 día(s) de atraso" in page and 'value="30000"' in page  # 10.000/día × 3
    with app.app_context():
        item_id = db.session.get(Arriendo, aid).items[0].id
    cli.post(f"/arriendos/{aid}/devolver", {f"devuelve_{item_id}": "1", "recargo": "30000"}, token_url="/arriendos/")
    with app.app_context():
        a = db.session.get(Arriendo, aid)
        assert a.estado == "finalizado" and a.recargo == 30000
        assert a.neto == 20000 + 30000


def test_operador_no_puede_administrar(app):
    from app.seed import crear_admin  # noqa: F401
    from app.models import Usuario
    from tests.conftest import Cliente as HttpCliente
    with app.app_context():
        u = Usuario(nombre="Op", email="op@pucon.cl", rol="operador")
        u.set_password("operador-123")
        db.session.add(u)
        db.session.commit()
    c = HttpCliente(app)
    assert c.login("op@pucon.cl", "operador-123").status_code == 302
    assert c.get("/usuarios").status_code == 403
    assert c.get("/configuracion").status_code == 403
    assert c.get("/clientes/").status_code == 200


def test_demo_carga_y_paginas_con_datos(app):
    from app.seed import cargar_demo
    from tests.conftest import Cliente as HttpCliente
    with app.app_context():
        cargar_demo()
    c = HttpCliente(app)
    c.login()
    for url in ("/", "/clientes/", "/clientes/1", "/inventario/", "/inventario/1", "/inventario/en-arriendo",
                "/cotizaciones/", "/cotizaciones/1", "/cotizaciones/1/imprimir", "/arriendos/",
                "/arriendos/1", "/arriendos/1/imprimir", "/arriendos/5/devolver", "/finanzas/",
                "/clientes/exportar.csv", "/inventario/exportar.csv", "/finanzas/pagos.csv",
                "/arriendos/8/editar", "/cotizaciones/1/editar", "/inventario/1/editar"):
        r = c.get(url)
        assert r.status_code == 200, (url, r.status_code)
    with app.app_context():
        ind = services.indicadores()
        assert ind["atrasados"] and ind["disponibles"] >= 0


def test_formulario_mal_armado_no_revienta(cli, app):
    cid, eid = _crear_base(app)
    datos = {"cliente_id": cid, "fecha_inicio": hoy().isoformat(),
             "fecha_fin": (hoy() + timedelta(days=2)).isoformat(), "item_equipo": [eid]}  # sin cantidad ni precio
    r = cli.post("/cotizaciones/nueva", datos, token_url="/cotizaciones/nueva")
    assert r.status_code == 422  # cantidad inválida: se rechaza, no da error 500


def test_redireccion_tras_crear_cliente_solo_a_rutas_internas(cli):
    r = cli.post("/clientes/nuevo?siguiente=/\\evil.com", {"nombre": "Zed"}, token_url="/clientes/nuevo")
    assert r.status_code == 302 and "evil.com" not in r.headers["Location"]
    r = cli.post("/clientes/nuevo?siguiente=/cotizaciones/nueva", {"nombre": "Zoe"}, token_url="/clientes/nuevo")
    assert r.headers["Location"].startswith("/cotizaciones/nueva?cliente=")


def test_editar_cotizacion_y_arriendo_reservado(cli, app):
    cid, eid = _crear_base(app, cantidad=3)
    ini, fin = hoy() + timedelta(days=2), hoy() + timedelta(days=5)
    cli.post("/cotizaciones/nueva", _form_doc(cid, eid, 1, ini, fin, "30000"), token_url="/cotizaciones/nueva")
    with app.app_context():
        cot_id = Cotizacion.query.one().id
    r = cli.post(f"/cotizaciones/{cot_id}/editar", _form_doc(cid, eid, 2, ini, fin, "25000", flete="10000"),
                 token_url="/cotizaciones/nueva")
    assert r.status_code == 302
    with app.app_context():
        c = db.session.get(Cotizacion, cot_id)
        assert len(c.items) == 1 and c.items[0].cantidad == 2 and c.flete == 10000
        assert c.neto == 60000

    cli.post("/arriendos/nuevo", _form_doc(cid, eid, 1, ini, fin, accion="reservar"), token_url="/arriendos/nuevo")
    with app.app_context():
        aid = Arriendo.query.one().id
    # Editar a 3 unidades: sigue cabiendo porque se ignora el propio arriendo al medir disponibilidad
    r = cli.post(f"/arriendos/{aid}/editar", _form_doc(cid, eid, 3, ini, fin, garantia_monto="5000"),
                 token_url="/arriendos/nuevo")
    assert r.status_code == 302
    with app.app_context():
        a = db.session.get(Arriendo, aid)
        assert a.items[0].cantidad == 3 and a.garantia_monto == 5000
    r = cli.post(f"/arriendos/{aid}/editar", _form_doc(cid, eid, 4, ini, fin), token_url="/arriendos/nuevo")
    assert r.status_code == 422  # sólo hay 3 en total


def test_cancelar_reserva_libera_stock(cli, app):
    cid, eid = _crear_base(app, cantidad=1)
    ini, fin = hoy() + timedelta(days=1), hoy() + timedelta(days=3)
    cli.post("/arriendos/nuevo", _form_doc(cid, eid, 1, ini, fin, accion="reservar"), token_url="/arriendos/nuevo")
    with app.app_context():
        aid = Arriendo.query.one().id
        assert services.disponible_entre(db.session.get(Equipo, eid), ini, fin) == 0
    cli.post(f"/arriendos/{aid}/cancelar", token_url="/arriendos/")
    with app.app_context():
        assert services.disponible_entre(db.session.get(Equipo, eid), ini, fin) == 1

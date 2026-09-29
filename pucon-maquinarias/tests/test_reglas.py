from app.models import subtotal_linea
from app.services import precio_por_dias
from app.utils import clp, formatear_rut, normalizar_rut


def test_rut_valido_e_invalido():
    assert normalizar_rut("12.345.678-5") == "12345678-5"
    assert normalizar_rut("12.345.678-9") is None  # dígito verificador incorrecto
    assert normalizar_rut("abc") is None
    assert formatear_rut("12345678-5") == "12.345.678-5"


def test_rut_con_k():
    assert normalizar_rut("1.000.005-k") == "1000005-K"


def test_clp():
    assert clp(1234567) == "$1.234.567"
    assert clp(0) == "$0"
    assert clp(-5000) == "-$5.000"


def test_precio_solo_diario():
    assert precio_por_dias(3, 10000) == 30000
    assert precio_por_dias(0, 10000) == 10000  # mínimo un día


def test_precio_semana_conviene():
    # 6 días a $10.000 = 60.000, pero la semana vale 50.000: se cobra la semana
    assert precio_por_dias(6, 10000, 50000) == 50000
    # 8 días: una semana + un día
    assert precio_por_dias(8, 10000, 50000) == 60000
    # 3 días: no conviene la semana
    assert precio_por_dias(3, 10000, 50000) == 30000


def test_precio_mes_conviene():
    assert precio_por_dias(28, 10000, 50000, 150000) == 150000  # 4 semanas = 200.000 > mes
    assert precio_por_dias(30, 10000, 50000, 150000) == 150000
    assert precio_por_dias(37, 10000, 50000, 150000) == 150000 + 50000  # mes + semana
    assert precio_por_dias(60, 10000, 50000, 150000) == 300000


def test_subtotal_con_descuento_redondea():
    assert subtotal_linea(2, 10000, 10) == 18000
    assert subtotal_linea(1, 999, 50) == 500  # 499,5 -> 500

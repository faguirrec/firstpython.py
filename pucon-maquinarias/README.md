# Pucón Maquinarias — gestión de arriendo de maquinaria

Aplicación web para administrar una empresa de arriendo de maquinaria liviana y
media: clientes, inventario, cotizaciones, arriendos, pagos y control de
devoluciones. Está pensada para crecer hacia un ERP específico del rubro.

> **Estado: borrador funcional (v0.1).** Cubre el ciclo completo
> *cliente → cotización → arriendo → devolución → cobro*, con datos de demo para
> probarlo. Falta lo que se lista en [Próximas etapas](#próximas-etapas) antes de
> entregarlo a un cliente.

## Qué hace hoy

| Módulo | Funciones |
|---|---|
| **Clientes** | Personas y empresas, RUT validado (dígito verificador), contacto, notas, historial de arriendos y cotizaciones, saldo pendiente, exportación CSV. |
| **Inventario** | Catálogo por categorías con cantidad de unidades, tarifas por día/semana/mes, garantía y valor de reposición. Ingresos, bajas y ajustes por conteo con bitácora. Envío a mantención y cierre con costo. Vista de **qué está en arriendo ahora**, con quién y hasta cuándo. |
| **Disponibilidad** | Se calcula, no se guarda: total − en arriendo − en mantención. Para fechas futuras se mira el *pico* de ocupación del período, así dos reservas que no se pisan no se bloquean entre sí. Un arriendo atrasado sigue ocupando stock. |
| **Cotizador** | Precio automático por período usando la combinación más barata de día/semana/mes (6 días pueden salir como 1 semana), editable a mano; descuento por línea, flete, IVA, garantía sugerida, validez y vencimiento automático. Vista imprimible / PDF. Se convierte en arriendo con un clic y reserva los equipos. |
| **Arriendos** | Reserva → entrega → devolución (total o parcial, con observaciones por equipo) → finalizado. Impide sobrearrendar. Recargo sugerido por días de atraso. Contrato imprimible. Garantía retenida/devuelta. |
| **Pagos y finanzas** | Abonos por arriendo (efectivo, transferencia, tarjeta, cheque), saldo, cuentas por cobrar, cobrado por mes, gasto en mantención, exportación CSV. |
| **Resumen** | Unidades disponibles/en arriendo/en mantención, utilización, devoluciones de hoy y atrasadas, próximas salidas, cotizaciones abiertas. |
| **Acceso** | Login con roles: *administrador* (todo, usuarios, configuración, eliminar) y *operador*. Datos de la empresa e IVA configurables. |

Funciona en el celular (mostrador o terreno) y en el computador.

## Probarlo en tu computador

Requiere Python 3.11+.

```bash
cd pucon-maquinarias
python -m venv .venv && source .venv/bin/activate      # en Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

# Crea la base (SQLite), un administrador y datos de demostración:
ADMIN_EMAIL=admin@pucon.cl ADMIN_PASSWORD=pucon2026 SEED_DEMO=1 flask --app wsgi run
```

Abre http://127.0.0.1:5000 e ingresa con `admin@pucon.cl` / `pucon2026`.
La demo trae 14 equipos, 5 clientes, arriendos en todos los estados (uno atrasado,
uno que vence hoy, dos reservados), cotizaciones y una unidad en mantención.

Sin `SEED_DEMO` la base queda vacía. También se puede hacer por comandos:

```bash
flask --app wsgi crear-admin correo@empresa.cl     # pide la contraseña
flask --app wsgi cargar-demo
```

### Pruebas

```bash
pytest                                             # SQLite temporal
TEST_DATABASE_URL=postgresql+psycopg2://... pytest # contra PostgreSQL (vacía la base)
```

Cubren cálculo de precios, RUT, disponibilidad (sobrearriendo, mantención,
atrasos), el flujo completo cotización → devolución, permisos, CSRF y que todas
las pantallas carguen con datos de demo.

## Cómo está armada

- **Flask + SQLAlchemy**, plantillas Jinja y CSS/JS propios: sin paso de compilación
  ni dependencias de frontend, fácil de desplegar y de modificar.
- **SQLite** en desarrollo, **PostgreSQL** en producción (`DATABASE_URL`).
  Probado con ambos.
- **Migraciones con Alembic** (`migrations/`): el esquema puede cambiar sin perder
  los datos del cliente. Al arrancar se aplican solas.
- Montos en **pesos enteros** (CLP no tiene decimales): sin errores de redondeo.
- Seguridad: contraseñas con hash, token CSRF en todos los formularios, cookies
  `HttpOnly`/`SameSite`/`Secure`, freno a intentos de login repetidos, redirección
  post-login sólo a rutas internas, cabeceras de seguridad, roles.

```
app/
  models.py      datos y totales de cotizaciones/arriendos
  services.py    precios, disponibilidad, numeración, indicadores
  views/         una vista por módulo
  templates/     pantallas (Jinja)
  seed.py        primer administrador y datos de demo
migrations/      historial del esquema
tests/
```

## Publicarlo en Render (con dominio .cl)

1. Sube esta carpeta a **su propio repositorio** (así `render.yaml` queda en la raíz).
2. En Render: **New → Blueprint** y elige el repositorio. Crea el servicio web y una
   base PostgreSQL. Te pide `ADMIN_EMAIL` y `ADMIN_PASSWORD`: son el primer
   administrador. Después de entrar la primera vez, borra `ADMIN_PASSWORD` del panel.
3. **Dominio**: en el servicio, *Settings → Custom Domains* → agrega
   `app.tudominio.cl` y crea en NIC Chile / tu DNS el `CNAME` que Render indica.
   El certificado HTTPS es automático.
4. No actives `SEED_DEMO` en producción.

> `render.yaml` no se ha probado todavía en Render: revisa planes y región al
> desplegar. El plan gratuito de PostgreSQL de Render caduca, por eso el archivo pide
> uno de pago; sin base persistente los datos se perderían.

**Respaldos:** antes de cargar datos reales, activa los respaldos de la base en Render
y guarda un `pg_dump` periódico.

## Decisiones que conviene conocer

- **Un equipo = un producto con cantidad**, no una ficha por unidad física. Sirve
  para andamios, vallas o herramientas iguales y para máquinas únicas (cantidad 1).
  Si necesitan seguir cada máquina por **número de serie u horómetro**, hay que
  agregar fichas por unidad (ver etapas).
- La cotización **no reserva** stock; al convertirla en arriendo sí. Al guardar una
  cotización sin stock suficiente se avisa, pero se permite.
- Los precios se **congelan** en cada línea: cambiar una tarifa no altera documentos
  ya emitidos.
- Un arriendo atrasado se sigue contando como ocupado hasta que se devuelve.

## Próximas etapas

Ordenadas por lo que más probablemente pida el cliente:

1. **Facturación electrónica SII** (boletas/facturas/guías de despacho) mediante un
   proveedor con API; hoy el sistema emite cotización y contrato, no documentos
   tributarios.
2. **Seguimiento por unidad**: número de serie, horómetro, mantención preventiva
   programada por horas o fecha, alertas de vencimiento.
3. **Contabilidad**: egresos (compras, combustible, sueldos), estado de resultados,
   rentabilidad por equipo, depreciación.
4. **Comunicación**: envío de cotizaciones por correo/WhatsApp, avisos automáticos
   de devolución próxima o atrasada.
5. **Sitio web público con catálogo** y solicitud de cotización en línea, conectado a
   esta misma base.
6. **Firma digital** del contrato, fotos del estado de entrega/devolución.
7. **Auditoría** completa de cambios por usuario, roles más finos (contabilidad,
   bodega), recuperación de contraseña por correo, doble factor.
8. Reportes: utilización por equipo, clientes top, morosidad, exportación a Excel.

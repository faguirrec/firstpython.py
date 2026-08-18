# Cuentas del Hogar

App para administrar los gastos de una casa entre dos personas, repartiéndolos
**en proporción a lo que gana cada uno** en vez de mitad y mitad.

Corre en el navegador y se instala en el iPhone como app (PWA): es una sola base
de código, sin App Store y sin cuenta de desarrollador de Apple.

```
┌─────────────┐        ┌──────────────┐        ┌─────────────┐
│  PWA React  │──────▶│  API Node    │──────▶│  SQLite     │
│ (navegador  │  /api  │  Express     │        │  hogar.db   │
│  e iPhone)  │        │              │        └─────────────┘
└─────────────┘        └──────┬───────┘
                              │ OAuth2 sólo lectura
                              ▼
                       ┌──────────────┐
                       │  Gmail API   │  avisos del banco → movimientos
                       └──────────────┘
```

## Qué hace

**Reparto proporcional.** Cada uno declara su sueldo líquido del mes. Si Ana gana
$1.510.000 y Bruno $1.010.000, a Ana le toca el 59,9% de los gastos comunes y a
Bruno el 40,1%. La app calcula cuánto debe transferir cada uno a la cuenta del
hogar y, al cierre del mes, quién le debe a quién.

**Dos cuentas, un hogar.** El primero crea el hogar y comparte una invitación:
link para WhatsApp, código QR para escanear con la cámara, o un código de 6
caracteres. Quien lo recibe crea su cuenta y entra al hogar en un solo paso. Los
dos ven exactamente los mismos datos. El hogar acepta exactamente dos
integrantes, y el código se puede anular y regenerar.

**Fondo de contingencia.** Un porcentaje configurable sobre el gasto estimado
que cada uno aporta en su misma proporción. No cuenta como gasto: se acumula en
la cuenta del hogar como reserva para imprevistos, y la app muestra cuántos
meses de gastos cubre.

**Presupuesto por categoría.** Un tope mensual por categoría, con aviso al
llegar al 80% y cuando se pasa. La barra marca por dónde va el mes, para
distinguir "gastamos el 60%" el día 10 de gastarlo el día 28.

**Metas de ahorro.** Metas con monto y fecha, que se financian desde el fondo de
reserva **por orden de prioridad**: la primera se completa antes de que la
siguiente reciba un peso. Repartir la misma bolsa entre todas a la vez daría a
entender que hay más plata de la que hay. Con fecha, calcula cuánto apartar cada
mes.

**Comparación entre meses.** En qué categorías subió y bajó el gasto respecto
del mes anterior y del promedio, ordenado por impacto.

> Presupuestos, metas y comparaciones miran **sólo los gastos comunes**. Lo que
> cada uno gasta por su cuenta queda registrado pero fuera del análisis del
> hogar.

**Lectura de Gmail.** Conectas la cuenta donde llegan los avisos del banco y la
app los convierte en movimientos: monto, comercio, fecha y últimos 4 dígitos de
la tarjeta. El acceso es de **sólo lectura** y sólo toca los correos que calzan
con las reglas que definas.

**Categorías y trazabilidad.** Cada movimiento entra categorizado según reglas
por comercio ("jumbo|lider|unimarc" → Supermercado), y los reportes muestran la
evolución mes a mes y el desglose por categoría.

**Gastos personales.** Un gasto se puede marcar como personal para que quede
registrado pero fuera del reparto.

## Cómo se calcula el reparto

Para el mes M:

```
participación[p]   = sueldo[p] / (sueldo[1] + sueldo[2])
le toca[p]         = gastos comunes del mes × participación[p]
puso[p]            = transferencias a la cuenta del hogar
                     + gastos comunes que pagó de su bolsillo
saldo[p]           = puso[p] − le toca[p]
```

- Uno con saldo positivo y el otro negativo → el segundo le transfiere la
  diferencia al primero.
- Los dos con saldo negativo → cada uno completa lo suyo a la cuenta del hogar.
- Los dos con saldo positivo → nadie debe nada; el excedente queda en la cuenta.

Si no hay sueldos cargados, el reparto cae a 50/50 y la app lo avisa. Si falta el
sueldo de un mes, se arrastra el del último mes declarado.

La proyección de principio de mes agrega la contingencia sobre el gasto estimado:

```
objetivo        = gasto estimado × (1 + contingencia%)
transfiere[p]   = objetivo × participación[p]
fondo de reserva = Σ (aportes − gastos pagados desde la cuenta del hogar)
```

## Levantarla en local

Requiere Node 20 o superior.

**En Windows**, `start.ps1` hace todo de una: cierra el servidor anterior,
compila las dos partes y arranca la app, deteniéndose con un mensaje claro si
algo falla.

```powershell
.\start.ps1            # actualiza, compila y arranca
.\start.ps1 -Fresh     # además borra la base de datos y parte de cero
.\start.ps1 -SkipBuild # arranca sin recompilar
```

> **Si `npm install` falla en `better-sqlite3` pidiendo Visual Studio**, es que tu
> versión de Node no tiene binario precompilado para esa librería, y npm intenta
> compilarla. No hace falta instalar Visual Studio: basta con actualizar la
> dependencia (`npm install better-sqlite3@latest` en `server/`) o usar la
> versión LTS de Node. Es la única dependencia nativa del proyecto.

```bash
# 1) Backend
cd server
cp .env.example .env          # y edita JWT_SECRET
npm install
npm run seed                  # opcional: hogar de ejemplo con 4 meses de datos
npm run dev                   # http://localhost:4000

# 2) Frontend, en otra terminal
cd web
npm install
npm run dev                   # http://localhost:5173
```

El seed crea `ana@ejemplo.cl` y `bruno@ejemplo.cl`, ambos con contraseña
`hogar1234`.

Para producción, `npm run build` en `web/` deja los archivos en `web/dist` y el
servidor los sirve solo: con `npm run build && npm start` en `server/` queda todo
publicado en un único puerto.

## Conectar Gmail

Sin esto la app funciona igual, cargando los gastos a mano.

1. Entra a [Google Cloud Console](https://console.cloud.google.com/) y crea un
   proyecto.
2. **APIs y servicios → Biblioteca**: habilita **Gmail API**.
3. **Pantalla de consentimiento OAuth**: tipo *Externo*. Como la app es para
   ustedes dos, déjala en modo *Prueba* y agrega ambos correos como usuarios de
   prueba. Así no necesita la verificación de Google.
4. Agrega el scope `https://www.googleapis.com/auth/gmail.readonly`.
5. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación
   web**. En *URI de redirección autorizados* pon
   `http://localhost:4000/api/gmail/callback` (y la URL pública equivalente
   cuando la publiques).
6. Copia el ID y el secreto a `server/.env`:

```env
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:4000/api/gmail/callback
```

7. Reinicia el servidor y ve a **Ajustes → Gmail → Conectar una cuenta**.

> En modo *Prueba* Google caduca el refresh token cada 7 días. Para uso
> permanente hay que publicar la app en la pantalla de consentimiento; al ser un
> scope sensible, Google pide un proceso de verificación. Mientras tanto, basta
> con reconectar la cuenta cuando la app avise que expiró.

### Ajustar las reglas de tu banco

Las reglas vienen **desactivadas** porque cada banco escribe sus avisos distinto,
y los cambia cada cierto tiempo.

1. **Ajustes → Reglas de correo**: elige la plantilla de tu banco y toca *Usar*.
2. En *Probar con un correo real*, toca **Traer un correo real de Gmail**: busca
   en tu bandeja, te muestra remitentes y asuntos, y con *Usar este* carga el
   texto del correo en el probador. También puedes pegarlo a mano.
3. Toca **Probar**: la app muestra qué monto, comercio y fecha extrajo.
4. Ajusta las expresiones regulares hasta que calce, guarda y activa la regla.
5. **Ajustes → Gmail → Simular (sin guardar)**: procesa los correos y lista qué
   movimientos crearía, sin escribir nada. Es el paso que conviene repetir hasta
   que el resultado se vea bien.
6. Cuando cuadre, **Sincronizar de verdad**.

Consejos:

- La regex del monto debe capturar el número en el **grupo 1**:
  `\$\s?([\d.,]+)`. La app entiende `$45.990` (miles a la chilena) y `$1.234,56`.
- *Sólo estas tarjetas* filtra por los últimos 4 dígitos, útil para ignorar las
  tarjetas personales que no entran al reparto.
- La búsqueda de Gmail usa la misma sintaxis del buscador: `from:`, `subject:`,
  `newer_than:60d`.
- Lo importado queda marcado **por revisar** para que confirmen categoría y si es
  común o personal. Nada se duplica: cada movimiento queda amarrado al id del
  mensaje de Gmail.

## Instalar en el iPhone

1. Abre la dirección de la app en **Safari** (Chrome en iOS no ofrece instalar).
2. Toca **Compartir** → **Agregar a pantalla de inicio**.
3. Queda con su icono, a pantalla completa y sin barra del navegador.

En la red de la casa basta con apuntar a la IP del computador. Para usarla
desde cualquier lado hace falta HTTPS: los pasos están en **[DEPLOY.md](DEPLOY.md)**,
con `Dockerfile` y `fly.toml` ya incluidos en el repositorio.

## Dominio propio y sitio público

El sitio de `www.myhaus.cl` está en `landing/`: HTML y CSS planos, sin compilar.
Dónde publicarlo, cómo dejar la app en `app.myhaus.cl` y cómo mudarse después a
un servidor propio están en **[HOSTING.md](HOSTING.md)**, con el
`docker-compose.yml` y el script de respaldo ya listos en `hosting/`.

## Estructura

```
landing/                   sitio público de www.myhaus.cl (sin compilar)
hosting/                   docker-compose, Caddy y respaldos para servidor propio
server/
  src/
    lib/db.ts              esquema SQLite y conexión
    lib/auth.ts            sesión JWT en cookie httpOnly
    services/split.ts      motor de reparto y liquidación
    services/parser.ts     extracción de monto/comercio/fecha desde un correo
    services/gmail.ts      OAuth2 y sincronización
    services/categorizer.ts categorización automática por comercio
    services/bankTemplates.ts plantillas de bancos y categorías por defecto
    routes/                auth, household, transactions, finance, settings, gmail
web/
  src/
    pages/                 Acceso, Hogar, Resumen, Movimientos, Liquidación, Reportes, Ajustes
    components/Charts.tsx  gráficos en SVG, sin librerías
    lib/api.ts             cliente tipado de la API
  public/                  manifest, service worker e iconos
```

## Privacidad

- Los datos viven en un SQLite tuyo (`server/data/hogar.db`), no en un servicio
  de terceros.
- El token de Gmail se guarda en esa misma base. **Respáldala y no la subas al
  repositorio** — ya está en `.gitignore`.
- El scope pedido es sólo lectura: la app no puede enviar, borrar ni modificar
  correos.
- El service worker nunca cachea respuestas de la API; sólo los archivos
  estáticos.

## Limitaciones conocidas

- El hogar admite exactamente dos personas; el motor de reparto está escrito para
  ese caso.
- Las plantillas de bancos son un punto de partida sobre formatos habituales de
  avisos chilenos, no un parser oficial: hay que verificarlas con un correo real
  antes de confiar en ellas.
- La sincronización es manual (botón *Sincronizar ahora*); no hay job automático.
- No hay conversión de monedas: el hogar maneja una sola.

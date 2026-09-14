# MyHaus

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
                              │ IMAP (conexión abierta) u OAuth2
                              ▼
                       ┌──────────────┐
                       │ buzón del    │  avisos del banco → movimientos
                       │ banco        │
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

**Gastos de emergencia y deudas que pasan de mes.** Un gasto común lo puede
pagar cualquiera de su bolsillo —"¿Quién lo pagó?" al anotarlo— y se reparte en
la misma proporción que todo lo demás: si Bruno desembolsa $300.000 por una
urgencia, a Ana le toca su 60% y queda debiéndole $180.000.

Al cerrar el mes esa diferencia se puede resolver de dos formas, y la elección
es del hogar:

- **Ya nos transferimos** — el mes queda limpio, como siempre.
- **Dejarlo para el próximo mes** — la deuda queda anotada y el mes siguiente
  ajusta cuánto pone cada uno. Se muestra en su propia línea, nunca sumada a lo
  que la persona transfirió: mezclarlas haría imposible cuadrar con la cartola.
  Reabrir el mes lo deshace.

**El saldo de la cuenta.** Cuánta plata debería haber hoy en la cuenta del
hogar, con el detalle de lo que venía de antes, lo que entró y lo que salió este
mes. Es el número que tiene que cuadrar con la cartola del banco, y por eso
cuenta **todo** lo que se pagó con esa cuenta, sea común o personal.

**Cuadrar con el banco.** La app suma desde cero el día que el hogar empieza a
usarla, así que si la cuenta ya tenía plata, el número nace corrido. En la
tarjeta del saldo se escribe lo que dice la cartola y la diferencia queda
anotada como ajuste, de manera que los dos números coincidan de ahí en
adelante. El ajuste es plata del hogar anterior al reparto: no le cuenta a
ninguno de los dos ni toca la liquidación.

> Un gasto marcado como personal lo paga su dueño salvo que digan lo contrario.
> Al revés —que era el comportamiento anterior— comprarse algo propio salía del
> pozo común sin que nadie respondiera por esa plata, y el saldo quedaba
> inflado frente al banco.

**Qué pasa con lo que sobra.** Si un mes cierra con plata de más en la cuenta,
esa plata tiene dos destinos posibles y hay que elegir: se queda en el hogar
—donde financia las metas de ahorro por medio de la reserva— o vuelve como
crédito a quien puso de más, bajándole el aporte del mes siguiente. La app
propone guardar hasta un porcentaje del gasto del mes (10% por defecto,
configurable) y devolver el resto, y el número se puede cambiar antes de
confirmar.

> Antes no había regla y la misma plata quedaba prometida en tres lugares a la
> vez: al fondo de reserva, a las metas y al crédito del mes siguiente. Ahora el
> fondo distingue lo **libre** de lo **comprometido** con alguien, y las metas
> se financian sólo con lo libre.

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

**Gastos fijos, reconocidos solos.** El arriendo, la luz, el agua, el internet
y las suscripciones ya están en los movimientos: son los mismos comercios
cobrando todos los meses. La app los busca y los deja listos para aceptar de un
toque, en vez de hacer que se escriban a mano. La señal que usa no es sólo que
se repitan —el supermercado también se repite— sino que lleguen **siempre por la
misma fecha**, que es lo que tiene una cuenta y no tiene un gasto corriente.

> Se proponen, no se crean solos. Un gasto fijo dice "esto se espera pagar", y
> una expectativa inventada por la app llenaría el mes de deudas que nadie
> contrajo. Lo que se ahorra es el tecleo, no la decisión.

**Comparación entre meses.** En qué categorías subió y bajó el gasto respecto
del mes anterior y del promedio, ordenado por impacto.

> Presupuestos, metas y comparaciones miran **sólo los gastos comunes**. Lo que
> cada uno gasta por su cuenta queda registrado pero fuera del análisis del
> hogar.

**Lectura del correo del banco.** Conectas la cuenta donde llegan los avisos y la
app los convierte en movimientos: monto, comercio, fecha, últimos 4 dígitos de
la tarjeta y —cuando el correo lo dice— **a qué mes pertenece la plata**, que no
siempre es el de la fecha: una transferencia con el comentario "Mensualidad
septiembre" hecha el 25 de agosto cuenta en septiembre. Con la conexión abierta al buzón, entran **apenas llegan**. La app
sólo lee, y sólo toca los correos que calzan con las reglas que definas.

**Diagnóstico del buzón.** Cuando no entra nada, la app dice por qué: revisa los
últimos correos sin filtrar por ninguna regla y, correo por correo, muestra cuál
lo tomaría o qué condición lo descartó —*«el correo no dice "compra", y la regla
lo exige»*—. Y si la plantilla de un banco cambió desde que se copió la regla,
lo avisa y ofrece traer los cambios sin perder lo que uno decidió.

**Categorías y trazabilidad.** Cada movimiento entra categorizado según reglas
por comercio ("jumbo|lider|unimarc" → Supermercado), y los reportes muestran la
evolución mes a mes y el desglose por categoría.

**Gastos personales.** Un gasto se puede marcar como personal para que quede
registrado pero fuera del reparto.

**Anotar en dos toques.** Un botón fijo sobre la barra, en todas las pantallas,
abre el formulario con el monto en grande y el teclado numérico ya arriba. La
fecha, el mes contable y la nota van plegados: casi siempre son hoy, el mes que
se está mirando y nada. Al guardar, un aviso confirma y ofrece deshacer, que es
mejor que preguntar antes en cada gasto.

**Los movimientos, por día.** Agrupados con encabezado pegajoso y el subtotal
del día al lado, y filtrados con fichas —*Por revisar*, *Comunes*, *Sin
categoría*, cada categoría— en vez de menús desplegables, que escondían cuál
estaba puesto.

**La respuesta primero, y con su botón.** El Resumen abre con la cifra del mes;
lo que falta por configurar va debajo, plegado en una línea. Y donde dice "para
quedar a mano — $3.181" hay un botón que anota justo esos $3.181: decir qué hay
que hacer y no dejar hacerlo es la razón número uno por la que se abandona una
app de presupuesto, y era exactamente lo que hacíamos. Lo mismo en Análisis:
las categorías sin tope ofrecen ponerles uno, las excedidas ajustarlo, el
promedio de los últimos meses convertirse en el estimado del mes, y los
movimientos que entraron sin categoría ordenarse solos con las reglas de
comercio que ya existen.

**Deslizar.** De lado sobre el contenido cambia de mes, porque el selector `‹ ›`
vive en el tercio de arriba —la zona a la que el pulgar no llega sin cambiar el
agarre— y es de los controles que más se tocan. Una fila de movimiento se
desliza para editarla o borrarla. El borde izquierdo se le deja al sistema: ahí
el gesto significa "atrás" desde antes de que esta app existiera.

**El mes, para leerlo de a dos.** Cerrar el mes era un botón que congelaba un
número. Cuando el mes termina, el Resumen ofrece leerlo juntos: qué costó
comparado con lo habitual, qué categoría se movió de verdad, cuál fue el gasto
único más grande —sin contar los fijos, que ya se sabían—, cómo quedó cada uno y
qué se viene el mes que entra. Nada que la app no supiera; lo que faltaba era
juntarlo en una lectura en vez de repartirlo en cuatro pantallas de gráficos.

No recomienda nada. No dice "podrían gastar menos en supermercado": dice cuánto
fue y cuánto era antes. Y calla lo que no es noticia —una variación de mil pesos,
o que "sin categoría" haya subido, que no es un cambio de hábito sino
información que falta—. `server/pruebas/t-cita.ts` verifica justamente esas dos
omisiones, que son donde vive el valor de la pantalla.

**Entrar a una categoría.** Tocar una barra del desglose —en el Resumen, en el
acumulado de Análisis, en el presupuesto o en la comparación— abre la lista de
esos movimientos.

Lo que importa acá es que la lista muestre lo mismo que la barra que se tocó. Un
gráfico nunca muestra "todos los gastos de supermercado": muestra los de un mes,
de un ámbito, y a veces sin los fijos. Si la lista de destino no arrastrara los
tres recortes, el usuario vería un total en el gráfico y otro distinto en la
lista, y dos números que no calzan en una app de plata son motivo suficiente
para dejar de usarla. El recorte viaja en la dirección —`?categoria=…&mes=…
&ambito=…&sinfijos=1`, armado en `web/src/lib/verCategoria.ts`— y la pantalla de
destino lo dice en palabras arriba de la lista: "Supermercado · septiembre 2026 ·
sólo comunes · sin los fijos". `server/pruebas/t-categoria.ts` comprueba que los
totales calcen.

Que los filtros vivan en la dirección y no en estado local arregló de paso dos
cosas que se sentían rotas: el botón de volver del teléfono ahora deshace el
filtro en vez de sacarte de la pantalla, y la vista se puede compartir o dejar
abierta y vuelve igual.

**Primeros pasos.** Un hogar recién creado ve los tres que hacen que la app
sirva: declarar los sueldos, anotar los gastos fijos y conectar el buzón. Cada
uno se marca solo, y la tarjeta desaparece cuando están los tres.

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

## Leer el correo del banco

Sin esto la app funciona igual, cargando los gastos a mano.

Hay dos formas de darle acceso al buzón, y **[CORREO.md](CORREO.md)** las
explica en detalle:

- **IMAP con una contraseña de aplicación** — la recomendada. Se configura
  entera desde la app, la credencial no caduca, y la app queda escuchando el
  buzón: los gastos entran apenas llega el aviso.
- **El permiso de Google (OAuth)** — sólo lectura de verdad, pero mientras la
  app no esté verificada por Google el permiso caduca cada 7 días.

El resto de esta sección es el resumen de la segunda.

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

## El sistema visual

Está todo en `web/src/styles.css`, arriba, en variables. Son pocas a propósito:
la mitad del trabajo de que una app se vea terminada es no inventar un valor
nuevo cada vez.

**Tipografía: cuatro tamaños de texto y tres de cifra.** Antes había veintisiete
declaraciones distintas, doce de ellas entre 0.72 y 0.94rem. Nadie ve la
diferencia entre 0.82 y 0.84, pero la suma de todas es exactamente lo que hace
que una pantalla se vea sin resolver. Ahora cada paso se nota. Las cifras van en
su propia escala: en una app de plata el número es el contenido, no un texto más
grande.

**Espaciado en múltiplos de cuatro** (`--e1` … `--e6`). Mismo motivo: márgenes
de 6, 7, 10 y 11 píxeles repartidos por la hoja no se leen como decisiones.

**Nada táctil bajo 44px** (`--tocable`). Es lo que pide Apple y hay razón: por
debajo el dedo falla y la app se siente frágil sin que uno sepa decir por qué.

**Sin tablas de más de dos columnas.** Cuatro columnas de plata no caben en un
teléfono: los nombres se parten en tres líneas y las cifras quedan pegadas. El
reparto, la liquidación, el fondo de reserva y la comparación por categoría usan
fichas o filas.

**Verde casona, no azul de banco.** El azul es el color más ocupado del rubro y
el nuestro lo era sin haberlo elegido. Pero MyHaus no compite con un banco:
compite con una planilla compartida y con acordarse de memoria. Sus dos usuarios
no están invirtiendo, están tratando de vivir juntos sin pelear por plata. Eso es
un producto doméstico, y el verde de puerta pintada —apagado, no el verde
chillón de las apps de trading— es lo que lo dice. Los neutros llevan un sesgo
verde muy leve: un gris puro se lee como no elegido, uno inclinado hacia el
acento se lee como decidido.

Las dos personas van en verde y ocre, no en verde y rojo: la dupla clásica es
ilegible para cerca del 8% de los hombres.

**Una tipografía propia, sólo donde importa.** Bricolage Grotesque va en las
cifras grandes, el logotipo y los títulos de tarjeta; el resto se queda en la
del sistema, y no es pereza —es lo correcto para una PWA que se abre treinta
segundos dos veces al día—. El archivo es nuestro y no de Google: así lo guarda
el service worker, la app abre sin conexión con su tipografía puesta y nadie
fuera de acá se entera de que la abriste.

**Rojo sólo para lo que salió mal.** Un mes a medio andar no es una emergencia.
Si el día 10 ya está todo rojo porque falta poner lo del 25, el rojo deja de
significar algo, y cuando pase algo de verdad nadie lo va a mirar. Mientras el
mes corre, lo que falta es una tarea y va en el color del texto normal
(`esMesCerrado` en `web/src/lib/format.ts` es quien decide); una vez cerrado el
mes, recién ahí es una deuda y se pinta. Gastar más que el mes pasado tampoco es
una falla, y que salga plata de la cuenta del hogar es para lo que está la
cuenta. Quedan en rojo los errores de formulario, el presupuesto excedido y el
mes cerrado con plata faltando.

Del mismo lado está el tono de los textos: "para quedar a mano" en vez de "te
falta poner", "falta su parte" en vez de "debe". La razón número uno por la que
se abandona una app de presupuesto no es que sea fea, es que da vergüenza
abrirla; y a la culpa se responde evitando.

**Todo esto se mide, no se estima.** El contraste se comprueba en la app
corriendo y no sobre los tokens, porque con `color-mix` y transparencias el
valor de la variable no es lo que se ve: 692 textos en cinco pantallas y los dos
temas, todos sobre el mínimo AA. Así se encontró que el gris apagado quedaba en
2,87:1 y que el "40%" blanco sobre ocre daba 3,85:1.

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

# Publicar la app para usarla desde el iPhone

Para que funcione fuera de la casa hacen falta tres cosas: que esté **siempre
encendida**, que tenga **HTTPS** (el iPhone no instala una PWA sin eso, y Google
no autoriza Gmail sobre HTTP), y que los datos **no se pierdan** al actualizar.

## Qué opción elegir

| | Costo | Siempre encendida | Trabajo de instalación |
|---|---|---|---|
| **Render** | ~7 USD/mes | Sí | Ninguno: todo con el mouse |
| **Fly.io** | ~1 a 3 USD/mes | Sí | Bajo: 5 comandos |
| Túnel desde tu PC | Gratis | Sólo con el PC prendido | Bajo |
| Oracle Cloud gratis | Gratis | Sí | Alto: administras un Linux |
| Raspberry Pi + túnel | ~60 USD una vez | Sí | Medio |

**Si no puedes usar terminal ni instalar programas, ve directo a Render**: se
hace entero desde el navegador conectando este repositorio, sin CLI, sin tokens
y sin cuentas de por medio. Sale más caro que Fly.io, pero es la diferencia
entre unos dólares y no tener la app andando.

**Recomendación: Fly.io.** Es la que menos te va a costar en tiempo, que es lo
caro acá. La máquina está configurada en el tamaño más chico y se suspende
sola cuando nadie la usa, así que dos personas revisando gastos gastan muy
poco. Servidor en Santiago, HTTPS y dominio incluidos, y se actualiza con un
comando.

Sobre las opciones gratis: existen y funcionan, pero "gratis" se paga en otra
moneda. Oracle Cloud regala una máquina para siempre, pero significa
administrar un servidor Linux —usuarios, firewall, certificados, respaldos— y
que cuando algo se caiga, lo arregles tú. El túnel desde tu PC es gratis de
verdad y es buena idea para probar, pero la app se cae cada vez que apagas el
computador, y eso rompe la costumbre de anotar los gastos, que es justamente lo
que hace que esto sirva.

Si el presupuesto manda, empieza con el túnel (opción C) y cámbiate a Fly.io
cuando confirmen que la usan. Migrar es copiar un archivo.

---

## Opción A — Render (todo desde el navegador)

Sin terminal, sin instalar nada, sin tokens. Render lee el archivo `render.yaml`
del repositorio y arma el servicio solo.

### 1. Crear la cuenta

En [render.com](https://render.com), entrando **con tu cuenta de GitHub**. Así
queda conectado el repositorio de una vez.

### 2. Crear el servicio

1. En el panel: **New** → **Blueprint**.
2. Elige el repositorio `firstpython.py`.
3. Elige la rama `claude/shared-expense-management-app-5yyoxu`.
4. Render lee `render.yaml` y te muestra lo que va a crear: un servicio web con
   un disco de 1 GB. Confirma.

Le toma unos minutos construir la imagen la primera vez.

### 3. Listo

Tu dirección queda como `https://cuentas-hogar.onrender.com` (Render le agrega
un sufijo si el nombre está tomado). Aparece arriba en el panel del servicio.

No hay que configurar variables a mano: el `JWT_SECRET` lo genera Render, y la
dirección pública la toma la app sola.

### 4. Crear las cuentas y cerrar la puerta

`render.yaml` deja el registro en modo invitación:

- La **primera** cuenta se crea sin código, porque la base está vacía.
- De ahí en adelante hace falta un código de invitación.

Crea tu cuenta, arma el hogar, comparte el QR con la otra persona, y cuando
ambos estén adentro cierra el registro: en el panel del servicio →
**Environment** → cambia `ALLOW_SIGNUP` a `closed` → **Save**.

### 5. Actualizar

Cada vez que se suba un cambio al repositorio, Render lo publica solo. No hay
que hacer nada.

### Qué cuesta

El plan `starter` ronda los 7 USD al mes, más un poco por el disco. El plan
gratuito **no sirve acá**: no admite disco persistente —los datos se perderían
en cada despliegue— y apaga el servicio tras un rato de inactividad.

### Si algo falla

En el panel del servicio, pestaña **Logs**, está el detalle. Los errores más
probables son de construcción de la imagen; mándame lo que digan.

---

## Opción B — Fly.io

### Sin terminal, todo desde el navegador

Si tu computador tiene bloqueada la instalación de programas —típico en equipos
de empresa— no necesitas terminal. El despliegue corre en los servidores de
GitHub. Son cuatro pasos, todos con el mouse.

**1. Crea tu cuenta en Fly.io**

En [fly.io](https://fly.io). Pide una tarjeta para verificar la cuenta.

**2. Crea un token de acceso**

En [fly.io/dashboard](https://fly.io/dashboard) → tu organización → **Tokens** →
crea uno de despliegue. Copia el valor completo, que empieza con `FlyV1 `.

**3. Guarda el token en GitHub**

En tu repositorio → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**.

- Nombre: `FLY_API_TOKEN`
- Valor: el token que copiaste

**4. Ejecuta la publicación**

En tu repositorio → pestaña **Actions** → **Publicar por primera vez** → botón
**Run workflow**. Te va a pedir:

- **nombre_app**: será tu dirección, `https://NOMBRE.fly.dev`. Elige algo poco
  adivinable, como `cuentas-hogar-a7k2`.
- **region**: `scl` (Santiago).
- **cerrar_registro**: déjalo en `no` la primera vez, o no podrás crear tu cuenta.

Dale a **Run workflow** y espera unos minutos. Al terminar, el resumen te muestra
la dirección de tu app.

Desde ahí, cada cambio que se suba al repositorio se publica solo.

### Operar la app sin terminal

En **Actions** → **Operar la app** hay un flujo para lo del día a día:

| Acción | Para qué |
|---|---|
| `ver-registros` | Qué está pasando cuando algo falla |
| `ver-estado` | Si la máquina, el disco y los secretos están bien |
| `cerrar-registro-de-cuentas` | Cuando ambos ya tienen cuenta |
| `abrir-registro-con-invitacion` | Volver a permitir registro con código |
| `respaldar-base-de-datos` | Descarga la base como archivo adjunto |
| `reiniciar` | Cuando queda pegada |

### Sin token: una terminal en el navegador

Si el token o los secretos de GitHub se hacen cuesta arriba, este camino los
evita por completo.

**GitHub Codespaces** te da una máquina Linux dentro del navegador. El
repositorio ya viene configurado: al crearla se instalan las dependencias, se
compila la app y queda `flyctl` listo.

1. En tu repositorio → botón verde **Code** → pestaña **Codespaces** →
   **Create codespace on ...**
2. Espera a que termine de prepararse (un par de minutos la primera vez).
3. En la terminal de abajo, escribe:

```bash
./deploy.sh
```

Te va a mostrar un enlace para iniciar sesión en Fly.io desde tu navegador, y
después hace todo lo demás solo. **No necesita ningún token.**

Codespaces tiene horas gratis al mes, y para publicar de vez en cuando alcanza
de sobra.

### El camino corto desde tu propia terminal: un comando

`deploy.ps1` hace todo lo automatizable: instala flyctl, crea la app y el disco,
genera los secretos, publica y deja una sola máquina corriendo.

```powershell
.\deploy.ps1
```

Sólo te va a pedir **iniciar sesión en Fly.io** desde el navegador, que es lo
único que no puede hacer un script. Si algo falla, se detiene indicando el paso;
los pasos ya hechos quedan hechos, así que puedes volver a correrlo.

Para elegir el nombre tú:

```powershell
.\deploy.ps1 -AppName cuentas-hogar-a7k2
```

### Despliegue automático en cada cambio

El repositorio trae un flujo de GitHub Actions que compila la app en cada push
y, si le das acceso, la publica sola.

1. Genera un token en tu cuenta de Fly:

```powershell
fly tokens create deploy --name github-actions
```

2. Copia el token completo (empieza con `FlyV1 ...`).
3. En GitHub → tu repositorio → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**.
4. Nombre: `FLY_API_TOKEN`. Valor: el token.

Desde ahí, cada `git push` publica la nueva versión. Sin el secreto, el flujo
igual compila y avisa que el despliegue está sin configurar, sin marcar error.

---

Si prefieres entender cada paso, o si el script falla, acá está lo mismo a mano.

### 1. Instalar la herramienta

En PowerShell:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Cierra y abre PowerShell. Después crea tu cuenta:

```powershell
fly auth signup
```

### 2. Elegir un nombre

El nombre pasa a ser tu dirección: `https://TU-NOMBRE.fly.dev`. Elige algo poco
adivinable — es una app con tus finanzas y no queremos que la encuentren por
casualidad. Por ejemplo `cuentas-hogar-a7k2`.

Ábre `fly.toml` y cambia la primera línea:

```toml
app = "cuentas-hogar-a7k2"
```

### 3. Crear la app y el disco

Un comando a la vez, desde la carpeta del proyecto:

```powershell
cd $HOME\Documents\firstpython.py
```

```powershell
fly apps create cuentas-hogar-a7k2
```

```powershell
fly volumes create datos --size 1 --region scl --yes
```

El volumen es donde vive la base de datos. **Sin él, cada actualización borraría
todos los movimientos.**

### 4. Configurar los secretos

Genera una clave larga para firmar las sesiones:

```powershell
$clave = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

```powershell
fly secrets set JWT_SECRET=$clave
```

```powershell
fly secrets set WEB_ORIGIN=https://cuentas-hogar-a7k2.fly.dev
```

### 5. Desplegar

```powershell
fly deploy
```

```powershell
fly scale count 1
```

`fly scale count 1` es importante: con SQLite tiene que haber **una sola**
máquina, o cada una tendría su propia copia de los datos.

Listo. Abre `https://cuentas-hogar-a7k2.fly.dev` desde cualquier navegador, en
cualquier parte.

### Para que el gasto se mantenga bajo

Ya viene configurado así en `fly.toml`, pero conviene que sepas por qué:

- **`memory = "256mb"`** — la máquina más chica. Para dos personas sobra.
- **`auto_stop_machines = "suspend"`** y **`min_machines_running = 0`** — cuando
  nadie usa la app, la máquina se suspende y deja de contar. Al abrirla de nuevo
  despierta en un par de segundos.
- **Volumen de 1 GB** — miles de movimientos caben de sobra.

Puedes revisar el gasto real cuando quieras con `fly dashboard`.

### 6. Crear las dos cuentas y cerrar la puerta

`fly.toml` viene con `ALLOW_SIGNUP = "invite"`, lo que significa:

- La **primera** cuenta se puede crear sin código, porque la base está vacía.
- De ahí en adelante hace falta un código de invitación.

Entonces: crea tu cuenta, crea el hogar, comparte el QR con tu señora, y cuando
ella ya esté adentro, cierra el registro del todo:

```powershell
fly secrets set ALLOW_SIGNUP=closed
```

Desde ese momento nadie más puede crear una cuenta en tu servidor, aunque
encuentre la dirección.

### 7. Actualizar más adelante

```powershell
git pull
```

```powershell
fly deploy
```

Los datos quedan intactos: viven en el volumen, no en la imagen.

### 8. Respaldar la base

Vale la pena hacerlo de vez en cuando:

```powershell
fly ssh console -C "cat /data/hogar.db" > respaldo-hogar.db
```

### Si algo falla

- **`fly deploy` se cae construyendo la imagen** — corre `fly logs` y mándame la
  salida.
- **La app abre pero no deja entrar** — falta `JWT_SECRET`. Revísalo con
  `fly secrets list`.
- **Se perdieron los datos tras desplegar** — no se creó el volumen, o hay más de
  una máquina. Verifica con `fly volumes list` y `fly status`.
- **"Out of memory"** — sube la memoria: `fly scale memory 512`.

---

## Opción C — Túnel desde tu computador

Deja la app corriendo en tu PC como hasta ahora, y Cloudflare le pone una
dirección HTTPS pública.

### 1. Instalar cloudflared

```powershell
winget install --id Cloudflare.cloudflared
```

### 2. Levantar la app y el túnel

En una ventana, la app:

```powershell
cd $HOME\Documents\firstpython.py
.\start.ps1
```

En **otra** ventana, el túnel:

```powershell
cloudflared tunnel --url http://localhost:4000
```

Te devuelve una dirección tipo `https://algo-random.trycloudflare.com`. Esa
funciona desde cualquier lado, con HTTPS.

### 3. Avisarle a la app cuál es su dirección

En `server\.env` agrega la línea, con **tu** dirección:

```env
WEB_ORIGIN=https://algo-random.trycloudflare.com
ALLOW_SIGNUP=invite
```

Y reinicia la app.

**Ojo:** con `cloudflared tunnel --url` la dirección cambia cada vez que
reinicias el túnel, así que hay que actualizar `WEB_ORIGIN` y la configuración
de Google cada vez. Para algo permanente conviene un túnel con nombre (requiere
un dominio propio en Cloudflare) o directamente la opción A o B.

---

## Si el registro "no registra" tu clic

Síntoma: completas la verificación pero la plataforma sigue como si nada. Le
pasa a cualquiera de estos servicios, y casi siempre viene del equipo o la red
de la empresa. Tres causas, en orden de frecuencia:

1. **Navegador administrado.** Las políticas corporativas bloquean cookies de
   terceros o extensiones de seguridad cortan la redirección de vuelta. La
   autenticación ocurre, pero la sesión no queda anclada.
2. **Proxy de red.** El proxy de la empresa intercepta el retorno desde el
   proveedor y la respuesta nunca llega completa.
3. **Filtros de correo.** Defender, Proofpoint y similares abren cada enlace de
   los correos entrantes para revisarlos. Los enlaces de verificación son de un
   solo uso, así que el escáner los quema antes que tú. Esta sólo aplica con
   correo corporativo.

**La prueba que las descarta todas de una:** hazlo desde tu **teléfono, con Wi-Fi
apagado y datos móviles**, en Safari, usando un correo personal. Eso saca de la
ecuación el equipo, el navegador, la red y el correo de la empresa a la vez. Si
ahí funciona, ya sabes que el problema era el entorno corporativo y no la
plataforma.

## Activar el correo

Sirve para dos cosas: mandar la invitación por correo, y el resumen mensual
automático que les llega a ambos con el cierre del mes.

### 1. Conseguir un servidor SMTP

Dos opciones fáciles:

**Gmail.** Necesita verificación en dos pasos activada. Después, en
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
generas una **contraseña de aplicación** — no sirve la contraseña normal de tu
cuenta.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu@gmail.com
SMTP_PASS=la-contraseña-de-aplicación
SMTP_FROM=Cuentas del Hogar <tu@gmail.com>
```

**Resend** ([resend.com](https://resend.com)), con 100 correos al día gratis:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=tu-api-key
SMTP_FROM=Cuentas del Hogar <onboarding@resend.dev>
```

### 2. Configurarlo en el servidor

En Render: panel del servicio → **Environment** → agrega esas variables →
**Save**. En Fly: `fly secrets set SMTP_HOST=... SMTP_USER=...` y así.

### 3. Comprobar

En la app: **Ajustes → Hogar → Correo**. Ahí hay dos botones: uno manda un
correo de prueba, y el otro te manda el resumen del mes pasado tal como lo van a
recibir.

### 4. Programar el envío mensual

La app trae un temporizador propio, pero si el servidor se suspende por
inactividad no corre a la hora indicada. Para que no falle, hay un flujo de
GitHub que lo dispara desde fuera los primeros días de cada mes.

Genera una clave y configúrala en el servidor:

```
CRON_SECRET=una-clave-larga-y-aleatoria
```

Y en GitHub → Settings → Secrets and variables → Actions, agrega dos secretos:

- `APP_URL`: la dirección de tu app, por ejemplo `https://mi-app.onrender.com`
- `CRON_SECRET`: la misma clave

El envío queda registrado por hogar, mes y destinatario, así que aunque se
dispare varias veces nadie recibe el correo repetido.

## Usar tu propio dominio .cl

Ese tema se movió a **[HOSTING.md](HOSTING.md)**, porque además del dominio hay
que decidir dónde vive el sitio público y dónde la app. En resumen: el sitio en
`www.myhaus.cl` y la app en `app.myhaus.cl`, en direcciones distintas y por una
razón concreta —la app se instala en el teléfono y su alcance es todo el dominio
donde vive, así que con el sitio en la misma dirección la página de marketing
quedaría dentro de la app instalada.

Allá están los pasos: el DNS, los dominios en Render, las dos variables de
entorno y el ajuste en Google Cloud.

## Un dominio propio en Fly.io

Se puede, y queda mejor que la dirección `.fly.dev`: `https://casa.tudominio.cl`.

### 1. Comprar el dominio

En [nic.cl](https://www.nic.cl), que es el registrador oficial de los `.cl`.
Cuesta del orden de 10.000 pesos al año. Cualquiera puede registrar uno, no hace
falta empresa.

### 2. Usa un subdominio, no el dominio pelado

Esto te ahorra plata. Un subdominio (`casa.tudominio.cl`) se apunta con un
registro CNAME y funciona con la IP compartida de Fly, que va incluida. El
dominio pelado (`tudominio.cl`) no admite CNAME, necesita una IP dedicada, y esa
sí se cobra aparte.

### 3. Pedirle el certificado a Fly

```powershell
fly certs add casa.tudominio.cl
```

Te va a responder qué registro DNS crear. Es un CNAME:

| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `casa` | `cuentas-hogar-a7k2.fly.dev` |

### 4. Crear ese registro en NIC Chile

En el panel de nic.cl, sección de DNS de tu dominio, agrega el CNAME de arriba.
Puede demorar entre unos minutos y algunas horas en propagarse.

### 5. Confirmar

```powershell
fly certs show casa.tudominio.cl
```

Cuando diga que el certificado está emitido, ya está: `https://casa.tudominio.cl`
con HTTPS válido, gratis y renovado solo.

### 6. Avisarle a la app y a Google

```powershell
fly secrets set WEB_ORIGIN=https://casa.tudominio.cl
```

Y en Google Cloud, agrega `https://casa.tudominio.cl/api/gmail/callback` a los
URI de redirección autorizados.

---

## Llevar los datos que ya cargaste

Si alcanzaste a cargar movimientos reales en tu computador, se pueden subir. La
base es un solo archivo.

Con la app **detenida** en producción para que nadie escriba mientras tanto:

```powershell
fly ssh sftp shell
```

Y dentro de esa consola:

```
put server/data/hogar.db /data/hogar.db
```

Si todavía no cargaste casi nada, es más simple partir de cero en producción y
dejar la base local como estaba.

## Leer el correo del banco en producción

El paso a paso completo está en **[CORREO.md](CORREO.md)**, que cubre las dos
formas de conectar el buzón. La recomendada —IMAP con una contraseña de
aplicación— se configura entera desde la app y no necesita nada acá.

Lo que sigue es para la otra, el permiso de Google:

1. En [Google Cloud Console](https://console.cloud.google.com/) → Credenciales →
   tu ID de cliente OAuth.
2. En *URI de redirección autorizados* agrega:
   `https://TU-DIRECCION/api/gmail/callback`
3. En el servidor sólo hacen falta dos variables: `GOOGLE_CLIENT_ID` y
   `GOOGLE_CLIENT_SECRET`. La URI de redirección la deduce la app de su propia
   dirección; si necesitas forzar otra, define `GOOGLE_REDIRECT_URI`.

La app muestra la URI exacta que espera en **Ajustes → Gmail**, con un botón
para copiarla. Pégala tal cual en Google Cloud: la causa número uno de que esto
falle es que difieran en un carácter.

Recuerda que mientras la pantalla de consentimiento esté en modo *Prueba*, Google
caduca el permiso cada 7 días y hay que reconectar la cuenta. Para dejarlo
permanente hay que publicarla, y al ser un permiso sensible pasa por una
verificación de Google.

---

## Instalar en el iPhone

Con la app ya en HTTPS, en **cada** teléfono:

1. Abre la dirección en **Safari** (Chrome en iOS no ofrece instalar).
2. Toca **Compartir** → **Agregar a pantalla de inicio**.
3. Queda con su icono, a pantalla completa y sin barra del navegador.

Recién ahí funciona el service worker, así que la app abre incluso con mala
señal (los datos siempre se piden a la red; lo que queda guardado es la interfaz).

## ¿Y una app de la App Store?

No vale la pena para dos personas. Necesitarías un Mac, la cuenta de
desarrollador de Apple (99 dólares al año) y pasar por revisión cada
actualización. La PWA instalada se ve y se usa igual: icono propio, pantalla
completa, y se actualiza sola cuando despliegas.

---

## Seguridad, en corto

La app queda expuesta a internet, así que:

- **Cierra el registro** (`ALLOW_SIGNUP=closed`) apenas ambos tengan cuenta.
- Usa un nombre de app poco adivinable.
- Contraseñas largas y distintas de las del banco.
- `JWT_SECRET` largo y aleatorio, nunca el del ejemplo.
- La base contiene tus movimientos y el permiso de Gmail: respáldala, y no la
  subas nunca al repositorio.

El login ya viene con límite de intentos, las contraseñas se guardan con bcrypt,
las sesiones van en cookies `httpOnly` y el permiso de Gmail es de sólo lectura.

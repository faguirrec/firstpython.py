# Publicar la app para usarla desde el iPhone

Para que funcione fuera de la casa hacen falta tres cosas: que esté **siempre
encendida**, que tenga **HTTPS** (el iPhone no instala una PWA sin eso, y Google
no autoriza Gmail sobre HTTP), y que los datos **no se pierdan** al actualizar.

## Qué opción elegir

| | Costo | Siempre encendida | Trabajo de instalación |
|---|---|---|---|
| **Fly.io** | ~1 a 3 USD/mes | Sí | Bajo: 5 comandos |
| Túnel desde tu PC | Gratis | Sólo con el PC prendido | Bajo |
| Oracle Cloud gratis | Gratis | Sí | Alto: administras un Linux |
| Raspberry Pi + túnel | ~60 USD una vez | Sí | Medio |

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

Si el presupuesto manda, empieza con el túnel (opción B) y cámbiate a Fly.io
cuando confirmen que la usan. Migrar es copiar un archivo.

---

## Opción A — Fly.io

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

### Si prefieres una terminal de verdad

**GitHub Codespaces** te da una máquina Linux completa dentro del navegador, con
terminal, sin instalar nada en tu computador. En tu repositorio → botón verde
**Code** → pestaña **Codespaces** → **Create codespace**. Adentro corres los
comandos de `flyctl` como si fuera tu máquina. Tiene horas gratis al mes.

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

## Opción B — Túnel desde tu computador

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
un dominio propio en Cloudflare) o directamente la opción A.

---

## Usar tu propio dominio .cl

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

## Gmail en producción

Cuando la app tenga su dirección definitiva, hay que decírselo a Google:

1. En [Google Cloud Console](https://console.cloud.google.com/) → Credenciales →
   tu ID de cliente OAuth.
2. En *URI de redirección autorizados* agrega:
   `https://TU-DIRECCION/api/gmail/callback`
3. En Fly: `fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=https://TU-DIRECCION/api/gmail/callback`

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

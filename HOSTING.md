# Dónde vive MyHaus: el sitio, la app y el dominio

Este documento responde tres cosas: dónde publicar `www.myhaus.cl` mañana mismo,
qué hay que tocar para que la app quede en `app.myhaus.cl`, y cómo salir de
Render más adelante hacia un servidor propio.

`DEPLOY.md` explica cómo se publica la app por primera vez. Esto es lo que viene
después.

## La recomendación en dos frases

Mañana: **el sitio en Cloudflare Pages (gratis) y la app donde ya está, en
Render, con el subdominio propio**. Total, lo mismo que hoy: unos 7 USD al mes.

Más adelante, cuando quieras administrar tu propia máquina: **un VPS chico en São
Paulo con `hosting/docker-compose.yml`**, que corre el sitio y la app juntos por
unos 6 USD al mes. Los archivos para eso ya están en el repositorio.

No hagas las dos cosas el mismo día. Estrenar el dominio y cambiar de servidor
son dos problemas distintos, y si algo falla conviene saber cuál de los dos fue.

---

## Etapa 1 — Mañana

### Las tres direcciones

| Dirección | Qué hay | Dónde |
|---|---|---|
| `www.myhaus.cl` | el sitio público | Cloudflare Pages |
| `myhaus.cl` | redirige a `www` | Cloudflare |
| `app.myhaus.cl` | la aplicación | Render (hoy) |

Sitio y app van en direcciones distintas a propósito, igual que en Fintoc o
Kuanto. La razón es práctica: la PWA se instala en el teléfono y su alcance es
todo el dominio donde vive. Con el sitio en la misma dirección, la página de
marketing quedaría dentro de la app instalada.

### 1. Pasar el DNS a Cloudflare

En [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site** →
`myhaus.cl`, plan **Free**. Cloudflare te va a dar dos nameservers.

Esos dos nombres se cargan una vez en el panel de **nic.cl**, en la sección de
servidores de nombre del dominio. Puede demorar unas horas en tomar efecto.

Vale la pena aunque el sitio terminara en otro lado: deja el DNS del dominio
—incluido el subdominio de la app— administrado desde un solo panel.

### 2. Publicar el sitio

**Workers & Pages** → **Create** → **Pages**.

Dos formas, las dos sirven:

- **Subiendo la carpeta**: elige *Upload assets* y arrastra `landing/` completa.
  Es lo más rápido y no necesita permisos sobre el repositorio.
- **Conectando el repositorio**: elige *Connect to Git*, rama
  `claude/shared-expense-management-app-5yyoxu`, y en la configuración de build
  deja el comando **vacío** y el directorio de salida en `landing`. Con esto,
  cada cambio al sitio se publica solo.

Después, en **Custom domains** del proyecto, agrega `www.myhaus.cl` y
`myhaus.cl`. El certificado HTTPS lo emite y renueva Cloudflare.

### 3. Apuntar `app.myhaus.cl` a Render

En Render, en el servicio: **Settings** → **Custom Domains** → agregar
`app.myhaus.cl`. Render te muestra un destino tipo `xxx.onrender.com`.

En Cloudflare, **DNS** → agregar un registro:

```
Tipo    CNAME
Nombre  app
Destino  <lo que muestre Render>
Proxy   DNS only  (la nube gris, no la naranja)
```

**La nube gris importa.** Con el proxy de Cloudflare encendido, Render no puede
validar el dominio ni emitir su certificado, y aparece un error de redirecciones
infinitas. Si más adelante quieres encender el proxy, antes hay que poner
**SSL/TLS → Full (strict)** en Cloudflare; en el modo *Flexible* que viene por
defecto, la app entra en un ciclo de redirecciones.

### 4. Decirle a la app cuál es su dirección

> **Este paso va al final, y no antes.** `CANONICAL_HOST` hace que todo lo que
> llegue por otra dirección se redirija a `app.myhaus.cl`. Si la defines antes de
> que ese subdominio resuelva, entrar por `xxx.onrender.com` te va a mandar a una
> dirección que todavía no existe y te quedas sin app. Se arregla borrando la
> variable en Render, pero es un mal rato evitable: espera a que el paso 3 esté
> funcionando.

En Render, **Environment**, dos variables:

```
WEB_ORIGIN=https://app.myhaus.cl
CANONICAL_HOST=app.myhaus.cl
```

`WEB_ORIGIN` es de dónde salen los enlaces de invitación y la dirección de
retorno de Google. `CANONICAL_HOST` hace que todo lo que llegue por
`xxx.onrender.com` se redirija al dominio propio, para que no queden dos apps
instalables con dos sesiones distintas.

Render reinicia el servicio solo al guardar.

### 5. Los dos ajustes que se olvidan

**En Google Cloud** (si ya conectaste Gmail): APIs y servicios → Credenciales →
tu cliente OAuth → agregar la URI de retorno autorizada:

```
https://app.myhaus.cl/api/gmail/callback
```

Tiene que quedar exactamente así. Un carácter distinto y Google responde
`redirect_uri_mismatch`. La dirección vieja se puede dejar mientras tanto.

**En el sitio**: al final de `landing/index.html` está la dirección de la app en
una sola línea. Mientras `app.myhaus.cl` no responda, apúntala a la de Render:

```js
var DIRECCION_APP = 'https://app.myhaus.cl';
```

### Cómo saber que quedó bien

```bash
curl -s https://app.myhaus.cl/api/health
```

Tiene que responder `{"ok":true,...}`. Y entrando a `https://xxx.onrender.com`
en el navegador, la barra de direcciones debería saltar sola a `app.myhaus.cl`.

---

## Etapa 2 — El servidor propio

Esto es lo que pediste: administrar tu propia app en vez de depender del panel
de otro. Los archivos están en `hosting/` y están listos para correr.

### Antes: lo que ganas y lo que pierdes

Ganas control y algo de plata: una máquina en São Paulo cuesta parecido a lo que
pagas hoy en Render, pero ahí caben el sitio, la app y lo que se te ocurra
después, sin pagar por servicio.

Pierdes el "no me tengo que preocupar". En Render, si la máquina muere, la
levantan ellos. En un VPS, la levantas tú. Cada tanto hay que instalar
actualizaciones de seguridad del sistema, y los respaldos son tu problema —por
eso `hosting/respaldo.sh` está incluido, y por eso conviene dejarlo en el cron el
mismo día que migras, no después.

Para dos personas anotando gastos, el trabajo real es de unos minutos al mes.
Pero es distinto de cero.

### Qué máquina

Todo esto entra sobrado en la más chica de cualquier proveedor: la app es Node y
un archivo SQLite, y son dos usuarios.

| Proveedor | Dónde | Aprox. USD/mes | Notas |
|---|---|---|---|
| **Vultr** | São Paulo | 5 a 7 | La más cerca de Chile. Recomendada. |
| AWS Lightsail | São Paulo | 5 | Precio fijo, sin sorpresas de facturación. |
| Hetzner | EE.UU. / Alemania | 4 a 5 | Más máquina por el precio, pero más lejos. |
| Oracle Cloud | São Paulo | 0 | Generosa, pero conseguir capacidad cuesta. |

Los precios son de referencia y conviene confirmarlos: cambian, y en algunas
regiones de Sudamérica hay un recargo.

Desde Santiago, São Paulo está a unos 40 ms y Ohio —donde estás hoy— a unos 130.
En una app así no se nota mucho, pero si vas a mover la máquina de todas formas,
más cerca es mejor.

**Un detalle que sí importa**: en una máquina de 1 GB, compilar el frontend puede
quedarse sin memoria. Se arregla agregando espacio de intercambio, y está en los
pasos de abajo.

### Los pasos

Sobre Ubuntu 24.04 recién instalado, entrando por SSH.

**1. Docker**

```bash
curl -fsSL https://get.docker.com | sh
```

**2. Memoria de intercambio** (sáltalo si la máquina tiene 2 GB o más)

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**3. El código**

```bash
git clone https://github.com/faguirrec/firstpython.py.git
cd firstpython.py
git checkout claude/shared-expense-management-app-5yyoxu
cd hosting
```

**4. Las variables**

```bash
cp env.ejemplo .env
nano .env
```

Adentro está explicado qué es cada una. La única que no puede quedar vacía es
`JWT_SECRET`; se genera con `openssl rand -hex 32`.

**5. El correo de los certificados**

En `hosting/Caddyfile`, arriba, cambia `correo@ejemplo.cl` por el tuyo. Ahí avisa
Let's Encrypt si un certificado no se pudo renovar.

**6. El DNS**

En Cloudflare, los tres registros apuntando a la IP del servidor, **todos en
nube gris** para que Caddy pueda pedir los certificados:

```
A   @      <IP>
A   www    <IP>
A   app    <IP>
```

**7. Arriba**

```bash
docker compose up -d --build
```

La primera vez demora varios minutos: compila el frontend y el backend. Caddy
pide los certificados solo, en cuanto el DNS resuelve.

```bash
docker compose logs -f
```

**8. El firewall**

```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

**9. Los respaldos, el mismo día**

```bash
crontab -e
```

Y una línea:

```
0 4 * * * /home/TU-USUARIO/firstpython.py/hosting/respaldo.sh /home/TU-USUARIO/respaldos
```

Copia la base todas las noches, en caliente y sin apagar nada, y deja las
últimas catorce. Pruébalo una vez a mano antes de confiar en él:

```bash
./respaldo.sh ~/respaldos
```

Y bájate una copia a tu computador de vez en cuando: un respaldo que vive en la
misma máquina que la base no sirve de mucho el día que se pierde la máquina.

### Traer la base desde Render

La base es un archivo de unos pocos MB. No hace falta apagar nada: se saca una
copia en caliente, igual que hace `respaldo.sh`.

**1.** En Render, pestaña **Shell** del servicio, sacar la copia a `/tmp`:

```bash
node -e "const D=require('better-sqlite3');new D(process.env.DB_PATH,{readonly:true}).backup('/tmp/hogar.db').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})"
```

**2.** Bajarla a tu computador. La dirección SSH exacta la muestra Render en
**Settings** → **SSH**:

```bash
scp srv-xxxx@ssh.ohio.render.com:/tmp/hogar.db .
```

**3.** Subirla al servidor nuevo y meterla en el volumen:

```bash
scp hogar.db usuario@IP:~/
```

```bash
docker compose stop app
docker compose cp ~/hogar.db app:/data/hogar.db
docker compose start app
```

Verifica antes de apagar Render del todo: entra a la app, revisa que estén los
movimientos del mes y que el reparto cuadre.

### El día a día

| Para | Comando |
|---|---|
| Ver cómo está | `docker compose ps` |
| Ver los registros | `docker compose logs -f app` |
| Publicar cambios | `git pull && docker compose up -d --build` |
| Cambiar una variable | editar `.env` y `docker compose up -d` |
| Actualizar el sitio | `git pull` (Caddy lo sirve desde el disco) |
| Actualizar el sistema | `sudo apt update && sudo apt upgrade` |

Publicar un cambio del sitio no reinicia la app: Caddy sirve `landing/` directo
desde la carpeta del repositorio.

### Al migrar, revisa lo mismo de la etapa 1

`WEB_ORIGIN` y `CANONICAL_HOST` ya van en el `.env`. Lo que hay que mirar de
nuevo es Google Cloud —la URI de retorno no cambia si el dominio es el mismo,
así que no deberías tocar nada— y que los tres registros DNS apunten a la IP
nueva.

---

## Los costos, uno al lado del otro

| | Sitio | App | Total al mes |
|---|---|---|---|
| **Hoy** | — | Render Starter | ~7 USD |
| **Etapa 1** | Cloudflare Pages, gratis | Render Starter | ~7 USD |
| **Etapa 2** | VPS | el mismo VPS | ~6 USD |

Más el dominio, que ya lo tienes, y que ronda los 10 USD al año en nic.cl.

La diferencia de plata entre las dos etapas es casi nada. La razón para pasar a
la etapa 2 no es el ahorro, es tener la máquina en tus manos.

---

## Lo que falta, cuando haya tiempo

- **Términos de uso y política de privacidad** en el sitio. Si alguna vez la app
  sale del círculo de conocidos, Google los va a pedir para aprobar el permiso
  de Gmail.
- **Un correo del dominio** (`hola@myhaus.cl`) para las invitaciones y el reporte
  mensual. Hoy `SMTP_HOST` está vacío y el correo está apagado.
- **Verificación de la app en Google**, para que el permiso de Gmail no muestre
  la pantalla de "aplicación no verificada". Mientras sean ustedes dos, se puede
  vivir con esa pantalla agregándose como usuarios de prueba.

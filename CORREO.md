# Leer el correo del banco

Esto es lo que hace que los gastos entren solos: la app lee los avisos que el
banco ya les manda y los convierte en movimientos. Nunca escribe, nunca envía,
nunca borra.

Hay dos formas de darle acceso al buzón. **La primera es la recomendada.**

| | Contraseña de aplicación | Permiso de Google |
|---|---|---|
| Se configura en | la app, 5 minutos | Google Cloud, 20 minutos |
| Caduca | no | **cada 7 días** |
| Los gastos entran | apenas llega el correo | al sincronizar |
| Requisito | verificación en dos pasos | un proyecto en Google Cloud |

La segunda existe porque ya estaba construida y funciona. Pero mientras la app
no pase la verificación de Google —un trámite de semanas para un permiso
sensible como leer el correo—, ese permiso se cae cada semana y hay que
reconectarlo a mano. Para dos personas que quieren olvidarse del tema, eso es la
diferencia entre que sirva y que no.

---

# Forma A — Contraseña de aplicación (recomendada)

Una contraseña de aplicación es una clave de 16 letras que Google genera para un
programa concreto. No es la contraseña de tu cuenta, se puede revocar cuando
quieras sin cambiar nada más, y **no caduca**.

## 1. Verificación en dos pasos

Si tu cuenta de Google todavía no la tiene, actívala en
[myaccount.google.com/security](https://myaccount.google.com/security). Sin eso,
Google no ofrece contraseñas de aplicación.

## 2. Generar la contraseña

Entra a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).

Ponle un nombre para acordarte de qué es —`MyHaus`— y Google te muestra 16
letras en cuatro grupos. Cópialas.

> Google la muestra **una sola vez**. Si la pierdes, no pasa nada: borras esa y
> generas otra.

## 3. Pegarla en la app

En la app: **Ajustes → Correo**.

- **Correo**: la dirección donde llegan los avisos del banco.
- **Contraseña de aplicación**: las 16 letras. Los espacios dan lo mismo.

Toca **Conectar**. La app prueba la conexión contra el servidor antes de
guardar nada, así que si algo está mal te enteras en ese momento y no tres días
después cuando no aparezcan los gastos.

Si el correo no es de Gmail, el botón **No uso Gmail** deja poner el servidor,
el puerto y la carpeta a mano.

## 4. Listo: queda escuchando

Cuando la cuenta aparece con la etiqueta **escuchando**, la app mantiene una
conexión abierta con el buzón. El servidor le avisa apenas llega un correo y el
movimiento entra solo, sin que nadie sincronice nada.

Por si esa conexión se cae en silencio —pasa: un proxy que corta lo que lleva
rato quieto, el servidor que recicla conexiones—, hay además una revisión cada
15 minutos. Los botones de sincronizar a mano quedan igual, para traer lo que ya
estaba en el buzón o para probar una regla recién ajustada.

## Sobre la seguridad

La contraseña se guarda **cifrada** (AES-256-GCM), con una llave derivada del
secreto del servidor. No queda en claro en la base de datos.

Aun así, conviene tenerlo presente: una contraseña de aplicación da acceso
completo a ese buzón, no sólo de lectura. Se revoca en cualquier momento desde
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
y conviene hacerlo el día que dejen de usar la app.

---

# Forma B — Permiso de Google (OAuth)

Más trabajo de configurar y hay que reconectarla cada semana, pero el permiso es
estrictamente de **sólo lectura**, que es su ventaja real sobre la forma A.

## 1. Copiar la URI de redirección desde la app

Google necesita saber a qué dirección devolver al usuario después de autorizar.
Tiene que coincidir **carácter por carácter**, y es la causa número uno de que
esto falle, así que no la escribas de memoria: cópiala.

En **Ajustes → Correo**, dentro de *Conectar con el permiso de Google*, aparece
un recuadro con la URI y un botón **Copiar**:

```
https://TU-DIRECCION/api/gmail/callback
```

> Ese recuadro sólo se muestra mientras faltan las credenciales. Si necesitas
> verla después, la entrega `GET /api/gmail/status` en el campo `redirectUri`.

## 2. Crear el proyecto en Google Cloud

1. Entra a [console.cloud.google.com](https://console.cloud.google.com/).
2. Selector de proyectos → **Proyecto nuevo**.
3. Nombre: `MyHaus`. Sin organización. **Crear**.
4. Asegúrate de que el selector de arriba muestre `MyHaus`: todo lo que sigue
   tiene que pasar dentro de ese proyecto.

Usa una cuenta de Google **personal**. En las corporativas el administrador
suele bloquear la creación de proyectos y credenciales.

## 3. Habilitar la API de Gmail

**APIs y servicios** → **Biblioteca** → busca **Gmail API** → **Habilitar**.

Sin este paso todo lo demás se configura bien y la sincronización falla igual.

## 4. La pantalla de consentimiento

**APIs y servicios** → **Pantalla de consentimiento de OAuth** (en la consola
nueva se llama **Google Auth Platform**; el contenido es el mismo).

1. Tipo de usuario: **Externo**.
2. Datos de la app: nombre `MyHaus`, tu correo de asistencia, tu correo de
   desarrollador. Logo y dominios pueden quedar vacíos.
3. **Permisos** (o *Acceso a datos* → *Agregar o quitar permisos*):

   ```
   .../auth/gmail.readonly
   .../auth/userinfo.email
   ```

4. **Usuarios de prueba**: agrega **los dos correos** de ustedes. Un correo que
   no esté en esta lista recibe `access_denied` y no hay forma de continuar.
5. Guarda. **No publiques la app**; más abajo está el porqué.

## 5. Crear las credenciales

**Credenciales** → **Crear credenciales** → **ID de cliente de OAuth** →
**Aplicación web**.

- Nombre: `MyHaus web`.
- **URI de redirección autorizados**: pega la del paso 1. Si ya sabes que la app
  va a quedar en `app.myhaus.cl`, agrega también
  `https://app.myhaus.cl/api/gmail/callback` desde ahora.
- **Orígenes de JavaScript autorizados**: vacío. La autorización la hace el
  servidor con una redirección, no el navegador.

**Crear**. Copia el **ID de cliente** y el **secreto**.

## 6. Ponerlas en el servidor

En Render: **Environment** → dos variables:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

**Save**; el servicio se reinicia solo. Comprueba en `/api/health` que diga
`"gmail": true`.

## 7. Conectar la cuenta

**Ajustes → Correo** → *Conectar con el permiso de Google* → **Conectar una
cuenta de Gmail**.

Va a aparecer **«Google no ha verificado esta aplicación»**. Es lo esperado:
**Configuración avanzada** → **Ir a MyHaus (no seguro)** → **Continuar**.

## Lo que va a pasar a los 7 días

En modo *Prueba*, Google caduca la autorización cada semana. Cuando pase, la
sincronización falla y hay que reconectar la cuenta. Son 30 segundos, pero hay
que acordarse.

Publicar la app para evitarlo implica verificación de Google: dominio
verificado, términos de uso, política de privacidad y un video mostrando el uso
del permiso. Semanas de trámite.

**Si esto te molesta, usa la forma A.** Es exactamente el problema que resuelve.

---

# Las reglas del banco (con cualquiera de las dos formas)

Conectar el buzón no importa gastos todavía. Falta decirle **qué correos leer y
cómo interpretarlos**.

En **Ajustes → Reglas de correo** vienen plantillas listas para Banco de Chile,
Santander, BCI, BancoEstado, un caso de transferencias recibidas y una genérica.
Activa la de tu banco.

Cada regla tiene dos partes: una **búsqueda** (de qué remitente y de qué fechas)
y unos **patrones** que sacan el monto, el comercio y la fecha del texto. Las
plantillas están armadas con formatos típicos, pero cada banco cambia el suyo
cada cierto tiempo.

Para ajustarla: **Traer un correo real** busca en tu buzón y carga el texto en
el probador, que muestra qué extrajo. Si algo sale mal, se ve ahí.

## La plata que entra: de quién es

Un gasto sólo necesita saber cuánto y dónde. Un **aporte** necesita además saber
**de quién**: la liquidación suma lo que puso cada persona por su nombre, así
que un aporte sin dueño no le cuenta a nadie y el mes cierra mal.

Por eso cada regla tiene un campo **Atribuir a**. En las reglas de tipo aporte es
obligatorio en la práctica, y la app lo advierte si queda vacío.

### Cuando la cuenta del hogar no avisa los abonos

Algunas billeteras —Mercado Pago entre ellas— mandan correo cuando sale plata,
pero no cuando entra. Ahí el único rastro de un aporte es el **comprobante que
emite el banco de quien transfirió**, que llega al correo del destinatario.

La plantilla *Banco de Chile — transferencia recibida (aporte)* está hecha para
eso. Tiene dos detalles que importan:

- **Sólo si el correo dice**: por defecto trae el nombre de la cuenta del hogar
  (`Mercado Pago`). Sin ese filtro, la regla también tomaría como aporte al
  hogar la plata que recibas en tus cuentas personales.
- **Atribuir a**: quién transfirió.

Si los dos aportan desde el mismo banco, van **dos copias de la regla**, cada una
con el nombre de una persona agregado en *Sólo si el correo dice* y atribuida a
esa persona.

Y una limitación que conviene tener clara: esto sólo funciona si el banco de
quien envía manda el comprobante a esa casilla. Si uno de los dos transfiere
desde un banco que no lo hace, ese aporte hay que anotarlo a mano.

> **Manda uno o dos correos de aviso de compra reales** —puedes tapar el número
> de tarjeta, lo que importa es la estructura del texto— y la regla se puede
> ajustar al formato exacto de tu banco.

## Probar sin riesgo

En **Ajustes → Correo**, dos botones:

1. **Simular (sin guardar)** — recorre los correos, muestra qué movimientos
   crearía y con qué categoría, sin escribir nada.
2. Si se ve bien: **Sincronizar ahora**.

Lo importado queda **pendiente de revisión**, así que puedes corregir la
categoría o el ámbito —común o personal— antes de que entre al reparto del mes.

Nada se duplica: cada movimiento queda amarrado al identificador del correo.

---

# Si no entra nada: el diagnóstico

**Ajustes → Correo → ¿Por qué no entra nada? → Revisar.**

Toma los últimos correos del buzón —*sin* filtrar por la búsqueda de ninguna
regla, porque esa búsqueda puede ser justamente el problema— y dice, correo por
correo, qué hizo cada regla activa con él:

- **lo toma** — ese correo entraría como movimiento.
- **la búsqueda no lo alcanza** — el `from:` o el `newer_than:` de la regla lo
  dejan fuera antes de mirarlo.
- **descartado** — la regla lo mira y lo bota, y dice por qué: *«El correo no
  dice "compra", y la regla lo exige»*.

Si un correo del banco aparece con **ninguna regla lo toma**, ahí está la causa
y el texto dice qué cambiar.

## Cuando la plantilla de tu banco cambió

Las plantillas son una **copia**: al crear el hogar se copian a tus reglas y ahí
quedan. Si después se corrige la plantilla en la app —porque el banco cambió el
formato de sus avisos, o porque cambiaron de banco—, tu regla sigue con la copia
vieja y deja de calzar sin dar ningún error.

En **Ajustes → Reglas de correo**, una regla en esa situación avisa:

> La plantilla de este banco cambió desde que se creó esta regla.

y aparece un botón **Actualizar** que trae los patrones y los filtros nuevos.
Lo que decidiste tú —si está activa, de quién es el aporte, qué tarjetas mira,
el nombre— se mantiene.

---

# Si algo falla

**«El servidor rechazó la contraseña»**
No es una contraseña de aplicación, o la cuenta no tiene verificación en dos
pasos. La contraseña normal de Google no sirve para IMAP desde 2024.

**«No se pudo conectar al servidor de correo»**
Servidor o puerto equivocados. Para Gmail: `imap.gmail.com`, puerto `993`.

**La cuenta no dice «escuchando»**
La conexión se está reintentando. Los reintentos son cada vez más espaciados
hasta 5 minutos, así que dale un rato. Si no se recupera, revisa los registros
del servidor: el motivo queda escrito ahí.

**`redirect_uri_mismatch`** (forma B)
La URI en Google Cloud no es idéntica a la que manda la app. Compáralas
carácter por carácter: una barra de más, `http` en vez de `https`, otro dominio.

**`access_denied`** (forma B)
El correo no está en la lista de usuarios de prueba.

**«Google no devolvió refresh_token»** (forma B)
Esa cuenta ya había autorizado antes. Entra a
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
quita el acceso, y conecta de nuevo.

**La sincronización no trae nada**
El buzón está conectado pero la regla no calza. Usa **Traer un correo real**: si
no aparece ningún correo, el problema está en la búsqueda —el remitente o el
rango de fechas—; si aparecen pero sin monto, está en los patrones.

---

# Cuando la app se mude a app.myhaus.cl

La forma A no se entera del cambio de dominio: sigue funcionando igual.

La forma B sí. En Google Cloud → Credenciales → tu ID de cliente, agrega
`https://app.myhaus.cl/api/gmail/callback`. No hace falta reconectar la cuenta.

---

# Que la app pueda mandar correos

Es lo único que le falta al servidor para funcionar entero. Sin esto la app
anda igual, pero:

- Las invitaciones hay que pasarlas a mano por el link o el código QR.
- El resumen del mes cerrado no llega a nadie.

Se activa poniendo cuatro variables en Render. **No hace falta tocar código**:
el archivo `render.yaml` ya las declara como `sync: false`, que quiere decir que
Render las pide en el panel y las guarda cifradas, sin escribirlas en el
repositorio.

## Qué proveedor usar

Recomendado: **Resend**. Es gratis hasta 3.000 correos al mes —muy por encima
de lo que esta app necesita— y permite enviar desde `hola@myhaus.cl`, que es lo
que corresponde: un correo de MyHaus que llega desde una dirección de Gmail
personal se ve como spam y a menudo termina ahí.

| | Resend | Gmail con contraseña de aplicación |
|---|---|---|
| Sale desde | `hola@myhaus.cl` | tu dirección de Gmail |
| Configuración | tres registros DNS en Cloudflare | ninguna, ya tienes la clave |
| Límite | 3.000/mes | ~500/día, y Google puede frenarlo |
| Sirve para más usuarios | sí | no |

Si sólo quieres probar hoy, la segunda columna funciona en cinco minutos. Para
dejarlo andando, la primera.

## Con Resend

1. Crea la cuenta en [resend.com](https://resend.com).
2. **Domains → Add Domain** → `myhaus.cl`. Te muestra tres registros (DKIM, SPF
   y uno de retorno).
3. Cópialos a **Cloudflare → myhaus.cl → DNS → Add record**, tal cual. Van en
   **nube gris**: son registros de correo, no de tráfico web.
4. Vuelve a Resend y toca **Verify**. Suele tardar unos minutos.
5. **API Keys → Create API Key**, con permiso de envío.
6. En Render → tu servicio → **Environment**, completa:

```
SMTP_HOST = smtp.resend.com
SMTP_PORT = 587
SMTP_USER = resend
SMTP_PASS = la API key que acabas de crear
SMTP_FROM = MyHaus <hola@myhaus.cl>
```

`SMTP_USER` es literalmente la palabra `resend`: así lo pide ese proveedor.

## Con Gmail

Sirve la misma contraseña de aplicación de la forma A, o una nueva. En Render:

```
SMTP_HOST = smtp.gmail.com
SMTP_PORT = 587
SMTP_USER = tu-correo@gmail.com
SMTP_PASS = la contraseña de aplicación, sin espacios
SMTP_FROM = MyHaus <tu-correo@gmail.com>
```

`SMTP_FROM` tiene que llevar la misma dirección de `SMTP_USER`: Gmail rechaza
enviar en nombre de otra.

## Comprobar que quedó

Render reinicia el servicio solo al guardar las variables. Después:

1. Abre **Ajustes → Correo**. El estado tiene que decir **● activo** y mostrar
   desde qué dirección salen.
2. Toca **Enviar correo de prueba**. Llega en segundos.

Si dice *"El usuario o la contraseña SMTP no son correctos"*, con Gmail casi
siempre es que la contraseña se pegó con los espacios que muestra Google.

También puedes mirarlo sin entrar a la app:

```bash
curl -s https://app.myhaus.cl/api/health
```

`"correo": true` significa que está configurado.

## El resumen del mes

Con el correo andando, falta que alguien dispare el envío. La app expone la
tarea protegida con `CRON_SECRET`, que Render genera sola —está en
Environment—. Desde cualquier programador de tareas gratuito, una vez al mes:

```bash
curl -X POST https://app.myhaus.cl/api/tareas/reporte-mensual \
  -H "Authorization: Bearer EL_CRON_SECRET"
```

Cada hogar decide si lo quiere, en **Ajustes → Correo**.

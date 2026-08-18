# Conectar Gmail, paso a paso

Esto es lo que hace que los gastos entren solos: la app lee los correos de aviso
que el banco ya les manda y los convierte en movimientos. El permiso que pide es
**sólo lectura** — no puede enviar, borrar ni modificar nada.

Son unos 20 minutos, casi todos en la consola de Google. Conviene hacerlo desde
el computador, no del teléfono.

## Antes de empezar

Ten a mano dos cosas:

- **Con qué cuenta de Google vas a entrar a la consola.** Usa una personal, no
  una de empresa: en las cuentas corporativas el administrador suele bloquear la
  creación de proyectos y de credenciales.
- **Cuál es la cuenta que recibe los correos del banco.** Puede ser distinta de
  la anterior. Es la que vas a conectar al final.

---

## 1. Copiar la URI de redirección desde la app

Google necesita saber a qué dirección devolver al usuario después de autorizar.
Tiene que coincidir **carácter por carácter**, y es la causa número uno de que
esto falle, así que no la escribas de memoria: cópiala.

En la app: **Ajustes → Gmail**. Como todavía no hay credenciales, aparece un
recuadro con la URI y un botón **Copiar**. Se ve así:

```
https://TU-DIRECCION/api/gmail/callback
```

Guárdala en algún lado, la vas a pegar en el paso 5.

> Ese recuadro sólo se muestra mientras faltan las credenciales. Si necesitas
> verla después, la entrega `GET /api/gmail/status` en el campo `redirectUri`.

---

## 2. Crear el proyecto en Google Cloud

1. Entra a [console.cloud.google.com](https://console.cloud.google.com/).
2. Arriba, en el selector de proyectos → **Proyecto nuevo**.
3. Nombre: `MyHaus`. Sin organización. **Crear**.
4. Cuando termine, asegúrate de que el selector de arriba muestre `MyHaus`.
   Todo lo que sigue tiene que pasar dentro de ese proyecto.

La primera vez Google puede pedirte aceptar los términos y, en algunos casos,
verificar una tarjeta. Nada de esto se cobra: la API de Gmail para este uso está
dentro de la cuota gratis y por lejos.

---

## 3. Habilitar la API de Gmail

1. Menú lateral → **APIs y servicios** → **Biblioteca**.
2. Busca **Gmail API**.
3. **Habilitar**.

Sin este paso, todo lo demás se configura bien y la sincronización falla igual.

---

## 4. La pantalla de consentimiento

Es lo que ve el usuario cuando autoriza. Según cuándo entres, Google lo llama
**Pantalla de consentimiento de OAuth** o **Google Auth Platform**; el contenido
es el mismo.

1. **APIs y servicios** → **Pantalla de consentimiento de OAuth**.
2. Tipo de usuario: **Externo**. (*Interno* sólo existe si tienes Workspace, y
   no es tu caso.)
3. Datos de la app:
   - Nombre: `MyHaus`
   - Correo de asistencia: el tuyo
   - Correo del desarrollador: el tuyo
   - Logo y dominios: puedes dejarlos vacíos por ahora.
4. **Permisos** (en la consola nueva, *Acceso a datos* → *Agregar o quitar
   permisos*). Agrega estos dos:

   ```
   .../auth/gmail.readonly
   .../auth/userinfo.email
   ```

   El primero es el que permite leer los correos. El segundo es sólo para que la
   app sepa qué cuenta se conectó y la muestre en la lista.

5. **Usuarios de prueba**: agrega **los dos correos** de ustedes — el que recibe
   los avisos del banco y el de tu señora. Si un correo no está en esta lista,
   Google le va a responder `access_denied` y no hay forma de continuar.

6. Guarda. **No toques «Publicar la app»** por ahora; más abajo está explicado
   por qué.

---

## 5. Crear las credenciales

1. **APIs y servicios** → **Credenciales** → **Crear credenciales** →
   **ID de cliente de OAuth**.
2. Tipo de aplicación: **Aplicación web**.
3. Nombre: `MyHaus web`.
4. **URI de redirección autorizados** → **Agregar URI**, y pega la del paso 1:

   ```
   https://TU-DIRECCION/api/gmail/callback
   ```

   Si ya sabes que la app va a quedar en `app.myhaus.cl`, agrega también
   `https://app.myhaus.cl/api/gmail/callback` desde ahora. Se pueden tener
   varias, y así el día que cambies de dirección no tienes que volver acá.

5. **Orígenes de JavaScript autorizados**: déjalo vacío. La autorización la hace
   el servidor con una redirección, no el navegador.
6. **Crear**. Google te muestra el **ID de cliente** y el **Secreto de cliente**.

Cópialos ahora. El secreto se puede volver a ver después, pero es más cómodo no
tener que buscarlo.

---

## 6. Ponerlas en el servidor

En Render: panel del servicio → **Environment** → **Add Environment Variable**,
dos veces:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

**Save**. Render reinicia el servicio solo; demora un par de minutos.

La URI de redirección no hace falta configurarla: la app la deduce de su propia
dirección. Sólo si necesitas forzar otra existe `GOOGLE_REDIRECT_URI`.

### Comprobar que quedó

```
https://TU-DIRECCION/api/health
```

Tiene que responder `"gmail": true`. Si sigue en `false`, el servicio todavía no
terminó de reiniciar, o alguna de las dos variables quedó mal escrita.

---

## 7. Conectar la cuenta

En la app: **Ajustes → Gmail** → **Conectar una cuenta de Gmail**.

1. Google te pide elegir la cuenta: elige **la que recibe los correos del
   banco**.
2. Va a aparecer una pantalla que dice **«Google no ha verificado esta
   aplicación»**. Es lo esperado, y no significa que algo esté mal: la app no
   está publicada, y no lo va a estar mientras la usen ustedes dos.
   → **Configuración avanzada** → **Ir a MyHaus (no seguro)**.
3. Google muestra el permiso que pide: *ver los mensajes de correo electrónico y
   la configuración*. **Continuar**.
4. Vuelves a la app y la cuenta aparece en la lista.

---

## 8. Las reglas del banco

Conectar la cuenta no importa gastos todavía. Falta decirle **qué correos leer y
cómo interpretarlos**.

En **Ajustes → Reglas de correo** vienen plantillas listas para Banco de Chile,
Santander, BCI, BancoEstado, un caso de transferencias recibidas y una genérica.
Activa la de tu banco.

Cada regla tiene dos partes: una **búsqueda de Gmail** (de qué remitente y de
qué fechas) y unos **patrones** que sacan el monto, el comercio y la fecha del
texto del correo. Las plantillas están armadas con formatos típicos, pero cada
banco cambia el suyo de vez en cuando.

**Acá es donde te puedo ayudar yo**: mándame uno o dos correos de aviso de
compra reales —puedes tapar el número de tarjeta, lo que necesito es la
estructura del texto— y ajusto la regla al formato exacto de tu banco.

---

## 9. Probar sin riesgo

En **Ajustes → Gmail**, dos botones:

1. **Simular (sin guardar)** — recorre los correos, muestra qué movimientos
   crearía y con qué categoría, y no escribe nada en la base.
2. Si el resultado se ve bien: **Sincronizar de verdad**.

Empieza siempre por la simulación. Y si algo no calza, en **Ajustes → Gmail**
está el explorador de correos, que muestra qué encontró la búsqueda y qué sacó
de cada uno, para ver dónde falla la regla.

Los movimientos importados quedan marcados como pendientes de revisión, así que
puedes corregir la categoría o el ámbito (común o personal) antes de que entren
al reparto del mes.

---

## Lo que va a pasar a los 7 días

Mientras la pantalla de consentimiento esté en modo **Prueba**, Google caduca la
autorización cada 7 días. Cuando pase, la sincronización va a fallar y hay que
volver a **Ajustes → Gmail** → **Conectar una cuenta** y repetir el paso 7. Son
30 segundos, pero hay que saberlo.

Para que sea permanente hay que **publicar** la app en la pantalla de
consentimiento. Como `gmail.readonly` es un permiso sensible, publicarla implica
una verificación de Google: hay que tener el dominio verificado, términos de uso
y política de privacidad publicados, y un video mostrando el uso del permiso. Es
un trámite de semanas.

**La recomendación mientras sean ustedes dos: quédense en modo Prueba** y
reconecten cuando haga falta. Vale la pena publicar sólo el día que esto lo use
gente de afuera.

---

## Si algo falla

**`redirect_uri_mismatch`**
La URI en Google Cloud no es idéntica a la que manda la app. Compáralas
carácter por carácter: sobra o falta una barra al final, o es `http` en vez de
`https`, o el dominio no es el mismo. La que espera la app la entrega
`/api/gmail/status` en `redirectUri`.

**`access_denied` / «no tienes acceso a esta app»**
El correo que estás usando no está en la lista de **usuarios de prueba** del
paso 4. Agrégalo y vuelve a intentar.

**«Google no devolvió refresh_token»**
Pasa cuando esa cuenta ya había autorizado antes. Entra a
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
quita el acceso de MyHaus, y conecta de nuevo.

**`"gmail": false` en `/api/health`**
Falta alguna de las dos variables en Render, o el servicio no terminó de
reiniciar. Revisa que los nombres estén exactos: `GOOGLE_CLIENT_ID` y
`GOOGLE_CLIENT_SECRET`.

**La sincronización no trae nada**
La cuenta está conectada pero la regla no calza. Abre el explorador de correos
en **Ajustes → Gmail**: si no aparece ningún correo, el problema está en la
búsqueda de Gmail (el remitente o el rango de fechas); si aparecen pero sin
monto, está en los patrones.

**Error de cuota o de API deshabilitada**
Faltó el paso 3, o el proyecto seleccionado en la consola no era el mismo donde
creaste las credenciales.

---

## Cuando la app se mude a app.myhaus.cl

La URI de redirección cambia con el dominio. En Google Cloud → Credenciales →
tu ID de cliente, agrega:

```
https://app.myhaus.cl/api/gmail/callback
```

Deja también la anterior mientras pruebas. No hace falta reconectar la cuenta:
el permiso ya concedido sigue sirviendo.

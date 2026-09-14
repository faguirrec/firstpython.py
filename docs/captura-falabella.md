# Captura automática de compras con tarjeta — Banco Falabella (Chile)

Informe técnico para MyHaus. Fecha: 14 de septiembre de 2026.

**Convención de confianza usada en todo el documento:**
- `[V]` **Verificado** en fuente citada.
- `[P]` **Probable**: una sola fuente, o fuente secundaria (blog, resumen) sin confirmación oficial.
- `[NV]` **No verificado**: no lo encontré, o es inferencia mía. No lo uses para decidir sin comprobarlo tú.

**Nota sobre el método:** la mayoría de los sitios objetivo (cmfchile.cl, support.apple.com, fintoc.com, docs.fintoc.com, intercom.help) están bloqueados por el proxy de egreso de este entorno, así que en varios casos trabajé con resúmenes del buscador sobre esas páginas y no con la página cruda. Donde eso pasó, la afirmación va como `[P]`. Sí pude leer directo el código del scraper open source (raw.githubusercontent.com).

---

## 0. Respuesta corta, sin adornos

**No existe hoy una vía automática, barata y legítima para que las compras con tarjeta de Banco Falabella entren solas a una app propia.** Ninguna de las cinco vías la resuelve completa.

Lo que sí existe, y es lo que hay que construir, es una **arquitectura de dos piezas**:

1. **Fuente de verdad: el estado de cuenta / cartola mensual.** Falabella lo manda por correo con PDF adjunto y además se puede bajar en PDF o Excel `[P]`. MyHaus ya tiene IMAP andando: es el mismo pipeline, cambiando el parser. Cubre el **100%** del volumen, con latencia de hasta ~30 días.
2. **Feed en tiempo real parcial: automatización de Atajos con el disparador de Wallet/Apple Pay.** Esto es el hallazgo no obvio de esta investigación y **sí funciona hoy**: iOS tiene un disparador de automatización personal que se dispara cuando pagas con una tarjeta de Apple Wallet, y entrega **monto y comercio** como variables `[V]`. Banco Falabella soporta Apple Pay en Chile `[V]`. Costo: cero. Cobertura: sólo compras pagadas acercando el iPhone/Watch `[P]`, no compras online con número de tarjeta.

Las dos juntas dan: gasto en tiempo real para lo presencial + cuadratura mensual completa y confiable. La reconciliación (deduplicar lo provisional del atajo contra la cartola) es el trabajo real de ingeniería.

**Lo que hay que descartar ahora mismo:** la Ley Fintec (los datos de tarjeta de crédito no son exigibles hasta ~2029, y para consumirlos hay que ser una entidad inscrita en la CMF), y los agregadores comerciales (Fintoc, Belvo, Prometeo, Floid: son B2B, y no encontré evidencia de que ninguno entregue movimientos de tarjeta de crédito de Banco Falabella para persona natural).

**Dato que debería bajarte las expectativas de golpe:** Kuanto (kuanto.cl), que es una fintech chilena financiada, con equipo, que hace exactamente esto y lo lanzó en agosto de 2025 — **para Banco Falabella no logró captura en tiempo real tampoco**. Su solución para Falabella es procesar la **cartola mensual** que el usuario reenvía por correo `[V]`. Si ellos, con incentivo comercial y tiempo completo, terminaron en la cartola mensual, es muy improbable que exista una vía mágica que se nos esté escapando.

---

## 1. Ley Fintec 21.521 y el Sistema de Finanzas Abiertas (SFA)

### Estado real a septiembre de 2026

| Hito | Fecha | Confianza |
|---|---|---|
| Ley 21.521 publicada | 4 de enero de 2023 | `[V]` |
| NCG 514 (regula el SFA) publicada | 3 de julio de 2024 | `[V]` |
| Vigencia originalmente prevista | julio de 2026 | `[V]` |
| **NCG 569** (modifica la 514, fija reglas técnicas) publicada | **1 de junio de 2026** | `[V]` |
| **Entrada en vigencia efectiva del SFA** | **3 de julio de 2027** (36 meses desde NCG 514) | `[V]` |
| Datos de cuenta corriente, cuenta vista **y tarjetas de crédito** disponibles | **18 meses después de la vigencia** → ≈ **enero de 2029** | `[P]` |

La postergación de 12 meses fue peleada: las fintech reclamaron, los bancos y el retail financiero celebraron `[V]`. Eso es señal de dirección: la presión de la industria empuja las fechas hacia adelante, no hacia atrás. **No apuestes a que enero de 2029 se cumple.**

Cambios que trajo la NCG 569 `[P]`: historial transaccional de 12 a 24 meses, dato disponible en máximo 5 minutos, régimen de "participación simplificada" para entidades con menos de 50.000 clientes, período de pruebas piloto y sandbox de la CMF, seguridad FAPI 2.0 / OIDC.

### ¿Está Banco Falabella obligado?

**Sí.** La NCG 514 define a las **Instituciones Proveedoras de Información (IPI)**, que incluyen bancos y emisores de tarjetas de pago `[V]`. Banco Falabella es banco y emisor de la CMR: cae en el Grupo 1, el de plazos más cortos `[P]`. No es un problema de que Falabella quede fuera; es un problema de **fecha**.

### ¿Puede acceder un desarrollador independiente?

**No.** Para pedirle datos a una IPI hay que ser un **Proveedor de Servicios Basados en Información (PSBI)** `[V]`. Un PSBI:

- Debe estar **inscrito en el Registro de Prestadores de Servicios Financieros (RPSF)** de la CMF `[V]`.
- Debe acreditar requisitos proporcionales al riesgo del servicio: obligaciones de información al cliente, requisitos de idoneidad, **capital y garantías**, normas internas, gobierno corporativo y gestión de riesgos `[V]`.
- Debe certificarse en el sandbox de la CMF contra el Anexo Técnico N°3 (FAPI 2.0/OIDC, gestión de consentimiento) `[P]`.

**No encontré la cifra exacta de patrimonio mínimo o garantía específica para PSBI.** Las cifras que aparecen en las búsquedas (UF 14.000 / UF 6.000) corresponden a **intermediarios de valores**, no a PSBI — **no las uses** `[NV]`. Lo que sí es seguro es que el paquete de cumplimiento (persona jurídica, gobierno corporativo, gestión de riesgo, certificación) es incompatible con un proyecto personal de un desarrollador.

### Veredicto vía 1

| | |
|---|---|
| **¿Funciona hoy?** | No. Ni hoy ni en 2027. Para tarjetas de crédito, ≈2029 `[P]`. |
| **Costo** | Prohibitivo: constituir sociedad + inscripción CMF + capital/garantías + gobierno corporativo + certificación. |
| **Qué hay que hacer** | Ser una empresa regulada. No es un camino para MyHaus. |
| **Riesgo** | Fecha que ya se corrió una vez y puede correrse de nuevo. |

**Descartar por completo para este proyecto.** Es la vía correcta a nivel de país, y es irrelevante para tu caso de uso a 3 años vista.

---

## 2. Agregadores comerciales chilenos

### Fintoc (fintoc.com)

Es el más serio del mercado chileno (YC, con producto de iniciación de pagos y ahora pasarela de tarjetas). **Pero su negocio no es el tuyo.**

- **Iniciación de pagos:** Banco Falabella está soportado con el identificador `cl_banco_falabella` `[V]`. Esto sirve para *cobrar* por transferencia, **no para leer tus movimientos**.
- **Producto "Movements":** sí existe una API de movimientos, pensada para **conciliación bancaria de empresas** — "importar movimientos de cartola sin usar el importador de Excel" `[V]`. El objeto `Movement` describe "una transacción en una cuenta bancaria, como transferencia, cheque, u otro cargo o abono" `[V]`. **Habla de cuentas bancarias, no de tarjetas de crédito.**
- **¿Cubre Banco Falabella en Movements?** **No lo pude confirmar.** La página `docs.fintoc.com/docs/products-and-institutions-movements` está bloqueada desde este entorno y el buscador sólo me devolvió ejemplos de Santander y BancoEstado `[NV]`. **Esto hay que preguntárselo directo a Fintoc** (hello@fintoc.cl) antes de descartarlo del todo.
- **¿Entrega compras con tarjeta de crédito?** Toda la evidencia apunta a que **no**. Cuando Fintoc habla de "tarjetas de crédito" es porque en enero de 2026 sumó *aceptación* de pagos con tarjeta a su pasarela (con certificación PCI DSS) `[V]` — o sea, cobrar con tarjeta, no leer la cartola de tu CMR. Son dos cosas distintas y es fácil confundirlas leyendo su marketing.
- **Precio:** **no publicado para Movements.** Hay una página de tarifas pero está orientada a medio de pago; para datos hay que pedir cotización `[V]`. **No inventes un número.**
- **¿Aceptan clientes chicos?** El registro de desarrollador pide nombre, RUT y clave, y hay términos para desarrolladores `[V]`. Pero pasar de sandbox a producción requiere firmar un **Contrato de Licencia** con datos adicionales `[V]`, lo que en la práctica significa contrato comercial con una empresa. `[P]` que no te habiliten producción como persona natural para un uso doméstico.

### Floid (floid.io)

Chilena. Ofrece APIs bancarias, conciliaciones, validación de RUT, KYC `[V]`. Todo el posicionamiento es **B2B** (automatización de pagos, validación de identidad, gestión de riesgo, dispersión de pagos) `[V]`. **No encontré**: cobertura específica de Banco Falabella, soporte de tarjeta de crédito, ni precios `[NV]`.

### Belvo y Prometeo

- **Prometeo:** se describe como API financiera única para las Américas (datos financieros, validación de cuentas, pagos, cross-border) `[V]`. **Cobertura de Banco Falabella Chile con movimientos de tarjeta: no encontrada** `[NV]`.
- **Belvo:** **no encontré ninguna fuente** que confirme cobertura de Banco Falabella Chile `[NV]`.
- Ambos son B2B con contrato y pricing por consulta. `[P]`

### Veredicto vía 2

| | |
|---|---|
| **¿Funciona hoy?** | Muy improbable. Ninguno acreditó movimientos de tarjeta de crédito de Falabella. |
| **Costo** | Desconocido y no publicado. Modelo de contrato empresa. |
| **Qué hay que hacer** | Escribirle a Fintoc y preguntar lo concreto (abajo el texto exacto). |
| **Riesgo** | Bajo técnicamente, alto de perder tiempo. |

**Acción concreta, 10 minutos, vale la pena hacerla:** mandar un correo a `hello@fintoc.cl` preguntando literalmente estas tres cosas:
> 1. ¿El producto Movements soporta Banco Falabella (`cl_banco_falabella`) para *holder type* individual?
> 2. Si sí, ¿los movimientos incluyen las compras de la tarjeta de crédito CMR, o sólo la cuenta corriente/vista?
> 3. ¿Habilitan producción para un uso personal/no comercial, y con qué costo mínimo?

Si la respuesta a (2) es "sólo cuenta corriente" —que es lo que espero— se cierra la vía y ganaste una semana.

---

## 3. La cartola / estado de cuenta — la vía que sí sirve

Esta es la opción que recomiendo implementar **primero**, y la evalúo en serio como pediste.

### Qué ofrece Falabella

- **Estado de cuenta CMR:** se puede ver y descargar desde la app y desde la web, **en PDF o exportar a Excel** `[P]`. Contiene todas las compras, cuotas, avances, intereses, cargos de administración, saldos, fecha de facturación y vencimiento `[P]`.
- **Envío automático por correo:** "cada mes tu Estado de Cuenta será enviado a tu correo", con el PDF adjunto `[P]`. **Esto es lo importante: no requiere que el usuario haga nada.** Llega solo al mismo buzón que MyHaus ya lee por IMAP.
- **Cartola de cuenta corriente:** Falabella tiene página dedicada (`bancofalabella.cl/cartola`) y se descarga por app o web `[P]`.
- Acceso: RUT + clave de internet `[V]`.

### Lo que no pude verificar y tienes que comprobar tú en 5 minutos

- **Si el PDF adjunto viene con clave.** Varios bancos chilenos protegen el estado de cuenta con una clave derivada del RUT. **No encontré confirmación ni desmentido para Falabella** `[NV]`. Si viene con clave, no es bloqueante: `pikepdf` o `qpdf` la abren con la contraseña conocida, es una línea de código. Pero cambia el parser.
- **El formato exacto del Excel exportado** (columnas, si es .xls real o HTML disfrazado) `[NV]`.
- **Si el Excel se puede exportar también desde la app iOS o sólo desde la web** `[NV]`. Para un flujo mensual desde el iPhone esto importa.
- **Cuántos meses de historia deja bajar de una vez** `[NV]`.

### Evaluación honesta

**Lo bueno:**
- Cubre el **100%** de las compras. Ninguna otra vía llega a eso.
- Los datos son **canónicos**: montos definitivos, cuotas, comercio normalizado por el banco. No son "provisionales" como los de una notificación.
- **Reutiliza la infraestructura que ya tienes.** MyHaus ya lee IMAP. Es agregar un parser, no una arquitectura nueva.
- **Riesgo legal: cero.** Son tus propios datos, entregados por el banco por el canal oficial.
- **Riesgo de que se rompa: bajo.** Un cambio de layout del PDF te rompe el parser una o dos veces al año, y te enteras porque el import falla, no porque los datos salgan mal en silencio.
- Es lo que hace Kuanto para Falabella `[V]`. Si el competidor comercial con equipo dedicado llegó ahí, es la respuesta correcta.

**Lo malo, y es real:**
- **Latencia de hasta 30 días.** Una compra del día 3 puede no aparecer en MyHaus hasta el día 30. Para una app de control de gastos de un hogar, eso mata la mitad del valor: no te sirve para "¿cuánto llevamos gastado este mes?".
- El estado de cuenta se organiza por **ciclo de facturación**, no por mes calendario. Si MyHaus razona en meses calendario, hay que mapear. Es trabajo real de modelado, no cosmético.
- Las compras en cuotas aparecen como cuota del mes, no como el gasto total del día de compra. **Tienes que decidir la semántica**: ¿el gasto del hogar es la cuota o la compra? Las dos son defendibles y el estado de cuenta te da la cuota.

**El "malo" de la latencia es exactamente lo que resuelve la vía 4.** Por eso van juntas.

### Veredicto vía 3

| | |
|---|---|
| **¿Funciona hoy?** | **Sí.** |
| **Costo** | $0. Un par de días de trabajo para el parser + el modelo de ciclos/cuotas. |
| **Qué hay que hacer** | Confirmar formato y clave del PDF; escribir parser; decidir semántica de cuotas; extender el pipeline IMAP existente. |
| **Riesgo** | Bajo. Se rompe con cambios de layout, falla ruidosamente. |

---

## 4. Atajos de iOS

Aquí es donde está el hallazgo. Voy por partes y marco claramente qué versión trae qué.

### 4.1 El disparador de Wallet / transacción — ESTO SÍ SIRVE

- **iOS 17** introdujo el disparador **"Transacción"** en Automatizaciones Personales de Atajos `[V]`.
- **iOS 26** lo **renombró a "Wallet"** `[V]`. Misma funcionalidad.
- Configuración: **"Cuando toco"** (*When I tap*) → se elige una tarjeta específica de Apple Wallet `[V]`.
- **Puede ejecutarse sin confirmación**: hay que activar **"Ejecutar inmediatamente"** (*Run Immediately*) `[V]`. Sin eso, te pide confirmar cada vez y no sirve.
- **Los datos que entrega son justo los que necesitas.** Desde la variable `Shortcut Input` se pueden elegir los campos: **Transaction, Card, Merchant, Amount, Name** `[V]`.

**Banco Falabella soporta Apple Pay en Chile** — tiene página oficial `bancofalabella.cl/apple-pay` y la tarjeta CMR se puede agregar a Apple Wallet `[V]`.

**Entonces el flujo completo es:**

```
Compra acercando el iPhone/Watch
  → Apple Wallet registra la transacción
  → Atajos: automatización "Wallet / Cuando toco [tarjeta CMR]", Ejecutar inmediatamente
  → Acción "Obtener contenido de URL": POST https://<tu-backend>/api/movimiento
     body: { monto: Amount, comercio: Merchant, tarjeta: Card, fecha: Fecha actual, origen: "applepay" }
  → MyHaus lo guarda como movimiento PROVISIONAL
```

Esto se arma en **media hora**, sin servidor nuevo, sin credenciales bancarias, sin riesgo legal, sin depender de nadie.

### 4.2 Las limitaciones — léelas antes de entusiasmarte

**a) Sólo NFC.** El disparador se dispara con el *tap* físico. Una fuente indica explícitamente que sirve para transacciones de Apple Pay **"NFC only, not from a web browser"** `[P — una sola fuente, no lo pude confirmar en la documentación de Apple porque support.apple.com está bloqueado]`.

Esto es **la limitación que define si la vía vale la pena o no**, y es lo primero que tienes que medir: si el hogar compra mucho online (falabella.com, delivery, suscripciones, marketplaces) con el número de tarjeta en vez de Apple Pay, la cobertura de esta vía puede ser 30% y no 80%. **No lo asumas: mira una cartola real y cuenta qué fracción de las líneas son compras presenciales.** Esa cuenta decide el orden de tu backlog.

**b) Es notoriamente inestable.** En los foros de desarrolladores de Apple hay reportes sostenidos: `[V]`
- Timeouts del disparador que hacen fallar la automatización — y a diferencia de la app Wallet, que recibe la transacción tarde pero la recibe, **el disparador expira y la pierde**.
- Reportes de que "desde iOS 18 el disparador de transacción dejó de funcionar" (no aparece ni la notificación de "ejecutando tu automatización").
- Problemas reportados también en iOS 17 y en iOS 26.

Traducción: **esta vía pierde eventos y no te avisa.** Por eso **nunca** puede ser la fuente de verdad; sólo un feed provisional que después se cuadra contra la cartola.

**c) No pude verificar su estado en iOS 26 específicamente** más allá del renombre `[NV]`. Si el usuario ya está en iOS 26, hay que probarlo con una compra chica y ver.

### 4.3 El disparador de mensaje (SMS)

- **Existe** y sirve: automatización personal **"Mensaje"** (*When I get a message*), con filtro por **remitente** y por **texto contenido**; si pones ambos, deben cumplirse los dos `[V]`. Se puede poner en **Ejecutar inmediatamente** `[V]`. Disponible en iOS 18 `[V]`.
- **El problema no es el disparador: es que no hay SMS que capturar.** Toda la comunicación de Banco Falabella Chile describe las alertas de compra como **notificaciones en tiempo real en la app** ("una vez que actives tus tarjetas, ya estarás recibiendo notificaciones en tiempo real de tus compras") `[P]`. **No encontré ninguna fuente chilena que confirme que Falabella manda SMS por cada compra** `[NV]`. El número 87884 para SMS transaccionales que aparece en las búsquedas es de **Banco Falabella Colombia**, no de Chile — no lo tomes como válido.
- Falabella Chile sí usa SMS para **códigos OTP** (6 dígitos, 3 minutos de validez por SMS) `[V]`, pero eso es autenticación, no aviso de compra.

**Acción de 2 minutos:** revisar el historial de Mensajes del iPhone y buscar si hay algún SMS de compra de Falabella de los últimos meses. Si existe, esta vía es **excelente** (cubre online y presencial, es más estable que el disparador de Wallet, y el texto del SMS trae monto y comercio). Si no existe, se cierra.

### 4.4 Lo demás de Atajos: no sirve

- **Disparador por notificación push: no existe.** Dado por sabido, como pediste.
- **Automatización "al abrir una app"**: se dispara al abrir la app de Falabella, pero no te entrega ningún dato de la compra. Sólo serviría como recordatorio ("abriste el banco, ¿anotaste el gasto?"). Ruido, no solución.
- **Modos de concentración, hora, ubicación, NFC tag, Wi-Fi**: ninguno correlaciona con una compra con tarjeta.
- **Apple Watch:** no aporta nada distinto. Si pagas con el Watch, la transacción llega igual a Wallet del iPhone y dispara la misma automatización `[P]`. No es una vía aparte.

### Veredicto vía 4

| | |
|---|---|
| **¿Funciona hoy?** | **Sí, parcialmente** (Apple Pay NFC). El disparador de SMS funciona pero probablemente no hay SMS que leer. |
| **Costo** | $0. ~30 minutos de setup. |
| **Qué hay que hacer** | Agregar la CMR a Apple Wallet; crear la automatización Wallet/Transacción con "Ejecutar inmediatamente"; endpoint POST en MyHaus; marcar los movimientos como provisionales. |
| **Riesgo** | **Alto de pérdida silenciosa de eventos** (timeouts documentados). Riesgo de que Apple cambie el comportamiento entre versiones. Riesgo legal: cero. |

---

## 5. Otras vías

### 5.1 Scraper open source de la web de Falabella — la vía potente y peligrosa

Existe un proyecto activo: **`open-banking-chile`** (repos `kaihv/open-banking-chile` y `cyaconi/open-banking-chile`). Leí el código directamente. `[V]`

- Cubre 10 instituciones chilenas, **incluyendo Banco Falabella con soporte de tarjeta de crédito** `[V]`.
- Puppeteer / Chrome headless, corre 100% local, credenciales por variables de entorno, sin telemetría `[V]`.
- **Del scraper de Falabella específicamente** (`src/banks/falabella.ts`), extrae `[V]`:
  - **Compras de la CMR: fecha, descripción, monto y número de cuota.**
  - Cupo total, utilizado y disponible.
  - Ciclo de facturación: próxima fecha de facturación, monto facturado, vencimiento, pago mínimo.
  - Movimientos **pendientes y facturados** en pestañas separadas — *esto es clave: los pendientes son las compras recién hechas, o sea latencia de horas, no de un mes*.
  - Cartola de cuenta corriente.
  - Deduplicación y etiquetado por máscara de tarjeta.
- Entra por `bancofalabella.cl`, con **RUT + clave de internet**. La CMR está dentro de un *shadow DOM* (`credit-card-movements`) `[V]`.
- **Limitación explícita en el código:** si el banco pide **clave dinámica (2FA)**, el scraper aborta con el error `"El banco pide clave dinámica (2FA)."` — **no hay forma automática de pasar ese paso** `[V]`.

**Evaluación honesta:**

- **Lo bueno:** es la única vía que da compras con tarjeta **en pocas horas** (movimientos pendientes), con cuotas, gratis, sin depender de terceros. Técnicamente es lo que más se parece a lo que querías.
- **Lo malo, y es grave:**
  1. **Guardar la clave de internet del banco en un servidor.** Eso es, con casi total certeza, **violación del contrato de cuenta con Banco Falabella** (los contratos bancarios chilenos prohíben compartir o almacenar la clave con terceros o sistemas automatizados) `[P — no leí el contrato específico de Falabella]`. Si hay un fraude en la cuenta, el banco tiene un argumento para negar la cobertura. Esto no es un riesgo teórico.
  2. **La 2FA lo mata.** Si Falabella pide clave dinámica en el login desde un dispositivo nuevo — y es lo habitual en la banca chilena `[P]` — el scraper no corre desatendido, punto. Antes de escribir una línea de código, **prueba entrar a bancofalabella.cl desde un navegador nuevo/incógnito y mira si te pide clave dinámica.** Eso decide la vía entera.
  3. **Riesgo de bloqueo de cuenta** por detección de automatización. Recuperar el acceso es sucursal o call center.
  4. **Necesitas un PC o servidor siempre encendido con Chrome.** Una PWA en un iPhone no puede hacer esto. Si MyHaus hoy es sólo IMAP + backend liviano, esto es una pieza de infraestructura nueva.
  5. **Mantención permanente.** El banco rediseña el sitio y se rompe. Peor: puede romperse *parcialmente* y dejar de traer una pestaña sin fallar — errores silenciosos, los peores.

**Mi lectura:** es una vía real, pero es la que tiene el peor perfil riesgo/beneficio del informe. La pondría **tercera y opcional**, y sólo si ya tienes un servidor propio y aceptas conscientemente el problema del contrato.

### 5.2 Kuanto (kuanto.cl) — cómo lo resolvió la competencia

Fintech chilena, fundada por Joaquín Castro y Rodrigo Bilbeny, lanzada el 6–8 de agosto de 2025, +2.000 usuarios en el primer mes `[V]`.

**Cómo obtiene los datos** `[V]`:
- **No se conecta a la cuenta ni guarda claves bancarias.** El usuario configura una regla de **reenvío de correo** hacia una casilla exclusiva de Kuanto.
- Una IA lee esos correos (notificaciones de compra, comprobantes y **cartolas**) y los convierte en transacciones.
- El usuario también puede **subir manualmente** cartolas en PDF o Excel.

**Y acá está el dato que importa:** Kuanto **integra automáticamente** Banco de Chile, Bci y Mach, "instituciones que generan notificaciones instantáneas tras cada compra". Para **Santander y Falabella**, "la plataforma **procesa las cartolas mensuales**" y complementa con lo que llegue por correo `[V]`.

O sea: **Kuanto tampoco tiene captura en tiempo real de Falabella.** Confirma independientemente la conclusión de este informe: el cuello de botella es que Falabella no manda correo por compra, y no hay forma de saltárselo.

(Sobre el precio de Kuanto encontré fuentes contradictorias: una dice gratis sin tarjeta, otra dice suscripción mensual de $6.990 con precio de lanzamiento $4.990 desde octubre `[NV — contradictorio]`. Da igual para tu decisión.)

**Utilidad para ti:** no como producto a usar, sino como **validación de arquitectura**. Y como confirmación de que **el reenvío de correo + parser de cartola es una solución de producto aceptable**, no un parche vergonzoso.

### 5.3 Ley 21.719 de protección de datos — derecho a la portabilidad

Ley publicada el 13 de diciembre de 2024, **entra en vigencia el 1 de diciembre de 2026** `[V]`. Crea la Agencia de Protección de Datos Personales y amplía los derechos del titular, incluyendo **portabilidad**: solicitar copia de los datos personales **en formato electrónico estructurado**, para transmitirlos a otro proveedor cuando sea técnicamente posible `[V]`.

**Evaluación:** legalmente interesante, prácticamente casi inútil para ti. Te da derecho a **pedir** tus datos, no a una API. En la práctica el banco responderá con un archivo (PDF o Excel), probablemente con plazos de días, vía formulario. Eso es lo mismo que la cartola, con más fricción. **No construyas nada sobre esto.** Vale como argumento si alguna vez necesitas presionar a Falabella, nada más.

### 5.4 Cambiar el instrumento de pago — la solución que no es técnica

Kuanto dice que **Banco de Chile, Bci y MACH generan notificaciones instantáneas por correo tras cada compra** `[V]`. MyHaus **ya funciona con Banco de Chile** por IMAP.

Entonces: si el hogar usa una tarjeta de Banco de Chile (o MACH) como medio de pago diario en vez de la CMR, **el problema desaparece hoy, sin escribir una línea de código nueva.**

Es una decisión de comportamiento, no de ingeniería, y probablemente hay razones para usar la CMR (beneficios CMR, cuotas sin interés en Falabella). Pero **es honestamente la vía más rápida y robusta de todo el informe** y sería deshonesto no ponerla sobre la mesa. Vale al menos considerar mover el gasto rutinario (supermercado, bencina, farmacia) a una tarjeta que sí notifique por correo, y dejar la CMR para lo que tiene beneficio.

Sobre Tenpo / MACH / Mercado Pago como intermediarios: **no pude confirmar** que ninguno mande correo por cada compra (Tenpo se describe con notificaciones push, no email) `[NV]`. MACH sí aparece en la lista de Kuanto como institución con notificación instantánea `[V]`, pero no verifiqué que sea por correo y no push. **Antes de mover plata a ningún lado, hay que verificarlo con una compra de prueba de $1.000.**

### 5.5 API oficial de Banco Falabella

**No existe.** Banco Falabella no tiene portal de desarrolladores ni API pública documentada `[P]`. El único uso público de su nombre en un contexto de API es `bancofalabella.cl/fintoc`, que es la página de *iniciación de pagos* (recibir transferencias vía Fintoc), no lectura de datos `[V]`. Cerrado.

---

## 6. Tabla comparativa

| Vía | ¿Funciona hoy? | Cobertura de compras | Latencia | Costo | Esfuerzo | Riesgo |
|---|---|---|---|---|---|---|
| **Cartola / estado de cuenta por correo** | **Sí** | **100%** | hasta 30 días | $0 | 1–2 días | **Bajo** |
| **Atajo Wallet / Apple Pay** | **Sí, parcial** | sólo NFC `[P]` | segundos | $0 | ~30 min | Medio (pierde eventos en silencio) |
| Scraper `open-banking-chile` | Depende de la 2FA | ~100% | horas | $0 + servidor | 2–5 días + mantención eterna | **Alto** (contrato, bloqueo, fragilidad) |
| Cambiar a tarjeta que notifica por correo | **Sí** | 100% de lo que muevas | segundos | $0 técnico | 0 | Bajo (cuesta beneficios CMR) |
| Atajo por SMS | Disparador sí; SMS probablemente no existe | — | — | $0 | 2 min verificarlo | — |
| Fintoc / Floid / Belvo / Prometeo | Muy improbable | — | — | desconocido | 1 correo para cerrarlo | Perder semanas |
| SFA / Ley Fintec | **No** (≈2029, y hay que ser PSBI) | — | — | prohibitivo | — | Fechas que se corren |
| Ley 21.719 portabilidad | Desde dic-2026, pero es un archivo, no una API | — | días | $0 | — | Sin valor práctico |

---

## 7. Recomendación

### Antes de escribir código: tres verificaciones, 20 minutos en total

Estas tres respuestas cambian todo el plan. Hazlas primero.

1. **Abre una cartola real y cuenta qué fracción de las compras son presenciales vs online.** Decide si el atajo de Apple Pay cubre 70% o 25%.
2. **Entra a bancofalabella.cl desde un navegador en incógnito.** ¿Pide clave dinámica en el login? Si sí, el scraper queda descartado y ahorras días.
3. **Busca en Mensajes del iPhone si Falabella manda algún SMS por compra.** Si aparece, cambia el orden de todo: esa vía es mejor que Apple Pay.

Y una cuarta, 5 minutos: **mirar en la app de Falabella si hay configuración de alertas por correo electrónico** además de las push. No encontré evidencia de que exista en Chile `[NV]`, pero si existiera sería la solución completa y perfecta, y nadie lo ha reportado públicamente. Es barato mirar.

### Primero — Parser de cartola sobre el IMAP que ya tienes

Es lo único que cubre el 100% y es donde reutilizas lo construido. Decide desde ya que **la cartola es la fuente de verdad** y todo lo demás es provisional.

Tareas: confirmar si el PDF trae clave; elegir entre parsear PDF o el Excel exportado (si el Excel existe y es estable, prefiérelo — es mucho menos frágil); modelar ciclo de facturación vs mes calendario; decidir la semántica de cuotas; deduplicar contra lo que ya entró por otras vías.

### Segundo — Automatización de Wallet/Apple Pay

Media hora, gratis, sin riesgo. Cierra el hueco de latencia para las compras presenciales.

Construye el endpoint asumiendo que **va a perder eventos**: marca los movimientos con `origen: "applepay"` y `estado: "provisional"`, y que el import mensual de cartola los confirme o los corrija. No muestres el total del mes como si fuera definitivo cuando viene de esta fuente.

### Tercero — Sólo si la verificación (2) dio que no hay 2FA en el login, y tienes servidor propio

Evaluar `kaihv/open-banking-chile`. Corriéndolo una vez al día traes los movimientos pendientes con latencia de horas y resuelves el problema casi completo. **Pero asume conscientemente** que estás guardando la clave del banco y que eso probablemente incumple tu contrato. Si esto te incomoda, no lo hagas: la combinación de (1)+(2) ya es un producto decente.

### Cerrar rápido y seguir

- **Un correo a Fintoc** con las tres preguntas de la sección 2. Costo: 10 minutos. Beneficio: cerrar la vía con certeza en vez de con suposición.

### Descartar sin más análisis

- **SFA / Ley Fintec.** Tarjetas de crédito ≈2029 y requiere ser PSBI inscrito en la CMF. No es un camino para un proyecto personal.
- **Belvo, Prometeo, Floid.** B2B, sin evidencia de cobertura de tarjeta de crédito Falabella.
- **Ley 21.719 portabilidad.** Es un archivo por formulario, no una API.
- **Cualquier idea que pase por leer la notificación push.** Ya lo diste por sabido y es correcto.

### La conclusión que pediste sin rodeos

**No hay vía automática buena.** El plan realista es: **importar la cartola mensual (automatizado por IMAP, no a mano) como base, más un atajo de Apple Pay que cubre parcialmente el tiempo real.** Eso es lo mejor que se puede hacer hoy en Chile con Banco Falabella, y es lo mismo a lo que llegó la fintech chilena que compite en este espacio con un equipo dedicado.

Si lo que realmente quieres es **ver el gasto del hogar en tiempo real todos los días**, la respuesta más honesta de todo este informe no es técnica: **usa como tarjeta diaria una que mande correo por cada compra** (Banco de Chile, que MyHaus ya soporta). Eso lo resuelve hoy, completo, sin código nuevo y sin riesgo. Todo lo demás es trabajar alrededor de una decisión de producto de Falabella que no vas a poder cambiar.

---

## 8. Qué NO pude verificar (lista para ti)

1. Si el PDF del estado de cuenta CMR viene protegido con clave.
2. El formato exacto del Excel exportado por Falabella, y si se exporta desde la app iOS o sólo web.
3. Si Fintoc Movements soporta `cl_banco_falabella` para persona natural, y si incluye tarjeta de crédito.
4. Precios reales de Fintoc, Floid, Belvo, Prometeo para el producto de datos.
5. Cobertura de Belvo / Prometeo / Floid sobre Banco Falabella.
6. Si Banco Falabella Chile manda SMS por compra (el número 87884 que aparece es de Colombia).
7. Si Falabella Chile permite configurar alertas de compra por correo electrónico.
8. Si el disparador Wallet de iOS 26 funciona con Apple Pay online/in-app o realmente sólo NFC (una sola fuente dice sólo NFC).
9. Estado de funcionamiento del disparador Wallet en iOS 26 específicamente.
10. Si el login web de Falabella exige clave dinámica en dispositivo nuevo.
11. El contrato exacto de Banco Falabella respecto a almacenar la clave en sistemas automatizados.
12. La cifra específica de patrimonio/garantía exigida a un PSBI (las cifras en UF que aparecen en búsquedas son de intermediarios de valores, **no** de PSBI).
13. Si Tenpo / Mercado Pago Chile mandan correo por cada compra.
14. La fecha exacta de disponibilidad de datos de tarjeta de crédito en el SFA (18 meses post-vigencia es lo reportado; no leí el calendario oficial porque cmfchile.cl está bloqueado desde este entorno).

---

## 9. Fuentes

**Ley Fintec / SFA / CMF**
- https://www.cmfchile.cl/portal/prensa/625/w4-article-110881.html — CMF modifica normativa SFA e incorpora anexo técnico
- https://www.cmfchile.cl/portal/prensa/615/w3-article-82737.html — CMF publica norma que regula el SFA
- https://www.cmfchile.cl/normativa/ncg_514_2024.pdf — NCG 514
- https://www.cmfchile.cl/portal/principal/613/articles-82743_recurso_2.pdf — SFA Preguntas Frecuentes (CMF)
- https://www.cmfchile.cl/portal/principal/613/w3-article-60920.html — Inscripción en RPSF y solicitud de autorización
- https://www.cuatrecasas.com/es/latam/servicios-financieros-seguros/art/cmf-ncg-569-reglas-tecnicas-sistema-finanzas-abiertas — NCG 569, reglas técnicas
- https://www.carey.cl/cmf-publica-norma-que-regula-el-sistema-de-finanzas-abiertas — Carey, análisis NCG 514
- https://www.carey.cl/propuesta-normativa-de-la-cmf-a-la-ncg-n514-posterga-en-12-meses-la-entrada-en-vigencia-del-sistema-de-finanzas-abiertas-y-otorga-mayor-gradualidad-en-su-implementacion — postergación de 12 meses
- https://www.garrigues.com/es_ES/noticia/chile-publicada-regulacion-sistema-finanzas-abiertas — Garrigues
- https://www.df.cl/mercados/banca-fintech/fintech-pierden-la-pulseada-cmf-aplaza-hasta-2027-la-entrada-en-vigencia — DF, aplazamiento a 2027
- https://chocale.cl/2026/06/finanzas-abiertas-en-chile-que-paso-con-los-plazos-y-que-viene-para-los-clientes/ — Chócale, plazos
- https://blog.fiskil.com/es/guia-open-finance-chile-ley-21521-ncg-514 — guía Ley 21521 / NCG 514
- https://www.fintechile.org/noticias/las-fintech-critican-postergacion-del-sistema-de-finanzas-abiertas-pero-bancos-y-el-retail-financiero-celebran — reacción de la industria

**Ley 21.719 (datos personales)**
- https://www.asentic.cl/blog/ley-21719-datos-personales/
- https://www.thomsonreuters.cl/es-cl/soluciones-juridicas/biblioteca-contenido-legal/ley-21719-y-la-reconstruccion-del-derecho-chileno-de-proteccion-de-datos-personales

**Agregadores**
- https://www.fintoc.com/cl — Fintoc Chile
- https://fintoc.com/pricing — tarifas (medio de pago)
- https://docs.fintoc.com/docs/products-and-institutions-movements — instituciones y producto Movements
- https://docs.fintoc.com/es/api/movements-api/movements/movements-object — objeto Movement
- https://docs.fintoc.com/docs/payment-initiation-countries-and-institutions — `cl_banco_falabella` en iniciación de pagos
- https://intercom.help/fintoc/es/articles/6164074-con-que-bancos-se-puede-usar-fintoc — bancos soportados
- https://en.fintoc.com/legal/terminos-y-condiciones-para-desarrolladores — T&C para desarrolladores
- https://chocale.cl/2026/01/fintoc-suma-pagos-con-tarjetas-a-su-pasarela/ — Fintoc suma pagos con tarjeta (aceptación, no lectura)
- https://www.floid.io/servicios/apis-bancarias-y-conciliaciones — Floid
- https://prometeoapi.com/en — Prometeo
- https://www.openbankingtracker.com/provider/banco-falabella — ausencia de API pública de Falabella

**Banco Falabella**
- https://www.bancofalabella.cl/conoce-tu-estado-de-cuenta-cmr — estado de cuenta CMR
- https://www.bancofalabella.cl/cartola — cartola cuenta corriente
- https://www.bancofalabella.cl/apple-pay — Apple Pay
- https://www.bancofalabella.cl/app-banco-falabella — app y notificaciones
- https://www.bancofalabella.cl/crea-o-recupera-tu-clave-de-internet — acceso RUT + clave
- https://www.bancofalabella.cl/fintoc — Falabella + Fintoc (iniciación de pagos)
- https://www.rankia.cl/blog/mejores-tarjetas-credito-debito/4992204-como-ver-estado-cuenta-cmr-falabella — descarga PDF/Excel y envío por correo
- https://www.rankia.cl/blog/mejores-cuentas-bancarias/5573793-servicio-cliente-falabella — OTP, seguridad
- https://www.rankia.cl/blog/mejores-tarjetas-credito-debito/6591935-como-activar-notificaciones-gasto-tarjeta-credito — notificaciones de gasto

**iOS / Atajos**
- https://support.apple.com/guide/shortcuts/transaction-trigger-apd65c67538a/ios — disparador de transacción
- https://support.apple.com/guide/shortcuts/communication-triggers-apdd711f9dff/ios — disparadores de comunicación (mensaje)
- https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/8.0/ios/18.0 — automatización personal iOS 18
- https://developer.apple.com/forums/thread/765516 — timeouts del disparador de transacción
- https://www.developer.apple.com/forums/thread/758053 — disparador roto en iOS 18
- https://developer.apple.com/forums/thread/773745 — "transactions automations don't seem to work"
- https://walletpalapp.github.io/apple-pay-expense-tracker-shortcuts.html — campos Amount / Merchant / Card, renombre a "Wallet" en iOS 26
- https://grahamhaley.co.uk/2024/11/19/apple-pay-automation/ — automatización Apple Pay, limitación "NFC only"
- https://help.travel-spend.com/shortcuts--automation/ignQHsp85RQDsig2QwVcdX/set-up-apple-pay-automation/7tL8XfjBceg4D7mQeiSK2V — setup con "Run Immediately"

**Scraper open source**
- https://github.com/kaihv/open-banking-chile — repo principal (leído: README, CODEX.md, src/banks/falabella.ts)
- https://github.com/cyaconi/open-banking-chile — repo espejo/fork

**Kuanto**
- https://kuanto.cl/
- https://chocale.cl/2025/08/kuanto-app-chilena-ayuda-al-control-de-gastos-conectandose-a-tu-banco/ — método de reenvío de correo
- https://chocale.cl/2025/10/joaquin-castro-y-rodrigo-bilbeny-cofundadores-kuanto-entrevista-finanzas-personales/ — entrevista fundadores; Falabella vía cartola mensual
- https://www.latamfintech.co/articles/kuanto-la-fintech-chilena-de-control-financiero-supera-2-000-usuarios-en-su-primer-mes-y-planea-expansion-a-latam
- https://startupslatam.com/kuanto-busca-convertirse-en-la-app-de-finanzas-personales-lider-en-chile-y-superar-los-5-000-usuarios/

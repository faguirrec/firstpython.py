# Privacidad

## Qué se envía al servidor (solo si la base comunitaria está activada)
- Código del producto (p. ej. `MLA123456789`), precio y moneda.
- Un código anónimo al azar generado en tu navegador. El servidor guarda únicamente su hash (SHA-256 con sal), nunca el código en sí.
- Al pedir el historial de un producto, el servidor recibe el código del producto consultado y tu IP, como cualquier sitio web. La IP se usa solo para limitar abusos (en memoria; no se guarda).

## Qué NO se envía
Tu cuenta de MercadoLibre, nombre, correo, compras, búsquedas, historial de navegación, qué productos seguís, tus precios objetivo ni tu historial local.

## Tus controles
- **Interruptor** "Base comunitaria" en el popup (y en la página de bienvenida): apagado = la extensión no lee ni envía nada.
- **Desinstalar** la extensión borra todo lo guardado en tu navegador. Los precios ya aportados son anónimos y permanecen en la base común.
- Tu historial local vive en `chrome.storage.local`; se borra al desinstalar la extensión.

## Cómo se protege la base
La hora la pone el servidor; un cliente cuenta una vez por producto cada 6 h; el precio de cada ventana es la **mediana** de los aportes (un valor falso aislado no la mueve); se descartan precios absurdos cuando hay suficientes aportantes; hay límites por IP y por cliente.

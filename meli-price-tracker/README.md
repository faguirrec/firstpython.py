# Meli Price Tracker

Extensión de Chrome (Manifest V3) para ver y seguir el historial de precios de productos de MercadoLibre.

## Qué hace (fase 2)
- **Historial en cada producto:** al abrir cualquier página de producto, la extensión registra el precio solo (sin tocar nada) y muestra un panel flotante con gráfico, mínimo / promedio / máximo y un veredicto (*mínimo histórico*, *buen momento*, *esperá*, …).
- **Seguir y avisarme:** desde el panel (o el popup) marcás los productos que te interesan. Esos se revisan en segundo plano cada 60 min y te llega una notificación cuando bajan (≥1 %) o llegan a tu **precio objetivo**.
- **Popup:** pestañas **Siguiendo** y **Vistos** (todo lo que fuiste visitando, con su historial).
- Funciona en MercadoLibre AR, MX, CL, CO, UY, PE, VE, EC y Brasil.
- Todo se guarda localmente en tu navegador (`chrome.storage.local`). No se envía nada a ningún servidor.

## Instalar (modo desarrollador)
1. Abrí `chrome://extensions` y activá **Modo desarrollador**.
2. **Cargar descomprimida** → elegí esta carpeta `meli-price-tracker/`.
3. Entrá a un producto en MercadoLibre: aparece el botón 📉 abajo a la derecha.

## Límites y notas
- Historial: hasta 1000 puntos por producto (un punto cada vez que cambia el precio, o cada 6 h si no cambia). De los productos *solo vistos* se conservan los 1500 más recientes; los seguidos nunca se descartan.
- Los productos *solo vistos* se actualizan únicamente cuando los visitás; los seguidos, además, cada hora (con Chrome abierto).
- El veredicto necesita al menos 3 registros y 3 días de datos antes de opinar.
- El precio se lee del JSON-LD / meta tags de la página. Si MercadoLibre cambia ese formato, hay que ajustar `lib/extract.js`.

## Hoja de ruta
1. ✅ Seguimiento local de productos elegidos, con alertas.
2. ✅ Panel de historial en cualquier producto + registro pasivo de lo que visitás.
3. ⏳ Backend con base de precios compartida (aporte anónimo opcional de los usuarios + rastreo de productos populares), para ver historial desde la primera visita.
4. ⏳ Detección de descuentos falsos y recomendación "comprar ya / esperar" con datos reales.

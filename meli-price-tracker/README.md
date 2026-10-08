# Meli Price Tracker

Extensión de Chrome (Manifest V3) para seguir el precio de productos de MercadoLibre en el tiempo.

## Qué hace
- Botón flotante **“Seguir precio”** en cada página de producto.
- Revisa los precios cada 60 min en segundo plano y guarda el historial (`chrome.storage.local`, todo queda en tu navegador).
- Notificación cuando el precio baja (≥1 %) o llega a tu **precio objetivo**.
- Popup con gráfico de historial, mín/máx y un veredicto: *mínimo histórico*, *buen momento*, *esperá*, etc.
- Funciona en MercadoLibre AR, MX, CL, CO, UY, PE, VE, EC y Brasil.

## Instalar (modo desarrollador)
1. Abrí `chrome://extensions` y activá **Modo desarrollador**.
2. **Cargar descomprimida** → elegí esta carpeta `meli-price-tracker/`.
3. Entrá a un producto en MercadoLibre y tocá **Seguir precio**.

## Notas
- El precio se lee del JSON-LD / meta tags de la página (más estable que las clases CSS). Si MercadoLibre cambia ese formato, hay que ajustar `lib/extract.js`.
- El veredicto necesita al menos 3 registros y 3 días de datos antes de opinar.
- Chrome debe estar abierto para que corra la revisión periódica.

# Meli Price Tracker

Extensión de Chrome (Manifest V3) para ver y seguir el historial de precios de productos de MercadoLibre.

## Qué hace
- **Historial en cada producto:** al abrir cualquier página de producto, la extensión registra el precio solo (sin tocar nada) y muestra un panel flotante con gráfico, mínimo / promedio / máximo y un veredicto (*mínimo histórico*, *buen momento*, *esperá*, …).
- **Seguir y avisarme:** desde el panel (o el popup) marcás los productos que te interesan. Esos se revisan en segundo plano cada 60 min y te llega una notificación cuando bajan (≥1 %) o llegan a tu **precio objetivo**.
- **Popup:** pestañas **Siguiendo** y **Vistos** (todo lo que fuiste visitando, con su historial).
- Funciona en MercadoLibre AR, MX, CL, CO, UY, PE, VE, EC y Brasil.
- **Base comunitaria (fase 3):** el historial se arma entre todos. Cada extensión aporta, de forma anónima, `{producto, precio, moneda}` de lo que visita, y al abrir un producto trae el historial combinado, incluso si nunca lo habías visto. Se puede apagar desde el popup. Detalle en [PRIVACY.md](PRIVACY.md).
- Tu historial local, tus productos seguidos y tus precios objetivo se guardan solo en tu navegador (`chrome.storage.local`).

## Instalar (modo desarrollador)
1. Abrí `chrome://extensions` y activá **Modo desarrollador**.
2. **Cargar descomprimida** → elegí esta carpeta `meli-price-tracker/`.
3. Entrá a un producto en MercadoLibre: aparece el botón 📉 abajo a la derecha.

## Servidor (`server/`)
API Node + Express + SQLite (`better-sqlite3`). Endpoints: `POST /v1/observations`, `GET /v1/items/:id/history`, `GET /health`.

```bash
cd server && npm install && npm test        # 8 pruebas
CLIENT_SALT=algo-secreto npm start          # local, :8080
```
Despliegue en Fly.io: los pasos están en `server/fly.toml`. Si usás otro nombre de app, cambiá `SERVER_URL` en `lib/config.js` y el host en `manifest.json`.

## Límites y notas
- Historial: hasta 1000 puntos por producto (un punto cada vez que cambia el precio, o cada 6 h si no cambia). De los productos *solo vistos* se conservan los 1500 más recientes; los seguidos nunca se descartan.
- Los productos *solo vistos* se actualizan únicamente cuando los visitás; los seguidos, además, cada hora (con Chrome abierto).
- El veredicto necesita al menos 3 registros y 3 días de datos antes de opinar.
- El precio se lee del JSON-LD / meta tags de la página. Si MercadoLibre cambia ese formato, hay que ajustar `lib/extract.js`.

## Hoja de ruta
1. ✅ Seguimiento local de productos elegidos, con alertas.
2. ✅ Panel de historial en cualquier producto + registro pasivo de lo que visitás.
3. ✅ Base de precios compartida (aporte anónimo de los usuarios + API), para ver historial desde la primera visita. *Pendiente:* desplegar el servidor y, más adelante, rastrear productos populares con la API oficial de MercadoLibre.
4. ⏳ Detección de descuentos falsos y recomendación "comprar ya / esperar" con datos reales.

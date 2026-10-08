# Meli Price Tracker

Extensión de Chrome (Manifest V3) para ver y seguir el historial de precios de productos de MercadoLibre.

## Qué hace
- **Historial en cada producto:** al abrir cualquier página de producto, la extensión registra el precio solo (sin tocar nada) y muestra un panel flotante con un veredicto (*mínimo histórico*, *mínimo de 90 días*, *buen momento*, *esperá*, …).
- **Gráfico interactivo:** rangos 7d / 30d / 90d / 1 año / todo, y al pasar el mouse ves la fecha y el precio exactos. Debajo, estadísticas por ventana (mínimo de 30 días, 90 días y 6 meses —solo las que el historial realmente cubre—, mínimo y máximo históricos con su fecha, % vs el máximo y sobre el mínimo).
- **Detector de descuentos inflados:** lee el precio tachado ("antes") de la publicación y lo compara con lo que el producto realmente costó en los últimos 60 días (historial local + comunitario). Resultado: *✅ Descuento real*, *🟡 Menos de lo que dice*, *⚠️ Descuento inflado* o *ℹ️ sin verificar* (si hay menos de 14 días de historial). Es una heurística; los umbrales están en `DISC` dentro de `lib/shared.js`.
- **Vendedor:** muestra "Vendido por …", MercadoLíder y tienda oficial cuando la página los expone.
- **Exportar CSV** del historial de cualquier producto (panel y popup).
- **Seguir y avisarme:** desde el panel (o el popup) marcás los productos que te interesan. Esos se revisan en segundo plano cada 60 min. Alertas configurables por producto: **precio objetivo**, **% mínimo de baja** (cualquier baja, 5 %, 10 %, 20 % o ninguna) y **“llegó al mínimo de 90 días”**.
- **Popup:** pestañas **Siguiendo** y **Vistos** (todo lo que fuiste visitando, con su historial).
- Funciona en MercadoLibre AR, MX, CL, CO, UY, PE, VE, EC y Brasil.
- **Base comunitaria (fase 3):** el historial se arma entre todos. Cada extensión aporta, de forma anónima, `{producto, precio, moneda}` de lo que visita, y al abrir un producto trae el historial combinado, incluso si nunca lo habías visto. Se puede apagar desde el popup. Detalle en [PRIVACY.md](PRIVACY.md).
- Tu historial local, tus productos seguidos y tus precios objetivo se guardan solo en tu navegador (`chrome.storage.local`).

## Instalar (modo desarrollador)
1. Abrí `chrome://extensions` y activá **Modo desarrollador**.
2. **Cargar descomprimida** → elegí esta carpeta `meli-price-tracker/`.
3. Entrá a un producto en MercadoLibre: aparece el botón 📉 abajo a la derecha.

## Pruebas
```bash
node --test test/*.test.js        # extensión: estadísticas, veredicto, CSV, alertas, extractor, descuentos (21 pruebas)
cd server && npm test             # API (8 pruebas)
```

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
- El veredicto necesita al menos 3 registros y 3 días de datos antes de opinar. Las ventanas de 90 días / 6 meses solo se muestran cuando el historial las cubre.
- Las alertas de “mínimo de 90 días” se evalúan con el historial local del producto (necesita ≥3 registros y ≥7 días).
- **El precio tachado y el vendedor se leen de clases/textos de MercadoLibre** (`andes-money-amount--previous`, "Vendido por …") que no pude verificar contra páginas reales: los fixtures de `test/fixtures/` reproducen el formato *supuesto*. Si no se leen, el panel simplemente omite esas secciones. Para ajustar el extractor, reemplazá los fixtures por HTML real y corré las pruebas.
- El "antes" solo vale mientras la página lo muestra: se descarta si tiene más de 3 días.
- El precio se lee del JSON-LD / meta tags de la página. Si MercadoLibre cambia ese formato, hay que ajustar `lib/extract.js`.

## Hoja de ruta
1. ✅ Seguimiento local de productos elegidos, con alertas.
2. ✅ Panel de historial en cualquier producto + registro pasivo de lo que visitás.
3. ✅ Base de precios compartida (aporte anónimo de los usuarios + API), para ver historial desde la primera visita. *Pendiente:* desplegar el servidor y, más adelante, rastrear productos populares con la API oficial de MercadoLibre.
4. ✅ Detección de descuentos inflados (precio tachado vs historial real) y vendedor. *Pendiente:* validar los selectores con páginas reales de MercadoLibre, y la recomendación “comprar ya / esperar” que combine todas las señales.
4. ⏳ Detección de descuentos falsos y recomendación "comprar ya / esperar" con datos reales.

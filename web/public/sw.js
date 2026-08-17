/**
 * Service worker: deja la app instalable y abrible sin conexión.
 * Los datos financieros NUNCA se cachean — sólo los archivos estáticos.
 *
 * BUILD lo reemplaza scripts/sellar-build.mjs con un identificador distinto en
 * cada compilación. Es lo que hace que el navegador note que hay una versión
 * nueva: si este archivo no cambia, nunca reinstala el service worker ni borra
 * la copia guardada, y la app se queda mostrando el shell antiguo para siempre.
 */
const BUILD = '__BUILD__';
const CACHE = `hogar-${BUILD}`;
const SHELL = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Al cambiar BUILD, las cachés de compilaciones anteriores se eliminan.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // La API siempre va a la red: nada de saldos desactualizados.
  if (url.pathname.startsWith('/api/')) return;

  // Navegación: se pide siempre a la red, y saltándose la caché HTTP del
  // navegador, porque el index.html es el que apunta a los archivos nuevos.
  // Sin conexión, se sirve la copia guardada.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'reload' })
        .then((respuesta) => {
          if (respuesta.ok) {
            const copia = respuesta.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copia));
          }
          return respuesta;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // El resto son archivos con el contenido en el nombre (index-a1b2c3.js), así
  // que servir la copia guardada es seguro: si cambian, cambia el nombre.
  event.respondWith(
    caches.match(event.request).then(
      (guardado) =>
        guardado ??
        fetch(event.request).then((respuesta) => {
          if (respuesta.ok) {
            const copia = respuesta.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copia));
          }
          return respuesta;
        }),
    ),
  );
});

// Permite que la app pida saltar la espera cuando encuentra una versión nueva.
self.addEventListener('message', (event) => {
  if (event.data === 'actualizar-ahora') self.skipWaiting();
});

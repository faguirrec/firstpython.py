import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './lib/session';
import { aplicarTema, leerTema } from './lib/tema';
import './styles.css';

/*
 * El tema elegido se estampa antes de montar nada.
 *
 * En un efecto de React la primera pintura saldría con el tema del sistema y se
 * vería el cambio de golpe: una app que parpadea de oscuro a claro al abrir se
 * siente rota aunque no lo esté.
 */
aplicarTema(leerTema());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((registro) => {
      // Al encontrar una versión nueva se recarga sola una vez, para que nadie
      // se quede mirando una pantalla vieja sin saberlo.
      registro.addEventListener('updatefound', () => {
        const entrante = registro.installing;
        if (!entrante) return;
        entrante.addEventListener('statechange', () => {
          if (entrante.state === 'installed' && navigator.serviceWorker.controller) {
            entrante.postMessage('actualizar-ahora');
          }
        });
      });

      // Al volver a la app tras un rato, se comprueba si hay algo nuevo.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registro.update();
      });
    });

    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recargando) return;
      recargando = true;
      window.location.reload();
    });
  });
}

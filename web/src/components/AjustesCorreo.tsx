import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import AjustesCorreoImap from './AjustesCorreoImap';
import AjustesGmail from './AjustesGmail';

/**
 * Las dos formas de leer el buzón, en una sola pantalla.
 *
 * IMAP va primero porque es la recomendada: la credencial no caduca y la app
 * queda escuchando. El permiso de Google sigue disponible —quien ya lo tenía
 * andando no debería verse obligado a cambiar—, pero replegado, para no
 * ofrecer dos caminos con el mismo peso cuando uno es claramente mejor.
 */
export default function AjustesCorreo() {
  const [params] = useSearchParams();
  const [tieneGoogle, setTieneGoogle] = useState(false);

  useEffect(() => {
    void api
      .gmailStatus()
      .then((s) => setTieneGoogle(s.accounts.length > 0))
      .catch(() => undefined);
  }, []);

  // Si vuelve de autorizar en Google, o si ya usa esa vía, se abre sola.
  const abierta = Boolean(params.get('conectado')) || tieneGoogle;

  return (
    <>
      <AjustesCorreoImap />

      <details className="card plegable" open={abierta}>
        <summary>
          <strong>Conectar con el permiso de Google</strong>
          <span className="muted">
            La otra forma. Funciona, pero mientras la app no esté verificada por Google el permiso caduca cada 7
            días y hay que volver a conectarla.
          </span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <AjustesGmail />
        </div>
      </details>
    </>
  );
}

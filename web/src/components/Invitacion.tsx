import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../lib/api';

/** QR dibujado como SVG a partir de la matriz de módulos: sin canvas ni imágenes. */
function QR({ text, size = 190 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { d: parts.join(''), count };
  }, [text]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`-1 -1 ${path.count + 2} ${path.count + 2}`}
      role="img"
      aria-label="Código QR con el link de invitación"
      style={{ background: '#fff', borderRadius: 10, padding: 4 }}
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#0b0b0b" />
    </svg>
  );
}

/**
 * Panel para sumar a la segunda persona. Tres caminos según dónde esté:
 * QR si está al lado, compartir por WhatsApp si no, y el código a mano como
 * último recurso.
 */
export default function Invitacion({ code, onChanged }: { code: string; onChanged: () => void }) {
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [showQr, setShowQr] = useState(true);
  const [busy, setBusy] = useState(false);

  const link = `${window.location.origin}/unirse/${code}`;
  const message = `Te invito a administrar nuestras cuentas del hogar. Entra acá y crea tu cuenta: ${link}`;

  async function copy(text: string, what: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Safari sin permiso de portapapeles: al menos queda seleccionable.
      window.prompt('Copia este texto:', text);
      return;
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Cuentas del Hogar', text: message, url: link });
        return;
      } catch {
        // El usuario canceló la hoja de compartir: no es un error.
        return;
      }
    }
    await copy(message, 'link');
  }

  return (
    <div>
      <div className="label">Invita a la otra persona</div>
      <p className="muted" style={{ marginTop: 4 }}>
        Con esto crea su cuenta y queda viendo exactamente los mismos datos que tú.
      </p>

      {showQr && (
        <div style={{ display: 'grid', placeItems: 'center', margin: '12px 0' }}>
          <QR text={link} />
          <span className="muted" style={{ marginTop: 6 }}>
            Que lo escanee con la cámara del teléfono
          </span>
        </div>
      )}

      <div className="wrap" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => void share()}>
          Compartir link
        </button>
        <button onClick={() => void copy(link, 'link')}>{copied === 'link' ? '✓ Copiado' : 'Copiar link'}</button>
        <button className="ghost" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Ocultar QR' : 'Mostrar QR'}
        </button>
      </div>

      <div className="card" style={{ background: 'var(--plane)', boxShadow: 'none', marginBottom: 10 }}>
        <div className="label">O que escriba este código a mano</div>
        <div className="row">
          <strong className="num" style={{ fontSize: '1.6rem', letterSpacing: '0.15em' }}>{code}</strong>
          <button className="small" onClick={() => void copy(code, 'code')}>
            {copied === 'code' ? '✓' : 'Copiar'}
          </button>
        </div>
      </div>

      <button
        className="ghost small danger"
        disabled={busy}
        onClick={async () => {
          if (!confirm('Se anula el código actual y se genera uno nuevo. ¿Continuar?')) return;
          setBusy(true);
          try {
            await api.rotateInvite();
            onChanged();
          } finally {
            setBusy(false);
          }
        }}
      >
        Anular y generar otro código
      </button>
    </div>
  );
}

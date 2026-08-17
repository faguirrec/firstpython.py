#!/usr/bin/env bash
# Deja el Codespace listo para usar: dependencias instaladas, app compilada y
# flyctl disponible para publicar. Se ejecuta solo al crear el entorno.
set -euo pipefail

echo "Instalando dependencias del frontend..."
npm ci --prefix web --no-audit --no-fund

echo "Instalando dependencias del backend..."
npm ci --prefix server --no-audit --no-fund

echo "Compilando..."
npm run build --prefix web
npm run build --prefix server

if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  # Clave propia de este entorno: la del ejemplo no sirve para nada real.
  CLAVE=$(openssl rand -hex 32)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$CLAVE|" server/.env
  sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=http://localhost:4000|" server/.env
  echo "server/.env creado."
fi

echo "Instalando flyctl..."
curl -sSL https://fly.io/install.sh | FLYCTL_INSTALL=/home/node/.fly sh > /dev/null

cat <<'FIN'

====================================================================
 Entorno listo.

 PROBAR la app acá mismo:
     cd server && npm start
   y abre el puerto 4000 desde la pestaña "Ports".

 PUBLICARLA en internet, un solo comando:
     ./deploy.sh
   Te va a pedir iniciar sesión en Fly.io: muestra un enlace que
   abres en tu navegador. No hace falta ningún token.
====================================================================

FIN

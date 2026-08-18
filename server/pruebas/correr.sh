#!/bin/sh
# Corre las verificaciones de la lectura de correo.
#
#   npm run pruebas
#
# Levanta un servidor IMAP de mentira con correos de banco chilenos, corre cada
# prueba contra una base nueva, y lo apaga al terminar. El servidor se reinicia
# entre pruebas a propósito: una prueba deja correos en el buzón y la siguiente
# tiene que partir de un buzón conocido.
set -e
cd "$(dirname "$0")"

# El servidor de mentira habla TLS igual que Gmail, así que necesita un
# certificado. Se genera una vez y se confía en él sólo dentro de estas pruebas.
if [ ! -f tls/cert.pem ]; then
  mkdir -p tls
  openssl req -x509 -newkey rsa:2048 -nodes -keyout tls/llave.pem -out tls/cert.pem \
    -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
  echo "Certificado de prueba generado."
fi

export NODE_EXTRA_CA_CERTS="$PWD/tls/cert.pem"
export JWT_SECRET=secreto-solo-para-pruebas

pid=""
levantar_buzon() {
  apagar_buzon
  node servidor-imap.cjs > imap.log 2>&1 &
  pid=$!
  # Un momento para que abra el puerto.
  sleep 2
}
apagar_buzon() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  pid=""
}
trap apagar_buzon EXIT

fallas=0
correr() {
  echo ""
  echo "── $1 ──"
  rm -f prueba.db ap.db vig.db
  if ! DB_PATH=prueba.db npx tsx "$1"; then fallas=$((fallas + 1)); fi
}

# Éstas no tocan la red.
correr t-cripto.ts
correr t-consulta.ts
correr t-reglas-reales.ts

# Éstas sí: cada una con el buzón recién levantado.
levantar_buzon && correr t-imap.ts
levantar_buzon && correr t-aporte.ts
levantar_buzon && correr t-vigilante.ts

echo ""
if [ "$fallas" -eq 0 ]; then
  echo "Todas las pruebas pasaron."
else
  echo "$fallas archivo(s) con fallas."
  exit 1
fi

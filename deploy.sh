#!/usr/bin/env bash
#
# Publica Cuentas del Hogar en Fly.io desde Linux o macOS (por ejemplo, desde un
# Codespace). Equivalente de deploy.ps1.
#
# Hace todo lo automatizable: crea la app y el disco, genera los secretos,
# publica y deja una sola máquina. Se puede volver a ejecutar sin romper nada:
# los pasos ya hechos los detecta y los salta.
#
#   ./deploy.sh                      elige un nombre disponible
#   ./deploy.sh mi-nombre-de-app     usa ese nombre
#
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASO=0
REGION="${REGION:-scl}"

paso()  { PASO=$((PASO + 1)); printf '\n\033[36m[%d] %s\033[0m\n' "$PASO" "$1"; }
fallo() {
  printf '\n\033[31mFALLO en el paso %d - %s\033[0m\n' "$PASO" "$1"
  printf '\033[33mLos pasos ya hechos quedan hechos: puedes volver a ejecutar ./deploy.sh\033[0m\n'
  exit 1
}

FLY="${FLY:-fly}"

printf '\033[32mPublicar Cuentas del Hogar\033[0m\n'

# ---------------------------------------------------------------------------
paso "Comprobando flyctl"
if ! command -v "$FLY" > /dev/null 2>&1; then
  fallo "flyctl no está instalado. Instálalo con: curl -L https://fly.io/install.sh | sh"
fi
echo "    $("$FLY" version 2>/dev/null | head -1)"

# ---------------------------------------------------------------------------
paso "Revisando la sesión de Fly.io"
if QUIEN=$("$FLY" auth whoami 2>/dev/null); then
  echo "    Conectado como $QUIEN"
else
  echo "    Hay que iniciar sesión. Se mostrará un enlace para abrir en tu navegador."
  "$FLY" auth login || fallo "no se pudo iniciar sesión"
  QUIEN=$("$FLY" auth whoami 2>/dev/null) || fallo "la sesión no quedó activa"
  echo "    Conectado como $QUIEN"
fi

# ---------------------------------------------------------------------------
paso "Definiendo el nombre de la app"
APP="${1:-}"
if [ -z "$APP" ]; then
  # El nombre es la dirección pública: conviene que no sea adivinable.
  APP="cuentas-hogar-$(head -c 2 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if ! printf '%s' "$APP" | grep -qE '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'; then
  fallo "el nombre '$APP' no sirve: sólo minúsculas, números y guiones, entre 3 y 30 caracteres"
fi
echo "    $APP  ->  https://$APP.fly.dev"

paso "Escribiendo el nombre en fly.toml"
sed -i.bak "s|^app = .*|app = \"$APP\"|" "$RAIZ/fly.toml" && rm -f "$RAIZ/fly.toml.bak"
sed -i.bak "s|^primary_region = .*|primary_region = \"$REGION\"|" "$RAIZ/fly.toml" && rm -f "$RAIZ/fly.toml.bak"
echo "    Listo"

# ---------------------------------------------------------------------------
paso "Creando la app"
if "$FLY" status --app "$APP" > /dev/null 2>&1; then
  echo "    Ya existía, se reutiliza"
else
  SALIDA=$("$FLY" apps create "$APP" 2>&1) || {
    if printf '%s' "$SALIDA" | grep -qiE 'taken|already'; then
      fallo "el nombre '$APP' ya lo tomó otra persona. Ejecuta: ./deploy.sh otro-nombre-distinto"
    fi
    printf '%s\n' "$SALIDA"
    fallo "no se pudo crear la app"
  }
  echo "    Creada"
fi

# ---------------------------------------------------------------------------
paso "Creando el disco de datos"
# Sin volumen, cada despliegue borraría todos los movimientos.
if "$FLY" volumes list --app "$APP" 2>/dev/null | grep -q datos; then
  echo "    Ya existía, se conserva con sus datos"
else
  "$FLY" volumes create datos --size 1 --region "$REGION" --app "$APP" --yes \
    || fallo "no se pudo crear el volumen"
  echo "    Creado (1 GB en $REGION)"
fi

# ---------------------------------------------------------------------------
paso "Configurando los secretos"
if "$FLY" secrets list --app "$APP" 2>/dev/null | grep -q JWT_SECRET; then
  echo "    JWT_SECRET ya estaba, no se toca (cambiarlo cerraría las sesiones)"
else
  CLAVE=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  "$FLY" secrets set "JWT_SECRET=$CLAVE" --app "$APP" --stage || fallo "no se pudo guardar JWT_SECRET"
  echo "    JWT_SECRET generado y guardado"
fi
"$FLY" secrets set "WEB_ORIGIN=https://$APP.fly.dev" --app "$APP" --stage \
  || fallo "no se pudo guardar WEB_ORIGIN"
echo "    WEB_ORIGIN configurado"

# ---------------------------------------------------------------------------
paso "Publicando (la primera vez demora algunos minutos)"
"$FLY" deploy --remote-only --app "$APP" \
  || fallo "no se pudo desplegar. Revisa el detalle con: fly logs --app $APP"

# ---------------------------------------------------------------------------
paso "Dejando una sola máquina"
# Con SQLite, dos máquinas serían dos copias distintas de los datos.
"$FLY" scale count 1 --app "$APP" --yes || fallo "no se pudo ajustar la cantidad de máquinas"

# ---------------------------------------------------------------------------
paso "Comprobando que responde"
URL="https://$APP.fly.dev"
OK=0
for intento in $(seq 1 12); do
  sleep 5
  if curl -sf "$URL/api/health" > /dev/null 2>&1; then OK=1; break; fi
  echo "    Intento $intento..."
done
[ "$OK" = "1" ] || fallo "quedó publicada pero no respondió. Revisa: fly logs --app $APP"

cat <<FIN

$(printf '\033[32m')======================================================
 Tu app está online:

   $URL

 Qué sigue, en orden:
   1. Abre esa dirección y crea tu cuenta (la primera no
      necesita código), y después el hogar.
   2. En Ajustes -> Hogar comparte el QR con la otra persona.
   3. Cuando ambos estén adentro, cierra el registro:
      fly secrets set ALLOW_SIGNUP=closed --app $APP
   4. En el iPhone: abre la dirección en Safari, Compartir,
      Agregar a pantalla de inicio.

 Para actualizar más adelante:  git pull && fly deploy --remote-only
======================================================$(printf '\033[0m')

FIN

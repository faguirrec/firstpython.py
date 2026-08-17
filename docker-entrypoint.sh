#!/bin/sh
# Arranque del contenedor.
#
# Los discos persistentes se montan como root según el proveedor (Render lo
# hace así), y el proceso corre como usuario `node`. Sin ajustar el dueño de la
# carpeta de datos, SQLite no puede escribir y la app muere al primer arranque.
#
# Por eso se entra como root sólo para corregir permisos, y de inmediato se baja
# de privilegios para correr la app.
set -e

DIRECTORIO_DATOS="$(dirname "${DB_PATH:-/data/hogar.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIRECTORIO_DATOS"
  chown -R node:node "$DIRECTORIO_DATOS"
  # `su` reinicia el PATH, así que el binario se resuelve antes de cambiar de
  # usuario: si no, puede tomar otro Node o directamente no encontrarlo.
  NODE_BIN="$(command -v node)"
  # exec dentro del su para que las señales lleguen al proceso de Node.
  exec su -s /bin/sh node -c "exec '$NODE_BIN' dist/index.js"
fi

# Si ya venimos sin privilegios, la carpeta tiene que estar disponible igual.
mkdir -p "$DIRECTORIO_DATOS" 2>/dev/null || true
exec node dist/index.js

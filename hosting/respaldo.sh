#!/bin/sh
# Respaldo de la base de MyHaus.
#
#   ./respaldo.sh [carpeta-destino]
#
# Copia en caliente: usa la API de respaldo de SQLite, así que no hay que apagar
# la app ni existe el riesgo de copiar el archivo a medio escribir. Pensado para
# correr desde cron en el servidor:
#
#   0 4 * * *  /ruta/al/repo/hosting/respaldo.sh /home/usuario/respaldos
set -e

DESTINO="${1:-$HOME/respaldos-myhaus}"
COPIAS_A_GUARDAR=14

cd "$(dirname "$0")"
mkdir -p "$DESTINO"

NOMBRE="hogar-$(date +%Y-%m-%d-%H%M).db"

# La conexión de sólo lectura basta para respaldar, y así no hay ninguna
# posibilidad de que este script toque los datos.
docker compose exec -T app node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH, { readonly: true });
  db.backup('/tmp/$NOMBRE').then(
    (r) => { console.log('Páginas copiadas: ' + r.totalPages); process.exit(0); },
    (e) => { console.error(e.message); process.exit(1); },
  );
"

docker compose cp "app:/tmp/$NOMBRE" "$DESTINO/$NOMBRE"
docker compose exec -T app rm -f "/tmp/$NOMBRE"

# Se guardan las últimas y se borran las viejas, para que la carpeta no crezca
# sin fin en un servidor chico.
ls -1t "$DESTINO"/hogar-*.db 2>/dev/null | tail -n "+$((COPIAS_A_GUARDAR + 1))" | while read -r vieja; do
  rm -f "$vieja"
done

echo "Respaldo listo: $DESTINO/$NOMBRE"

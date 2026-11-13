#!/bin/sh
# Arranque del contenedor: migraciones idempotentes -> bootstrap -> app.
# Nunca usa "prisma db push" (regla de protección de datos Publimatec).
set -e

echo "[entrypoint] Aplicando migraciones SQL idempotentes..."
tries=0
until ./node_modules/.bin/tsx scripts/migrate.ts; do
  tries=$((tries + 1))
  if [ "$tries" -ge 10 ]; then
    echo "[entrypoint] La base de datos no respondió tras $tries intentos. Abortando."
    exit 1
  fi
  echo "[entrypoint] Reintentando en 3s ($tries/10)..."
  sleep 3
done

echo "[entrypoint] Inicializando datos base (Entidad Base, ajustes, admin)..."
./node_modules/.bin/tsx prisma/bootstrap.ts

echo "[entrypoint] Iniciando: $*"
exec "$@"

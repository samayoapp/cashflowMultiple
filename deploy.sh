#!/usr/bin/env bash
# deploy.sh — Despliega la rama master de Cashflow Publimatec en el servidor de la oficina.
#
# Uso (desde tu computadora, lo ejecuta Allan manualmente):
#   ./deploy.sh
#
# Hace:
#   1. Verifica que tu repo local esté en master, sin cambios pendientes
#      y sincronizado con origin/master (lo que no esté en GitHub no se despliega).
#   2. Entra por SSH al servidor y ejecuta en orden:
#        a) Respaldo preventivo con pg_dump (aborta si falla)
#        b) git pull --ff-only de origin/master
#        c) docker compose up -d --build  (el contenedor aplica migraciones SQL idempotentes)
#        d) Verificación de /api/health
#
# Variables configurables (o en el entorno):
#   SSH_HOST    alias o usuario@host del servidor
#   REMOTE_DIR  ruta del repo clonado en el servidor
#   BRANCH      rama a desplegar (master)

set -euo pipefail

# ---- Configuración (ajustar) ------------------------------------------------
# Por defecto: pixeldrive en la red de la oficina. Fuera de la oficina usa la IP de Tailscale:
#   SSH_HOST=asamayoa@100.x.x.x ./deploy.sh
SSH_HOST="${SSH_HOST:-asamayoa@192.168.100.90}"
REMOTE_DIR="${REMOTE_DIR:-/opt/cashflow-publimatec}"
BRANCH="${BRANCH:-master}"
# -----------------------------------------------------------------------------

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Comprobaciones locales
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Este directorio no es un repositorio Git."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] || fail "Estás en '$CURRENT_BRANCH', no en '$BRANCH'."

if [[ -n "$(git status --porcelain)" ]]; then
  fail "Hay cambios sin confirmar (commit) en el repositorio local."
fi

info "Consultando GitHub (origin/$BRANCH)..."
git fetch origin "$BRANCH" --quiet

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  fail "Tu '$BRANCH' local no coincide con origin/$BRANCH. Haz 'git push' (o 'git pull') antes de desplegar."
fi

# 2. Despliegue remoto
info "Desplegando commit ${LOCAL_SHA:0:7} en $SSH_HOST:$REMOTE_DIR ..."
ssh -t "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$BRANCH" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
BRANCH="$2"
DB_CONTAINER="cashflow_db"

cd "$REMOTE_DIR"

[[ -f .env ]] || { echo "Error: falta $REMOTE_DIR/.env (copia .env.example y completa los valores)." >&2; exit 1; }

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Error: hay cambios locales en el servidor en $REMOTE_DIR. Revísalos antes de desplegar." >&2
  exit 1
fi

# a) Respaldo preventivo (si la base ya existe)
mkdir -p backups
if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  BACKUP="backups/cashflow_$(date +%Y%m%d_%H%M%S).sql.gz"
  echo "==> 1/4 Respaldo preventivo: $BACKUP"
  if ! docker exec "$DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' | gzip > "$BACKUP"; then
    rm -f "$BACKUP"
    echo "Error: no se pudo crear el respaldo. Despliegue abortado para proteger los datos." >&2
    exit 1
  fi
  # pg_dump vacío = algo salió mal
  if [[ "$(gzip -cd "$BACKUP" | head -c 100 | wc -c)" -lt 50 ]]; then
    echo "Error: el respaldo quedó vacío. Despliegue abortado." >&2
    exit 1
  fi
  echo "    OK ($(du -h "$BACKUP" | cut -f1))"
  # Conservar solo los 30 respaldos más recientes
  ls -1t backups/cashflow_*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
else
  echo "==> 1/4 Primer despliegue: aún no hay base de datos que respaldar."
fi

# b) Código
echo "==> 2/4 Descargando $BRANCH desde GitHub..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
git log -1 --oneline

# c) Contenedores (migraciones idempotentes + bootstrap corren al arrancar)
echo "==> 3/4 Construyendo y reiniciando contenedores..."
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

# d) Salud
PORT="$(grep -E '^APP_HOST_PORT=' .env | cut -d= -f2 | tr -d '[:space:]"' || true)"
PORT="${PORT:-3020}"
echo "==> 4/4 Verificando http://127.0.0.1:$PORT/api/health ..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "    App saludable."
    docker compose ps
    exit 0
  fi
  sleep 3
done
echo "Error: la app no respondió. Revisa: docker compose logs --tail=100 cashflow_app" >&2
exit 1
REMOTE

info "Despliegue terminado."

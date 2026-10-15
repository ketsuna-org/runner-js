#!/bin/sh
# entrypoint.sh : démarrage tolérant en non-root pour runner-js (SEC-282, runner-js #21).
#
# Le conteneur démarre en root (pas de `USER` dans le Dockerfile) pour pouvoir lire des volumes /bots et /data
# déjà montés et possédés par root sur les runners déployés. Si l'utilisateur non privilégié peut y écrire, on lui
# cède la main avec `gosu` (environnement conservé) ; sinon on continue en root avec un avertissement clair au lieu
# de planter. Si Kubernetes impose déjà un utilisateur non-root (runAsUser/fsGroup), on lance directement.
set -e

APP_USER="${APP_USER:-bun}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${BOT_CREATOR_DATA_DIR:-/bots}"
LOG_FILE="${BOT_CREATOR_RUNNER_LOG_FILE:-}"
LOG_DIR=""
if [ -n "$LOG_FILE" ]; then
  LOG_DIR="$(dirname "$LOG_FILE")"
fi

run_app() {
  exec bun "$APP_DIR/dist/index.js"
}

if [ "$(id -u)" != "0" ]; then
  echo "[entrypoint] running as uid $(id -u) (non-root already)"
  run_app
fi

if ! command -v gosu >/dev/null 2>&1 || ! id "$APP_USER" >/dev/null 2>&1; then
  echo "[entrypoint] WARNING: gosu or user '$APP_USER' missing, continuing as root"
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  if [ -n "$LOG_DIR" ]; then mkdir -p "$LOG_DIR" 2>/dev/null || true; fi
  run_app
fi

# Les répertoires doivent exister pour tester l'écriture. On les crée EN TANT QUE l'utilisateur applicatif quand le
# parent le permet (sinon un répertoire créé par root ne lui serait plus accessible) ; à défaut, en root.
ensure_dir() {
  gosu "$APP_USER" mkdir -p "$1" 2>/dev/null || mkdir -p "$1" 2>/dev/null || true
}

can_write() {
  gosu "$APP_USER" test -w "$1" 2>/dev/null
}

ensure_dir "$DATA_DIR"
if [ -n "$LOG_DIR" ]; then
  ensure_dir "$LOG_DIR"
fi

ok=true
can_write "$DATA_DIR" || ok=false
if [ -n "$LOG_DIR" ]; then
  can_write "$LOG_DIR" || ok=false
fi

if [ "$ok" = "true" ]; then
  echo "[entrypoint] dropping privileges to '$APP_USER'"
  exec gosu "$APP_USER" bun "$APP_DIR/dist/index.js"
fi

echo "[entrypoint] WARNING: '$APP_USER' cannot write to $DATA_DIR${LOG_DIR:+ or $LOG_DIR}; continuing as root."
echo "[entrypoint] To run as non-root, mount the volumes with fsGroup/runAsUser matching uid of '$APP_USER'."
run_app

#!/bin/sh
# Test comportemental de entrypoint.sh dans l'image de base épinglée (nécessite Docker ; ignoré sinon).
# Usage : sh test-entrypoint.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="$(sed -n 's/^FROM \(oven\/bun:[^ ]*\) AS builder$/\1/p' "$DIR/Dockerfile" | head -1)"
if ! command -v docker >/dev/null 2>&1; then echo "docker absent : test ignoré"; exit 0; fi

run() { # $1 = nom du scénario ; le reste = arguments de docker run
  shift
  docker run --rm "$@" -v "$DIR/entrypoint.sh:/app/entrypoint.sh:ro" -e BOT_CREATOR_WEB_PORT=8080 \
    -e BOT_CREATOR_DATA_DIR=/bots -e BOT_CREATOR_RUNNER_LOG_FILE=/data/logs/runner.log \
    --entrypoint sh "$IMAGE" -c '
      apt-get update -qq >/dev/null && apt-get install -y -qq gosu >/dev/null 2>&1
      mkdir -p /app/dist /bots /data
      echo "console.log(\"APP uid=\" + process.getuid() + \" port=\" + process.env.BOT_CREATOR_WEB_PORT)" > /app/dist/index.js
      '"$SETUP"'
      '"${LAUNCH:-sh /app/entrypoint.sh}"
}

fail() { echo "✗ $1"; exit 1; }

echo "Scénario 1 : volumes possédés par root, non accessibles à bun -> continue en root, ne plante pas"
SETUP='chown root:root /bots /data; chmod 755 /bots /data;'
out="$(run s1)"; echo "$out" | sed 's/^/   /'
echo "$out" | grep -q "APP uid=0 port=8080" || fail "devait tourner en root avec l'environnement conservé"
echo "$out" | grep -q "WARNING" || fail "avertissement attendu"

echo "Scénario 2 : volumes accessibles à bun -> cède la main à bun, environnement conservé"
SETUP='chown -R bun:bun /bots /data;'
out="$(run s2)"; echo "$out" | sed 's/^/   /'
echo "$out" | grep -q "APP uid=1000 port=8080" || fail "devait tourner en bun (uid 1000) avec BOT_CREATOR_WEB_PORT"

echo "Scénario 3 : lancé directement en non-root (runAsUser) -> lance sans gosu"
SETUP='chown -R bun:bun /bots /data;'
LAUNCH='gosu bun sh /app/entrypoint.sh'
out="$(LAUNCH="$LAUNCH" run s3)"; echo "$out" | sed 's/^/   /'
echo "$out" | grep -q "non-root already" || fail "devait détecter qu'il est déjà non-root"
echo "$out" | grep -q "APP uid=1000 port=8080" || fail "devait lancer l'application en uid 1000"

echo ""
echo "Tous les scénarios passent ✓"

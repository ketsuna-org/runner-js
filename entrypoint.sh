#!/bin/sh
# entrypoint.sh — Tolerant non-root escalation for runner-js
# Starts as root, attempts to switch to 'bun' user if data directories
# are accessible, otherwise logs a warning and continues as root.
# Fixes SEC-282: Volumes /bots and /data pre-mounted as root on deployed runners.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${APP_USER:-bun}"
DATA_DIR="${BOT_CREATOR_DATA_DIR:-/bots}"
LOG_DIR="${BOT_CREATOR_RUNNER_LOG_FILE%/*}"  # Parent dir of log file

# Attempt graceful privilege drop if running as root
if [ "$(id -u)" = "0" ]; then
    # Check if data directories are accessible as target user
    can_access_data=true
    can_access_logs=true

    if ! su - "$APP_USER" -c "test -w '$DATA_DIR'" 2>/dev/null; then
        can_access_data=false
    fi

    if [ -n "$LOG_DIR" ] && [ "$LOG_DIR" != "." ]; then
        if ! su - "$APP_USER" -c "test -w '$LOG_DIR'" 2>/dev/null; then
            can_access_logs=false
        fi
    fi

    # If all critical directories are accessible, drop to non-root
    if [ "$can_access_data" = "true" ] && [ "$can_access_logs" = "true" ]; then
        echo "[entrypoint] ✓ Running as '$APP_USER' (privilege drop successful)"
        exec su - "$APP_USER" -c "exec bun $SCRIPT_DIR/dist/index.js"
    else
        # Log warnings but continue as root
        echo "[entrypoint] ⚠ Cannot access data directories as '$APP_USER':"
        if [ "$can_access_data" = "false" ]; then
            echo "  - $DATA_DIR not writable (check fsGroup/runAsUser in Kubernetes)"
        fi
        if [ "$can_access_logs" = "false" ]; then
            echo "  - $LOG_DIR not writable (check fsGroup/runAsUser in Kubernetes)"
        fi
        echo "[entrypoint] ⚠ Continuing as root (not recommended for production)"
        exec bun "$SCRIPT_DIR/dist/index.js"
    fi
else
    # Already running as non-root, just run the app
    echo "[entrypoint] ✓ Running as user $(id -u) (already non-root)"
    exec bun "$SCRIPT_DIR/dist/index.js"
fi

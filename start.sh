#!/usr/bin/env bash
# Runs the Telegram bot and the Mini App server together in one container so they
# share the same SQLite file. If either process exits, the container exits (so
# Railway restarts the whole thing).
set -euo pipefail

PYTHON="${PYTHON:-/opt/venv/bin/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python3

# Telegram bot (polling): handles /start and admin approve/reject.
"$PYTHON" bot.py &
BOT_PID=$!

# Mini App API + static frontend. Railway provides $PORT.
( cd server && exec node --experimental-sqlite index.js ) &
SERVER_PID=$!

# Exit (and let Railway restart) as soon as either process dies.
trap 'kill "$BOT_PID" "$SERVER_PID" 2>/dev/null || true' EXIT
wait -n "$BOT_PID" "$SERVER_PID"

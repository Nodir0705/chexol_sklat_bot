#!/usr/bin/env bash
# Runs the Telegram bot and the Mini App server together in one container so they
# share the same SQLite file. The web server runs in the foreground (it is the
# container's lifecycle / Railway healthcheck target); the bot runs alongside and
# is kept alive without being able to take the web server down.
set -uo pipefail

PYTHON="${PYTHON:-/opt/venv/bin/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python3

echo "[start.sh] PORT=${PORT:-3001} DB_PATH=${DB_PATH:-<default sklat.db>}" >&2

# Make sure the DB's directory exists (e.g. the /data volume mount). If DB_PATH is
# unset, Python and Node both fall back to their aligned repo-root sklat.db.
if [ -n "${DB_PATH:-}" ]; then
  mkdir -p "$(dirname "$DB_PATH")" 2>/dev/null || echo "[start.sh] WARN: could not create $(dirname "$DB_PATH")" >&2
fi

# 1. Create the DB schema + seed/approve users BEFORE the web server queries it.
if "$PYTHON" -c "import asyncio; from database.db import init_db; asyncio.run(init_db())"; then
  echo "[start.sh] schema ready" >&2
else
  echo "[start.sh] WARN: init_db failed (continuing; web server will report DB errors)" >&2
fi

# 2. Telegram bot in the background, auto-restarting, never crashing the web.
(
  while true; do
    "$PYTHON" bot.py || echo "[start.sh] bot exited ($?), restarting in 5s" >&2
    sleep 5
  done
) &

# 3. Web server in the foreground. Railway provides $PORT.
echo "[start.sh] starting web server..." >&2
cd server && exec node --experimental-sqlite index.js

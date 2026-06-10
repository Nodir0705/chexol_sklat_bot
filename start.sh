#!/usr/bin/env bash
# Runs the Telegram bot and the Mini App server together in one container so they
# share the same SQLite file. The web server runs in the foreground (it is the
# container's lifecycle / Railway healthcheck target); the bot runs alongside and
# is kept alive without being able to take the web server down.
set -uo pipefail

PYTHON="${PYTHON:-/opt/venv/bin/python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python3

# 1. Create the DB schema + seed/approve users BEFORE the web server queries it,
#    so Node never races against a not-yet-created table.
"$PYTHON" -c "import asyncio; from database.db import init_db; asyncio.run(init_db())"

# 2. Telegram bot in the background, auto-restarting, never crashing the web.
(
  while true; do
    "$PYTHON" bot.py || echo "[start.sh] bot exited ($?), restarting in 5s"
    sleep 5
  done
) &

# 3. Web server in the foreground. Railway provides $PORT.
cd server && exec node --experimental-sqlite index.js

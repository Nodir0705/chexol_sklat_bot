#!/usr/bin/env bash
# Nightly SQLite backup. Uses `sqlite3 .backup`, which is the online backup API —
# safe to run while the bot and web server are writing (a plain `cp` is not,
# because the database runs in WAL mode).
#
#   crontab -e
#   17 3 * * * /srv/chexol_sklat_bot/scripts/backup.sh >> /var/log/sklat-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"
docker compose -f "$ROOT/docker-compose.yml" exec -T app \
  sqlite3 /data/sklat.db ".backup '/data/backup-$STAMP.db'"
mv "$ROOT/data/backup-$STAMP.db" "$DEST/sklat-$STAMP.db"
gzip -f "$DEST/sklat-$STAMP.db"

find "$DEST" -name 'sklat-*.db.gz' -mtime "+$KEEP_DAYS" -delete
echo "[backup] $DEST/sklat-$STAMP.db.gz"

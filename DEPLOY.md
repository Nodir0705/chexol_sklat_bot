# Deploying on a Hostinger VPS

One Docker image runs three things — the Python Telegram bot (polling), the
Node/Fastify API, and the built React Mini App — sharing a single SQLite file.
Caddy sits in front and terminates TLS, because Telegram only opens Mini Apps
over `https://` on a real domain.

```
Telegram ──https──▶ Caddy :443 ──▶ app :3001 (Fastify + SPA)
                                    └── bot.py (long polling) ──▶ api.telegram.org
                                    └── /data/sklat.db  ⇄  host ./data/
```

## 1. Prerequisites

- Hostinger VPS (KVM), Ubuntu 22.04/24.04, root SSH.
- A domain (or subdomain) with an **A record pointing at the VPS IP**.
  Let it propagate before the first `docker compose up` — Caddy's certificate
  request fails if Let's Encrypt cannot reach the domain.

## 2. Server setup (once)

```bash
ssh root@YOUR_VPS_IP

apt update && apt -y upgrade
apt -y install docker.io docker-compose-v2 git
systemctl enable --now docker

ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 3. Deploy

```bash
mkdir -p /srv && cd /srv
git clone https://github.com/Nodir0705/chexol_sklat_bot.git
cd chexol_sklat_bot

cp .env.example .env
nano .env          # BOT_TOKEN, DOMAIN, WEBAPP_URL, ADMIN_ID, APPROVED_IDS

mkdir -p data
# Restore an existing database (see "Migrating data" below), or skip to start empty.
# scp ./sklat.db root@YOUR_VPS_IP:/srv/chexol_sklat_bot/data/sklat.db

docker compose up -d --build
docker compose logs -f
```

Expect `[start.sh] schema ready` and `✅ Sklat server → http://0.0.0.0:3001`,
then Caddy logging a successful certificate obtain.

## 4. Verify

```bash
curl -s https://YOUR_DOMAIN/api/tree | head -c 300     # category tree + stock
curl -sI https://YOUR_DOMAIN/                          # 200, valid certificate
```

In Telegram: `/start` → the "🏭 Sklatni ochish" button must open the Mini App.
If a Menu Button or Web App URL was configured in **@BotFather**, update it to
the new domain there too — that URL is stored on Telegram's side, not in this repo.

## 5. Migrating data from an old host

WAL mode means a plain `cp` of `sklat.db` can silently lose recent writes.
Always use the online backup API:

```bash
# On the old host, inside the container:
python3 -c "
import sqlite3
src = sqlite3.connect('/data/sklat.db')
dst = sqlite3.connect('/tmp/snap.db')
src.backup(dst); dst.close(); src.close()"

# Then copy /tmp/snap.db out, and on the VPS:
cp snap.db /srv/chexol_sklat_bot/data/sklat.db
sqlite3 data/sklat.db 'PRAGMA integrity_check; SELECT COUNT(*) FROM stock_transactions;'
docker compose restart app
```

**Never run two instances against the same bot token.** Telegram returns
409 Conflict and the two pollers fight over updates — stop the old deployment
before starting the new one.

## 6. Operating

```bash
docker compose logs -f app          # bot + server logs
docker compose restart app          # after an .env change
git pull && docker compose up -d --build   # deploy an update
./scripts/backup.sh                 # WAL-safe snapshot into ./backups/
```

Add a nightly backup:

```bash
crontab -e
17 3 * * * /srv/chexol_sklat_bot/scripts/backup.sh >> /var/log/sklat-backup.log 2>&1
```

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | yes | From @BotFather. Also used to verify Mini App `initData`. |
| `DOMAIN` | yes | Hostname Caddy issues the TLS certificate for. |
| `WEBAPP_URL` | yes | Same host; `https://` is added automatically if omitted. |
| `ADMIN_ID` | yes | Telegram id that approves/rejects new users. |
| `APPROVED_IDS` | no | Comma-separated ids auto-approved at startup. |
| `DB_PATH` | no | Set to `/data/sklat.db` by docker-compose. |
| `DEV_OPEN_ACCESS` | no | `1` bypasses Telegram auth. **Never set in production.** |

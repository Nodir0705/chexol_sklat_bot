# Railway → Hostinger VPS migration

Target: `chexol_sklat_bot` (Python bot + Node/Fastify API + React Mini App, one SQLite file).
Hostinger VPS (KVM), Docker. Railway project deleted only AFTER verification.

## Phase 0 — Rescue from Railway (do FIRST, nothing is recoverable after deletion)
- [ ] Install Railway CLI (`npm i -g @railway/cli`)
- [ ] `railway login` (interactive — user runs it)
- [ ] `railway link` to the chexol project/service
- [ ] `railway variables` → capture BOT_TOKEN, ADMIN_ID, APPROVED_IDS, WEBAPP_URL, DB_PATH
- [ ] Determine if a volume exists (DB_PATH set?). If unset → no persistent data ever existed
- [ ] STOP the Railway service (do not delete) — avoids 409 polling conflict + last-minute writes
- [ ] Snapshot SQLite **WAL-safe**: `.backup`/checkpoint, not a raw `cat` (server runs journal_mode=WAL)
- [ ] Verify locally: `PRAGMA integrity_check` + row counts for users / product_categories / stock_items / stock_transactions

## Phase 1 — Repo changes for VPS (local, reversible)
- [ ] `docker-compose.yml`: app (build .), env_file, `./data:/data`, `DB_PATH=/data/sklat.db`, bind `127.0.0.1:3001`, `restart: unless-stopped`
- [ ] `Caddyfile` + caddy service: automatic Let's Encrypt TLS, reverse proxy → app:3001
- [ ] Delete `railway.json`
- [ ] De-Railway the comments in Dockerfile / start.sh / .env.example
- [ ] `DEPLOY.md` runbook (provision, deploy, backup, restore, update)
- [ ] Commit + push to GitHub

## Phase 2 — Provision the VPS
- [ ] Need from user: VPS IP, SSH user/key, chosen domain
- [ ] DNS: A record `@`/subdomain → VPS IP (propagate before Caddy first run)
- [ ] Install Docker Engine + compose plugin
- [ ] ufw: allow 22, 80, 443; deny the rest
- [ ] Clone repo, write `.env` (real token), drop rescued `sklat.db` into `./data/`

## Phase 3 — Cutover
- [ ] `docker compose up -d --build`
- [ ] Verify: `https://DOMAIN/` serves the SPA, `/api/tree` returns the real category tree + stock
- [ ] Set `WEBAPP_URL=DOMAIN` in `.env`, restart app
- [ ] Bot: `/start` in Telegram → button opens the Mini App over HTTPS
- [ ] @BotFather: update Menu Button / Web App URL if one was configured (user action)
- [ ] Confirm stock numbers + history match what Railway showed

## Phase 4 — Decommission
- [ ] Take a final backup of `./data/sklat.db` off the VPS
- [ ] Delete the Railway project (user, in dashboard)
- [ ] Add a nightly `sqlite3 .backup` cron on the VPS

## Open decision — domain
Telegram Mini Apps require a real HTTPS domain (no bare IP, no self-signed).
1. **Buy/point a domain** (Hostinger 12mo+ VPS plans often bundle one free) — best
2. **Free subdomain via DuckDNS** (`chexol-sklat.duckdns.org`) — works with Let's Encrypt, zero cost, fine for an internal warehouse tool

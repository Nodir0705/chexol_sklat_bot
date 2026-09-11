# Railway → Hostinger VPS migration

Target: `chexol_sklat_bot` (Python bot + Node/Fastify API + React Mini App, one SQLite file).
Hostinger VPS (KVM), Docker. Railway project deleted only AFTER verification.

## Phase 0 — Rescue from Railway (do FIRST, nothing is recoverable after deletion)
- [x] Install Railway CLI (`npm i -g @railway/cli`)
- [x] `railway login` + link `compassionate-energy` / `chexol_sklat_bot`
- [x] Captured BOT_TOKEN, ADMIN_ID (1444766498), WEBAPP_URL, DB_PATH → scratchpad, chmod 600
- [x] Volume confirmed: `chexol_sklat_bot-volume` /data, 50.9 MB, Ready
- [x] Service already Offline since 2026-06-24 → no 409 polling conflict at cutover
- [~] **Data rescue SKIPPED — user chose a fresh empty database.**
      Volume file access requires a live deployment (no download/export exists in Railway's
      GraphQL API); the trial ended, so redeploying is not possible without a paid plan.
      The volume is not pending deletion, so this stays recoverable until the project is deleted.

### Gotchas found on Railway (not to be carried over)
- `DB_PATH` was `"/data/sklat.db "` — **trailing space**. It worked only because Python and
  Node read the same malformed value. docker-compose sets a clean `/data/sklat.db`.
- `APPROVED_IDS` was never set, so `config.py`'s hardcoded `752030660` was auto-approved on
  every startup. The VPS `.env` sets it explicitly to the admin id instead.

## Phase 1 — Repo changes for VPS (local, reversible)
- [x] `docker-compose.yml`: app (build .), env_file, `./data:/data`, `DB_PATH=/data/sklat.db`, bind `127.0.0.1:3001`, `restart: unless-stopped`
- [x] `Caddyfile` + caddy service: automatic Let's Encrypt TLS, reverse proxy → app:3001
- [x] Delete `railway.json`
- [x] De-Railway the comments in Dockerfile / start.sh / .env.example
- [x] `DEPLOY.md` runbook (provision, deploy, backup, restore, update)
- [x] Commit locally (push held until you confirm)

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

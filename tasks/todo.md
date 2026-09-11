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
- [x] VPS 187.53.134.187 (srv1957718, Ubuntu 26.04.1), key-based root SSH working
- [x] Already provisioned: Docker 29.8.0, Compose v5.5.1, ufw active (22/80/443), nothing on 80/443
- [x] Domain: `chexol-sklat.duckdns.org` → 187.53.134.187 (DuckDNS; on the Public Suffix List, so Let's Encrypt rate limits are per-subdomain)
- [x] Docker + compose already present — nothing to install
- [x] ufw already correct
- [x] Cloned to /srv/chexol_sklat_bot @ d0ac65c; `./data/` created (fresh DB, no restore)
- [x] **Smoke test passed**: image builds, `/api/tree` returns the seeded tree, `/` serves the SPA (200 text/html), DB persists to `./data/sklat.db` (clean path)
- [x] `.env` written with the real BOT_TOKEN + domain, chmod 600, DEV_OPEN_ACCESS removed

## Phase 3 — Cutover
- [x] `docker compose up -d` — both containers running
- [x] Let's Encrypt certificate obtained for chexol-sklat.duckdns.org (expires 2026-12-10, auto-renews)
- [x] `https://…/` → HTTP/2 200 text/html, `SSL certificate verify ok`
- [x] `https://…/api/tree` → seeded category tree
- [x] `http://` → 308 redirect to https
- [x] Bot online: `Application started`, `@chexol_1_bot` (id 8579564443), no webhook set, polling clean
- [x] Auth fails closed: POST /api/transaction, POST /api/categories, DELETE /api/categories/:id all 403 without initData; /api/access → `{"allowed":false,"reason":"no_telegram"}`
- [x] Nightly backup cron installed (03:17), snapshot verified `integrity_check ok`
- [x] Survives reboot: docker enabled at boot + `restart: unless-stopped`
- [ ] **USER TEST: `/start` in Telegram → "🏭 Sklatni ochish" opens the Mini App**
- [x] @BotFather menu button was never set to a Web App URL (`type: commands`) — nothing stale to fix

## Phase 4 — Decommission
- [x] Nightly `sqlite3 .backup` cron on the VPS
- [ ] Delete the Railway project (user, in dashboard) — **only after the /start test passes**
- [ ] Note: deleting the project also destroys the 50.9 MB volume holding the old stock history.
      That is the point of no return on the data the user chose to abandon.

## Review

Migrated from Railway to Hostinger VPS 187.53.134.187 (Ubuntu 26.04.1), Docker Compose.
The old deployment had been Offline since 2026-06-24.

**What changed in the repo:** `railway.json` deleted; `docker-compose.yml` (app + Caddy) and
`Caddyfile` added; `scripts/backup.sh` and `DEPLOY.md` added; `sqlite3` added to the image;
`APPROVED_IDS` pinned in `.env.example`. Application code was not touched beyond comments.

**Two latent bugs found and not carried over:**
1. Railway's `DB_PATH` was `"/data/sklat.db "` with a trailing space — the real file on the
   volume was literally named with that space. It only worked because Python and Node both
   read the same malformed value. Compose now sets a clean path.
2. `APPROVED_IDS` was unset, so `config.py`'s hardcoded fallback id `752030660` was granted
   warehouse access on every startup. Now pinned to the admin id.

**One bug introduced and fixed:** `scripts/backup.sh` used `docker compose exec -T`, which
forwards stdin and silently ate the rest of any calling script. Fixed with `</dev/null` (5caf713).

**Data:** started empty by the user's decision. Old history remains on the Railway volume until
that project is deleted.

## Open decision — domain
Telegram Mini Apps require a real HTTPS domain (no bare IP, no self-signed).
1. **Buy/point a domain** (Hostinger 12mo+ VPS plans often bundle one free) — best
2. **Free subdomain via DuckDNS** (`chexol-sklat.duckdns.org`) — works with Let's Encrypt, zero cost, fine for an internal warehouse tool

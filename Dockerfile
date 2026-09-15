# Deterministic build: Python (Telegram bot) + Node (Mini App server
# and frontend build) in one image so the two processes share one SQLite file.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates bash sqlite3 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# fonts-dejavu-core: the receipt images are rendered from SVG, and the slim base
# ships no fonts at all -- text silently renders as nothing.

WORKDIR /app

# --- Python deps (Telegram bot) ---
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PYTHON=/opt/venv/bin/python
# Flush stdout immediately so startup logs are visible in `docker compose logs`.
ENV PYTHONUNBUFFERED=1

# --- Node deps (cached on lockfiles) ---
# --include=dev: the frontend build needs tsc/vite (devDependencies), which npm
# would otherwise skip if NODE_ENV=production is set.
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --include=dev
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

# --- App source (node_modules/dist/.git excluded via .dockerignore) ---
COPY . .

# --- Build the React SPA into frontend/dist (served by the Node server) ---
RUN cd frontend && npm run build

CMD ["bash", "start.sh"]

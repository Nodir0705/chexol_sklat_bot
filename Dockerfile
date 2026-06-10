# Deterministic build for Railway: Python (Telegram bot) + Node (Mini App server
# and frontend build) in one image so the two processes share one SQLite file.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python deps (Telegram bot) ---
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PYTHON=/opt/venv/bin/python

# --- Node deps (cached on lockfiles) ---
# --include=dev: the frontend build needs tsc/vite (devDependencies), which npm
# would otherwise skip when Railway sets NODE_ENV=production.
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --include=dev
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

# --- App source (node_modules/dist/.git excluded via .dockerignore) ---
COPY . .

# --- Build the React SPA into frontend/dist (served by the Node server) ---
RUN cd frontend && npm run build

CMD ["bash", "start.sh"]

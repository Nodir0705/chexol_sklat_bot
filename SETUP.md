# UyBeka — Setup Guide

Telegram Mini App for Uzbek family kitchen management.

## Prerequisites

- Python 3.10+
- Node.js 18+
- npm 9+
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

## Project Structure

```
uybeka_bot/
├── bot.py                  # Telegram bot (polling)
├── webapp.py               # FastAPI API server
├── config.py               # Loads BOT_TOKEN from .env
├── tunnel.py               # ngrok tunnel for public URL
├── requirements.txt        # Python dependencies
├── uybeka.db               # SQLite database (auto-created)
│
├── database/
│   ├── db.py               # Async SQLAlchemy engine
│   └── models.py           # User, Inventory, ShoppingList models
│
├── data/
│   ├── items.py            # Item categories, emojis, quantities
│   └── recipes.py          # 30 Uzbek recipes with UZ/RU translations
│
├── handlers/
│   ├── start.py            # /start, language selection
│   ├── inventory.py        # Add/use/list inventory via bot
│   └── shopping.py         # Shopping list via bot
│
├── services/
│   └── image_generator.py  # PIL-based visual inventory
│
└── frontend/               # React + Vite + TypeScript Mini App
    ├── package.json
    ├── vite.config.ts       # Proxy /api → localhost:8000
    ├── tsconfig.json
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── types/index.ts
        ├── hooks/
        │   ├── useTelegram.ts
        │   └── useInventory.ts
        ├── utils/
        │   ├── api.ts
        │   └── i18n.ts
        ├── components/
        │   ├── BottomNav.tsx
        │   └── ProgressBar.tsx
        └── pages/
            ├── HomePage.tsx
            ├── InventoryPage.tsx
            ├── RecipesPage.tsx
            ├── RecipeDetailPage.tsx
            └── ShoppingPage.tsx
```

## 1. Clone & Environment Setup

```bash
cd ~/uybeka_bot

# Create Python virtual environment
python3 -m venv uybeka_env
source uybeka_env/bin/activate
```

## 2. Configure Environment Variables

Create a `.env` file in the project root:

```
BOT_TOKEN=your_telegram_bot_token_here
```

## 3. Install Python Dependencies

```bash
source uybeka_env/bin/activate
pip install -r requirements.txt
```

### Python Packages

| Package | Purpose |
|---------|---------|
| python-telegram-bot | Telegram bot framework |
| FastAPI | REST API server |
| uvicorn | ASGI server |
| SQLAlchemy | ORM for SQLite |
| aiosqlite | Async SQLite driver |
| python-dotenv | Load .env variables |
| Pillow | Image generation for inventory visuals |
| jinja2 | Template rendering |
| python-multipart | Form data parsing |

## 4. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### Frontend Stack

| Package | Purpose |
|---------|---------|
| React 18 | UI framework |
| TypeScript | Type safety |
| Vite | Dev server & build tool |
| Tailwind CSS | Utility-first styling |

## 5. Initialize Database

The database (`uybeka.db`) is auto-created on first run of either `bot.py` or `webapp.py`. No manual migration needed.

**Tables created:**
- `users` — Telegram user accounts (language, role, partner pairing)
- `inventory` — Food items with quantities and thresholds
- `shopping_list` — Shopping list items with bought status

## 6. Running Locally

You need **3 terminals** running simultaneously:

### Terminal 1 — Telegram Bot

```bash
cd ~/uybeka_bot
source uybeka_env/bin/activate
python3 bot.py
```

Handles Telegram commands (`/start`, inventory conversations, shopping lists).

### Terminal 2 — API Server

```bash
cd ~/uybeka_bot
source uybeka_env/bin/activate
python3 webapp.py
```

Runs FastAPI on **http://localhost:8000**. The API server does NOT start the bot — no 409 conflict.

### Terminal 3 — Frontend Dev Server

```bash
cd ~/uybeka_bot/frontend
npm run dev
```

Runs Vite on **http://localhost:5173** with hot reload. API calls are proxied to port 8000.

## 7. Verify Everything Works

| Check | URL | Expected |
|-------|-----|----------|
| Frontend loads | http://localhost:5173 | Dashboard page with greeting |
| API items | http://localhost:8000/api/items | JSON with 7 categories |
| API recipes | http://localhost:8000/api/recipes | JSON with 30 recipes |
| API inventory | http://localhost:8000/api/inventory?user_id=12345 | JSON items array |
| Bot responds | Send `/start` to your bot in Telegram | Language selection keyboard |

## 8. Production Build

```bash
cd ~/uybeka_bot/frontend
npm run build
```

This creates `frontend/dist/`. When `webapp.py` detects this directory, it serves the SPA automatically — no separate frontend server needed.

```bash
# Single server in production:
cd ~/uybeka_bot
source uybeka_env/bin/activate
python3 webapp.py   # Serves both API and frontend on port 8000
python3 bot.py      # Separate terminal for bot
```

## 9. Making the App Public (HTTPS via ngrok)

Telegram Mini Apps require an **HTTPS** URL. The easiest way is ngrok.

### Step 1: Build the frontend

```bash
cd ~/uybeka_bot/frontend
npm run build
```

### Step 2: Start the API server (serves frontend + API on one port)

```bash
cd ~/uybeka_bot
source uybeka_env/bin/activate
python3 webapp.py
```

### Step 3: Start the ngrok tunnel

```bash
cd ~/uybeka_bot
source uybeka_env/bin/activate
python3 tunnel.py
```

You will see output like:

```
==================================================
  Public URL: https://xxxx-xxxx.ngrok-free.app

  Use this URL in BotFather:
  /mybots -> Bot Settings -> Configure Mini App
==================================================
```

Your app is now accessible globally at that HTTPS URL.

### Step 4: Configure in BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. `/mybots` → Select your bot → **Bot Settings** → **Configure Mini App**
3. Paste the ngrok URL as the Mini App URL
4. Users can now open the Mini App from your bot's menu button

### ngrok first-time setup

If you haven't used ngrok before, you need a free auth token:

1. Sign up at https://ngrok.com
2. Copy your auth token from the dashboard
3. Run: `ngrok config add-authtoken YOUR_TOKEN`

### Summary: Running publicly

```bash
# Terminal 1: Bot
cd ~/uybeka_bot && source uybeka_env/bin/activate && python3 bot.py

# Terminal 2: API + Frontend (single server)
cd ~/uybeka_bot && source uybeka_env/bin/activate && python3 webapp.py

# Terminal 3: Public HTTPS tunnel
cd ~/uybeka_bot && source uybeka_env/bin/activate && python3 tunnel.py
```

## API Endpoints Reference

### Items & Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/items` | Item catalog (categories, emojis, quantities) |
| GET | `/api/inventory?user_id=` | User's inventory items |
| POST | `/api/inventory/add` | Add item `{user_id, item_name, quantity, unit, category}` |
| POST | `/api/inventory/update` | Change quantity `{user_id, item_name, change}` |
| POST | `/api/inventory/delete` | Remove item `{user_id, item_name}` |

### Shopping

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/shopping?user_id=` | Low-stock items (quantity <= 2) |
| POST | `/api/shopping/share` | Generate shareable list text `{user_id}` |

### Recipes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/recipes` | All 30 recipes with category metadata |
| GET | `/api/recipes/available?user_id=` | Recipes sorted by ingredient match % |
| POST | `/api/recipes/cook` | Deduct ingredients `{user_id, recipe_id, portions}` |

## Features

### Mini App (Frontend)
- Home dashboard with stock overview and low-stock alerts
- Inventory management with category filters and +/- quantity buttons
- 30 Uzbek recipes with "What can I cook?" ingredient matching
- Recipe detail with portion scaler (2/4/6/8) and auto-deduct cooking
- Shopping list auto-generated from low stock
- Uzbek / Russian language toggle
- Telegram light/dark theme integration

### Telegram Bot
- `/start` — Register with language selection (O'zbekcha / Русский)
- Add/use inventory items via conversation flow
- Visual inventory dashboard (PIL-generated image)
- Photo upload for custom item icons
- Shopping list view and share

## Troubleshooting

**Bot 409 Conflict error:**
Make sure only one instance of `bot.py` is running. `webapp.py` does NOT start the bot.

**Frontend can't reach API:**
Check that `webapp.py` is running on port 8000. The Vite config proxies `/api` requests there.

**Database locked:**
Both bot and webapp share `uybeka.db`. SQLite handles concurrent reads but may lock on writes. Restart both if stuck.

**npm install fails:**
Make sure Node.js 18+ is installed: `node --version`

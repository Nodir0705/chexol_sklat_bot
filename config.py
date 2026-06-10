import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN  = os.getenv("BOT_TOKEN")
# Telegram Web App buttons require an https:// URL. Accept a bare domain and
# normalise it so "myapp.up.railway.app" becomes "https://myapp.up.railway.app".
WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip()
if WEBAPP_URL and not WEBAPP_URL.startswith("http"):
    WEBAPP_URL = "https://" + WEBAPP_URL
# Point DB_PATH at a mounted volume in production so data survives redeploys.
DB_NAME    = os.getenv("DB_PATH", "sklat.db")
ADMIN_ID   = int(os.getenv("ADMIN_ID", "0"))

# Telegram user ids that are auto-approved on startup (no /start request needed).
# Comma-separated; ADMIN_ID is always included. Override via the APPROVED_IDS env var.
APPROVED_IDS = [
    int(x) for x in os.getenv("APPROVED_IDS", "752030660").split(",") if x.strip()
]

import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN  = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL", "")
# Point DB_PATH at a mounted volume in production so data survives redeploys.
DB_NAME    = os.getenv("DB_PATH", "sklat.db")
ADMIN_ID   = int(os.getenv("ADMIN_ID", "0"))

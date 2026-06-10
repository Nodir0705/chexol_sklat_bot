import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN  = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL", "")
DB_NAME    = "sklat.db"
ADMIN_ID   = int(os.getenv("ADMIN_ID", "0"))

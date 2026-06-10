import logging
import datetime
try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9 (e.g. Ubuntu 20.04 on Jetson)
    from backports.zoneinfo import ZoneInfo

from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, Application

from config import BOT_TOKEN
from database.db import init_db
from handlers.start import start
from handlers.admin import handle_approve, handle_reject
from handlers.warehouse import send_daily_reminder

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)


async def post_init(application: Application):
    await init_db()
    application.job_queue.run_daily(
        send_daily_reminder,
        time=datetime.time(9, 0, 0, tzinfo=ZoneInfo("Asia/Tashkent")),
        name="daily_reminder",
    )


def main():
    application = ApplicationBuilder().token(BOT_TOKEN).post_init(post_init).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CallbackQueryHandler(handle_approve, pattern=r"^approve_\d+$"))
    application.add_handler(CallbackQueryHandler(handle_reject,  pattern=r"^reject_\d+$"))

    application.run_polling()


if __name__ == "__main__":
    main()

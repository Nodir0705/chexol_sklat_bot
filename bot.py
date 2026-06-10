import logging

from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, Application

from config import BOT_TOKEN
from database.db import init_db
from handlers.start import start
from handlers.admin import handle_approve, handle_reject

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)


async def post_init(application: Application):
    await init_db()


def main():
    application = ApplicationBuilder().token(BOT_TOKEN).post_init(post_init).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CallbackQueryHandler(handle_approve, pattern=r"^approve_\d+$"))
    application.add_handler(CallbackQueryHandler(handle_reject,  pattern=r"^reject_\d+$"))

    application.run_polling()


if __name__ == "__main__":
    main()

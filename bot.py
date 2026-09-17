import logging

from telegram.ext import (ApplicationBuilder, CommandHandler, CallbackQueryHandler,
                          ChatMemberHandler, Application, filters)

from config import BOT_TOKEN
from database.db import init_db
from handlers.admin import handle_approve, handle_reject
from handlers.groups import ulash, on_my_chat_member
# on_start_edit owns /start: it answers the edit deep link and hands every other
# /start — no payload, a malformed one, a non-operator, a row that may not be
# edited — to handlers.start.start untouched.
from handlers.board import (on_ledger_tap, on_board_header, on_edit_tap,
                            on_board_edit, on_board_report, on_start_edit,
                            CALLBACK_LEDGER, CALLBACK_HEADER, CALLBACK_EDIT,
                            CALLBACK_BOARD_EDIT, CALLBACK_BOARD_REPORT)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
# httpx logs every request URL at INFO, and python-telegram-bot puts the token in
# the path — so each getUpdates poll would write the bot token into the container
# logs in plaintext. WARNING still surfaces real transport failures.
logging.getLogger("httpx").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


async def post_init(application: Application):
    await init_db()
    # The edit deep link is t.me/<username>?start=..., so the bot's own username
    # is read once here and cached. Failing leaves bot_data without the key,
    # which makes every operator's edit tap answer MSG_EDIT_OFF — editing is
    # disabled bot-wide, silently for clients, and that must be visible in the log.
    try:
        me = await application.bot.get_me()
        application.bot_data['bot_username'] = me.username
    except Exception as e:
        logger.error("Could not read the bot's username — edit deep links are DISABLED: %s", e)


def main():
    application = ApplicationBuilder().token(BOT_TOKEN).post_init(post_init).build()

    # PRIVATE ONLY. /start in a group creates a pending `users` row and pings the
    # admin, which is how a group member gets the row a forged approve_<id> would
    # flip to 'approved' — and 'approved' is what the Mini App's requireAuth
    # gates every money route on. on_start_edit refuses a non-private chat again
    # on its own, so this filter is the outer of two doors, not the only one.
    application.add_handler(
        CommandHandler("start", on_start_edit, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("ulash", ulash))
    application.add_handler(ChatMemberHandler(on_my_chat_member, ChatMemberHandler.MY_CHAT_MEMBER))
    application.add_handler(CallbackQueryHandler(handle_approve, pattern=r"^approve_\d+$"))
    application.add_handler(CallbackQueryHandler(handle_reject,  pattern=r"^reject_\d+$"))
    # The living board. Every pattern in this group is fully anchored (^...$) and
    # the prefixes are disjoint — "led:"/"edq:"/"eds:"/"bed:"/"brp:"/"boardhdr"
    # can never match an approve_/reject_ payload, nor can those match ours, nor
    # can any of ours match another — so order inside the group is irrelevant and
    # no handler can shadow another (asserted programmatically by the shadow test).
    application.add_handler(CallbackQueryHandler(on_ledger_tap,   pattern=CALLBACK_LEDGER))
    application.add_handler(CallbackQueryHandler(on_board_header, pattern=CALLBACK_HEADER))
    application.add_handler(CallbackQueryHandler(on_edit_tap,     pattern=CALLBACK_EDIT))
    # The image board's two board-level buttons: ✏️ Tahrirlash and 📊 Hisobot.
    application.add_handler(CallbackQueryHandler(on_board_edit,   pattern=CALLBACK_BOARD_EDIT))
    application.add_handler(CallbackQueryHandler(on_board_report, pattern=CALLBACK_BOARD_REPORT))

    application.run_polling()


if __name__ == "__main__":
    main()

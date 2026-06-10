import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ContextTypes
from sqlalchemy import select
from database.db import AsyncSessionLocal
from database.models import User
from config import WEBAPP_URL, ADMIN_ID

logger = logging.getLogger(__name__)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_user = update.effective_user

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.telegram_id == tg_user.id))
        db_user = result.scalar_one_or_none()

        if db_user is None:
            # Brand-new user
            status = 'approved' if tg_user.id == ADMIN_ID else 'pending'
            db_user = User(
                telegram_id=tg_user.id,
                name=tg_user.first_name,
                username=tg_user.username,
                status=status,
            )
            session.add(db_user)
            await session.commit()
        else:
            status = db_user.status

    # ── Act on status ──────────────────────────────────────────────────────────

    if status == 'pending':
        # Notify admin every time a pending user sends /start (they may have missed it)
        await _notify_admin(context, tg_user)
        await update.message.reply_text(
            "Assalomu alaykum!\n\n"
            "Sizning so'rovingiz adminga yuborildi. ⏳\n"
            "Tasdiqlangandan so'ng xabar olasiz."
        )
        return

    if status == 'rejected':
        await update.message.reply_text("❌ Kechirasiz, sizga ruxsat berilmagan.")
        return

    # Approved — show the app button
    buttons = [[InlineKeyboardButton("🏭 Sklatni ochish", web_app=WebAppInfo(url=WEBAPP_URL))]]
    await update.message.reply_text(
        f"Assalomu alaykum, {tg_user.first_name}!",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def _notify_admin(context, tg_user):
    if not ADMIN_ID:
        logger.warning("ADMIN_ID not set — cannot send approval request")
        return

    lines = [f"👤 Yangi foydalanuvchi kirmoqchi:\n\nIsm: {tg_user.first_name}"]
    if tg_user.username:
        lines.append(f"Username: @{tg_user.username}")
    lines.append(f"ID: {tg_user.id}")

    buttons = [[
        InlineKeyboardButton("✅ Qabul", callback_data=f"approve_{tg_user.id}"),
        InlineKeyboardButton("❌ Rad",   callback_data=f"reject_{tg_user.id}"),
    ]]
    try:
        await context.bot.send_message(
            ADMIN_ID,
            "\n".join(lines),
            reply_markup=InlineKeyboardMarkup(buttons),
        )
        logger.info("Approval request sent to admin for user %s", tg_user.id)
    except Exception as e:
        logger.error("Could not notify admin (ADMIN_ID=%s): %s", ADMIN_ID, e)

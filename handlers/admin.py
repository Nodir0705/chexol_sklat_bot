from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ContextTypes
from sqlalchemy import select
from database.db import AsyncSessionLocal
from database.models import User
from config import WEBAPP_URL


async def handle_approve(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user_id = int(query.data.split('_')[1])

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.telegram_id == user_id))
        db_user = result.scalar_one_or_none()
        if not db_user:
            await query.edit_message_text("Foydalanuvchi topilmadi.")
            return
        db_user.status = 'approved'
        name = db_user.name
        await session.commit()

    # Notify the approved user
    buttons = [[InlineKeyboardButton("🏭 Sklatni ochish", web_app=WebAppInfo(url=WEBAPP_URL))]]
    try:
        await context.bot.send_message(
            user_id,
            "✅ Siz tasdiqlangansiz! Endi sklatga kira olasiz.",
            reply_markup=InlineKeyboardMarkup(buttons),
        )
    except Exception:
        pass

    await query.edit_message_text(f"✅ {name} tasdiqlandi.")


async def handle_reject(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user_id = int(query.data.split('_')[1])

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.telegram_id == user_id))
        db_user = result.scalar_one_or_none()
        if not db_user:
            await query.edit_message_text("Foydalanuvchi topilmadi.")
            return
        db_user.status = 'rejected'
        name = db_user.name
        await session.commit()

    try:
        await context.bot.send_message(user_id, "❌ Kechirasiz, sizning so'rovingiz rad etildi.")
    except Exception:
        pass

    await query.edit_message_text(f"❌ {name} rad etildi.")

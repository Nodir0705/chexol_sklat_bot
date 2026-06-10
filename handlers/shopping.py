from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import ContextTypes
from database.db import AsyncSessionLocal
from database.models import Inventory
from sqlalchemy import select

async def shopping_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows the shopping sub-menu."""
    query = update.callback_query
    await query.answer()
    
    buttons = [
        [InlineKeyboardButton("📝 Kerakli mahsulotlar (Need)", callback_data='shop_need')],
        [InlineKeyboardButton("📤 Ulashish (Share)", callback_data='shop_share')],
        [InlineKeyboardButton("⬅️ Ortga (Back)", callback_data='main_menu')]
    ]
    await query.edit_message_text(
        text="🛒 **Bozorlik:**\nNima qilmoqchisiz?", 
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode='Markdown'
    )

async def need_list_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows shopping list via callback."""
    query = update.callback_query
    await query.answer()
    user = update.effective_user
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == user.id,
                Inventory.quantity <= 2 
            )
        )
        low_stock_items = result.scalars().all()

    if not low_stock_items:
        msg = "🎉 Hamma narsa yetarli! Xarid qilishga ehtiyoj yo'q."
    else:
        msg = "🛒 **Bozorlik ro'yxati:**\n\n"
        for item in low_stock_items:
            msg += f"▫️ {item.item_name.capitalize()} ({item.quantity} {item.unit} qolgan)\n"

    buttons = [[InlineKeyboardButton("⬅️ Ortga", callback_data='menu_shopping')]]
    await query.edit_message_text(msg, reply_markup=InlineKeyboardMarkup(buttons), parse_mode='Markdown')

async def share_list_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Formats list for sharing via callback."""
    query = update.callback_query
    await query.answer()
    user = update.effective_user
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == user.id,
                Inventory.quantity <= 2 
            )
        )
        items = result.scalars().all()

    if not items:
        await query.message.reply_text("Ro'yxat bo'sh.")
        return

    msg = f"🛒 **{user.first_name}dan bozorlik ro'yxati:**\n\n"
    for item in items:
        msg += f"- {item.item_name.capitalize()}\n"

    # Send as a new message so it can be forwarded easily
    await query.message.reply_text(msg, parse_mode='Markdown')
    # Bring back menu
    await shopping_menu(update, context)

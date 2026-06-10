from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardMarkup
from telegram.ext import ContextTypes, ConversationHandler
from database.db import AsyncSessionLocal
from database.models import Inventory, User
from sqlalchemy import select
from data.items import ITEMS_UZ, QUANTITIES
import re

# States for inventory conversation
SELECT_CATEGORY, SELECT_ITEM, SELECT_QUANTITY = range(3)
# States for photo upload
PHOTO_ITEM_NAME, PHOTO_SAVE = range(10, 12)

async def inventory_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows the inventory sub-menu."""
    query = update.callback_query
    await query.answer()
    
    buttons = [
        [InlineKeyboardButton("➕ Qo'shish (Add)", callback_data='inv_add')],
        [InlineKeyboardButton("➖ Ishlatish (Use)", callback_data='inv_use')],
        [InlineKeyboardButton("📄 Ro'yxat (List)", callback_data='inv_list')],
        [InlineKeyboardButton("🖼️ Rasm yuklash (Upload Photo)", callback_data='inv_upload_photo')],
        [InlineKeyboardButton("⬅️ Ortga (Back)", callback_data='main_menu')]
    ]
    await query.edit_message_text(
        text="📦 **Ombor boshqaruvi:**\nNima qilmoqchisiz?", 
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode='Markdown'
    )

async def add_item_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Starts add item flow by showing categories."""
    query = update.callback_query
    await query.answer()
    
    context.user_data['action'] = 'add'
    
    buttons = []
    row = []
    for category in ITEMS_UZ.keys():
        row.append(InlineKeyboardButton(category, callback_data=f"cat_{category}"))
        if len(row) == 2:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
    
    buttons.append([InlineKeyboardButton("⬅️ Ortga", callback_data='menu_inventory')])
    
    await query.edit_message_text(
        text="📂 **Bo'limni tanlang:**",
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode='Markdown'
    )
    return SELECT_CATEGORY

async def use_item_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Starts use item flow (reuse add flow logic but set action=use)."""
    # For MVP, 'use' flow can mirror 'add' flow to select item/qty
    await add_item_start(update, context)
    context.user_data['action'] = 'use'
    return SELECT_CATEGORY

async def select_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows items in selected category."""
    query = update.callback_query
    await query.answer()
    
    category = query.data.replace("cat_", "")
    context.user_data['category'] = category
    
    items = ITEMS_UZ.get(category, [])
    
    buttons = []
    row = []
    for item in items:
        row.append(InlineKeyboardButton(item, callback_data=f"item_{item}"))
        if len(row) == 2:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
        
    buttons.append([InlineKeyboardButton("⬅️ Ortga", callback_data='inv_add' if context.user_data['action'] == 'add' else 'inv_use')])
    
    await query.edit_message_text(
        text=f"🍎 **{category}** - Mahsulotni tanlang:",
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode='Markdown'
    )
    return SELECT_ITEM

async def select_item(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows quantity options for selected item."""
    query = update.callback_query
    await query.answer()
    
    item_name = query.data.replace("item_", "")
    context.user_data['item_name'] = item_name
    
    buttons = []
    row = []
    for label, qty, unit in QUANTITIES:
        # Pass qty and unit in callback data
        row.append(InlineKeyboardButton(label, callback_data=f"qty_{qty}_{unit}"))
        if len(row) == 3:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
    
    buttons.append([InlineKeyboardButton("✏️ Boshqa (Yozish)", callback_data="qty_manual")])
    buttons.append([InlineKeyboardButton("⬅️ Ortga", callback_data=f"cat_{context.user_data.get('category')} ")])

    action_text = "qo'shmoqchisiz" if context.user_data['action'] == 'add' else "ishlatdingiz"
    await query.edit_message_text(
        text=f"⚖️ **{item_name}** - Qancha {action_text}?",
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode='Markdown'
    )
    return SELECT_QUANTITY

async def save_item(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Saves the item with selected quantity."""
    query = update.callback_query
    await query.answer()
    
    data = query.data
    
    if data == "qty_manual":
        await query.edit_message_text("⌨️ Miqdorni yozib yuboring (Masalan: 7.5 kg):")
        return SELECT_QUANTITY # Wait for text input

    # Parse qty_1_kg
    _, qty_str, unit = data.split("_")
    quantity = float(qty_str)
    
    return await process_transaction(update, context, quantity, unit)

async def receive_manual_quantity(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handles manually typed quantity."""
    text = update.message.text
    match = re.search(r'(\d+(\.\d+)?)\s*([a-zA-Z]+)?', text)
    if match:
        quantity = float(match.group(1))
        unit = match.group(3) or "dona"
    else:
        await update.message.reply_text("❌ Tushunarsiz miqdor. Qaytadan kiriting (Masalan: 5 kg):")
        return SELECT_QUANTITY
    
    return await process_transaction(update, context, quantity, unit)

async def process_transaction(update: Update, context: ContextTypes.DEFAULT_TYPE, quantity, unit):
    """Common logic to update DB."""
    user = update.effective_user
    item_name = context.user_data.get('item_name')
    category = context.user_data.get('category')
    action = context.user_data.get('action')
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == user.id,
                Inventory.item_name == item_name
            )
        )
        existing_item = result.scalar_one_or_none()

        if action == 'add':
            if existing_item:
                existing_item.quantity += quantity
                msg = f"✅ **{item_name}** yangilandi: {existing_item.quantity} {unit}."
            else:
                new_item = Inventory(
                    user_id=user.id,
                    item_name=item_name,
                    category=category,
                    quantity=quantity,
                    unit=unit
                )
                session.add(new_item)
                msg = f"✅ **{item_name}** qo'shildi: {quantity} {unit}."
        
        elif action == 'use':
            if existing_item:
                existing_item.quantity -= quantity
                if existing_item.quantity < 0: existing_item.quantity = 0
                msg = f"📉 **{item_name}** kamaydi: {existing_item.quantity} {unit} qoldi."
            else:
                msg = f"❌ **{item_name}** omborda yo'q edi."
        
        await session.commit()

    # Success message with Main Menu button
    keyboard = [
        [InlineKeyboardButton("➕ Yana davom etish", callback_data=f'inv_{action}')],
        [InlineKeyboardButton("⬅️ Asosiy menyu", callback_data='main_menu')]
    ]
    
    if update.callback_query:
        await update.callback_query.edit_message_text(msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
    else:
        await update.message.reply_text(msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
    
    return ConversationHandler.END

from services.image_generator import generate_inventory_image
import os

async def upload_photo_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Starts the photo upload flow."""
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("📸 Iltimos, mahsulot uchun rasmni yuboring (Basket ko'rinishida).")
    return PHOTO_SAVE

async def receive_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Saves the uploaded photo temporarily."""
    photo_file = await update.message.photo[-1].get_file()
    
    # Save to a temp path
    output_dir = "uybeka_bot/data/icons"
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    # We don't know the name yet, save as temp ID
    file_path = os.path.join(output_dir, f"temp_{update.effective_user.id}.jpg")
    await photo_file.download_to_drive(file_path)
    
    await update.message.reply_text("✅ Rasm qabul qilindi!\n\nEndi bu qaysi mahsulot ekanligini yozing (Masalan: Sabzi).")
    return PHOTO_ITEM_NAME

async def receive_photo_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Renames the photo to the item name."""
    item_name = update.message.text.strip().capitalize()
    output_dir = "uybeka_bot/data/icons"
    
    temp_path = os.path.join(output_dir, f"temp_{update.effective_user.id}.jpg")
    final_path = os.path.join(output_dir, f"{item_name}_basket.jpg")
    
    if os.path.exists(temp_path):
        if os.path.exists(final_path):
            os.remove(final_path) # Overwrite existing
        os.rename(temp_path, final_path)
        
        await update.message.reply_text(
            f"✅ **{item_name}** rasmi saqlandi!\nEndi ro'yxatda shu rasm ko'rinadi.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Asosiy menyu", callback_data='main_menu')]]),
            parse_mode='Markdown'
        )
    else:
        await update.message.reply_text("❌ Xatolik: Rasm topilmadi. Boshqatdan urinib ko'ring.")
        
    return ConversationHandler.END

async def stock_list_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Shows stock list via callback with VISUAL image."""
    query = update.callback_query
    await query.answer()
    user = update.effective_user
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Inventory).where(Inventory.user_id == user.id))
        items = result.scalars().all()

    if not items:
        msg = "📦 Omboringiz bo'sh."
        await query.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Ortga", callback_data='menu_inventory')]]))
        return

    # Generate Image
    image_path = generate_inventory_image(items, user_name=user.first_name)
    
    # Send Image
    # Note: We can't 'edit' a text message into an image easily, so we delete the old one and send new
    await query.message.delete()
    
    buttons = [[InlineKeyboardButton("⬅️ Ortga (Menu)", callback_data='menu_inventory')]]
    
    with open(image_path, 'rb') as photo:
        await context.bot.send_photo(
            chat_id=update.effective_chat.id,
            photo=photo,
            caption="🏠 **Sizning virtual omboringiz:**",
            parse_mode='Markdown',
            reply_markup=InlineKeyboardMarkup(buttons)
        )
    
    # Clean up
    try:
        os.remove(image_path)
    except:
        pass

async def cancel_inventory(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Bekor qilindi.")
    return ConversationHandler.END

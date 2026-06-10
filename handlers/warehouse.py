import logging
import datetime
try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    from backports.zoneinfo import ZoneInfo

from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton, ForceReply, WebAppInfo
from telegram.ext import ContextTypes
from sqlalchemy import select

from database.db import AsyncSessionLocal
from database.models import (
    ProductCategory, StockItem, StockTransaction, ReminderSubscriber, User,
)
from config import WEBAPP_URL, ADMIN_ID

logger = logging.getLogger(__name__)
TZ = ZoneInfo("Asia/Tashkent")

ICON_TUR, ICON_SUB, ICON_MODEL = "📁", "🗂", "📌"
PRESETS = [1, 2, 5, 10, 20, 50]


# ─── Access ─────────────────────────────────────────────────────────────────

async def is_approved(telegram_id: int) -> bool:
    if telegram_id == ADMIN_ID:
        return True
    async with AsyncSessionLocal() as s:
        u = (await s.execute(select(User).where(User.telegram_id == telegram_id))).scalar_one_or_none()
        return bool(u and u.status == "approved")


# ─── DB helpers ─────────────────────────────────────────────────────────────

async def _children(session, parent_id):
    stmt = select(ProductCategory).where(
        ProductCategory.parent_id.is_(None) if parent_id in (None, 0)
        else ProductCategory.parent_id == parent_id,
        ProductCategory.deleted_at.is_(None),
    ).order_by(ProductCategory.name)
    return (await session.execute(stmt)).scalars().all()


async def _node(session, node_id):
    return (await session.execute(
        select(ProductCategory).where(ProductCategory.id == node_id)
    )).scalar_one_or_none()


async def _is_leaf(session, node_id):
    return len(await _children(session, node_id)) == 0


async def _stock(session, leaf_id) -> int:
    si = (await session.execute(
        select(StockItem).where(StockItem.category_id == leaf_id)
    )).scalar_one_or_none()
    return si.quantity if si else 0


async def _breadcrumb(session, node_id):
    """Returns 'NAKITKA › Ali cantara safir' for a node."""
    parts = []
    cur = await _node(session, node_id) if node_id not in (None, 0) else None
    while cur is not None:
        parts.append(cur.name)
        cur = await _node(session, cur.parent_id) if cur.parent_id else None
    return " › ".join(reversed(parts))


async def _apply_stock(session, leaf_id, delta, user):
    si = (await session.execute(
        select(StockItem).where(StockItem.category_id == leaf_id)
    )).scalar_one_or_none()
    current = si.quantity if si else 0
    new_qty = max(0, current + delta)
    if si:
        si.quantity = new_qty
    else:
        session.add(StockItem(category_id=leaf_id, quantity=new_qty))
    session.add(StockTransaction(
        category_id=leaf_id, delta=delta,
        performed_by=user.id,
        performed_by_name=user.first_name or user.username or "Noma'lum",
        action_type="stock",
    ))
    return new_qty


async def _descendants(session, root_id):
    """All non-deleted descendant ids including root."""
    ids, frontier = [root_id], [root_id]
    while frontier:
        kids = []
        for pid in frontier:
            for c in await _children(session, pid):
                ids.append(c.id)
                kids.append(c.id)
        frontier = kids
    return ids


# ─── Keyboards ──────────────────────────────────────────────────────────────

def main_menu_keyboard(include_webapp=True):
    rows = [
        [InlineKeyboardButton("➕ Kirish", callback_data="w:io:in:0"),
         InlineKeyboardButton("➖ Chiqish", callback_data="w:io:out:0")],
        [InlineKeyboardButton("📋 Hisobot", callback_data="w:rep:all")],
        [InlineKeyboardButton("📦 Mahsulotlar", callback_data="w:prod:0")],
    ]
    if include_webapp and WEBAPP_URL:
        rows.append([InlineKeyboardButton("📱 Ilovani ochish", web_app=WebAppInfo(url=WEBAPP_URL))])
    return InlineKeyboardMarkup(rows)


async def show_main_menu(update, context, edit=False):
    text = "🏭 *Sklat*\n\nNima qilmoqchisiz?"
    kb = main_menu_keyboard()
    q = update.callback_query
    if edit and q:
        await q.edit_message_text(text, reply_markup=kb, parse_mode="Markdown")
    else:
        target = q.message if q else update.message
        await target.reply_text(text, reply_markup=kb, parse_mode="Markdown")


# ─── Kirish / Chiqish browse ──────────────────────────────────────────────────

async def _render_browse(query, session, direction, parent_id):
    children = await _children(session, parent_id)
    dir_label = "➕ Kirish" if direction == "in" else "➖ Chiqish"
    crumb = await _breadcrumb(session, parent_id) if parent_id not in (None, 0) else "Asosiy"

    rows = []
    for c in children:
        leaf = await _is_leaf(session, c.id)
        if leaf:
            qty = await _stock(session, c.id)
            rows.append([InlineKeyboardButton(
                f"{ICON_MODEL} {c.name}  ·  {qty} dona",
                callback_data=f"w:leaf:{direction}:{c.id}:1")])
        else:
            icon = ICON_TUR if parent_id in (None, 0) else ICON_SUB
            rows.append([InlineKeyboardButton(
                f"{icon} {c.name}  ›",
                callback_data=f"w:io:{direction}:{c.id}")])

    # Back button
    if parent_id in (None, 0):
        rows.append([InlineKeyboardButton("⬅️ Asosiy menyu", callback_data="w:home")])
    else:
        node = await _node(session, parent_id)
        back_to = node.parent_id or 0
        rows.append([InlineKeyboardButton("⬅️ Orqaga", callback_data=f"w:io:{direction}:{back_to}")])

    text = f"*{dir_label}*\n📍 {crumb}\n\n"
    text += "Mahsulotni tanlang:" if children else "Bu yerda mahsulot yo'q."
    await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), parse_mode="Markdown")


def _qty_keyboard(direction, leaf_id, qty):
    rows = [
        [InlineKeyboardButton("➖", callback_data=f"w:q:{direction}:{leaf_id}:{max(1, qty-1)}"),
         InlineKeyboardButton(f"{qty} dona", callback_data="w:noop"),
         InlineKeyboardButton("➕", callback_data=f"w:q:{direction}:{leaf_id}:{qty+1}")],
        [InlineKeyboardButton(str(p), callback_data=f"w:q:{direction}:{leaf_id}:{p}") for p in PRESETS[:3]],
        [InlineKeyboardButton(str(p), callback_data=f"w:q:{direction}:{leaf_id}:{p}") for p in PRESETS[3:]],
        [InlineKeyboardButton("✅ Saqlash", callback_data=f"w:save:{direction}:{leaf_id}:{qty}")],
    ]
    return rows


async def _render_qty(query, session, direction, leaf_id, qty):
    node = await _node(session, leaf_id)
    if not node:
        return
    crumb = await _breadcrumb(session, leaf_id)
    cur = await _stock(session, leaf_id)
    dir_label = "➕ Kirish" if direction == "in" else "➖ Chiqish"

    rows = _qty_keyboard(direction, leaf_id, qty)
    back_to = node.parent_id or 0
    rows.append([InlineKeyboardButton("⬅️ Orqaga", callback_data=f"w:io:{direction}:{back_to}")])

    text = (f"*{dir_label}*\n📍 {crumb}\n\n"
            f"Hozirgi zaxira: *{cur} dona*\n\n"
            f"Nechta {'qo`shasiz' if direction=='in' else 'chiqarasiz'}?")
    await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), parse_mode="Markdown")


# ─── Hisobot ────────────────────────────────────────────────────────────────

def _fmt_dt(dt: datetime.datetime):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    t = dt.astimezone(TZ)
    now = datetime.datetime.now(TZ)
    MONTHS = ['', 'Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek']
    if t.date() == now.date():
        day = "Bugun"
    elif t.date() == (now - datetime.timedelta(days=1)).date():
        day = "Kecha"
    else:
        day = f"{t.day} {MONTHS[t.month]}"
    return f"{day}, {t:%H:%M}"


async def _render_report(query, session, period):
    now = datetime.datetime.now(TZ)
    stmt = (select(StockTransaction, ProductCategory.name)
            .join(ProductCategory, ProductCategory.id == StockTransaction.category_id)
            .order_by(StockTransaction.created_at.desc())
            .limit(60))
    rows_db = (await session.execute(stmt)).all()

    def in_period(dt):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        t = dt.astimezone(TZ)
        if period == "week":
            return t >= now - datetime.timedelta(days=7)
        if period == "month":
            return t.year == now.year and t.month == now.month
        return True

    entries = [(tx, name) for tx, name in rows_db if in_period(tx.created_at)]

    labels = {"all": "Hammasi", "week": "Hafta", "month": "Oy"}
    lines = [f"📋 *Hisobot — {labels[period]}*\n"]
    if not entries:
        lines.append("_Harakat yo'q._")
    else:
        for tx, name in entries[:40]:
            who = tx.performed_by_name or "Noma'lum"
            if tx.action_type == "delete":
                lines.append(f"🗑 {name} — _o'chirildi_ ({who}, {_fmt_dt(tx.created_at)})")
            else:
                sign = "➕" if tx.delta > 0 else "➖"
                lines.append(f"{sign} *{name}*  {abs(tx.delta)}  ·  {who}  ·  {_fmt_dt(tx.created_at)}")

    tabs = [InlineKeyboardButton(("• " if period == p else "") + labels[p],
                                 callback_data=f"w:rep:{p}") for p in ("all", "week", "month")]
    kb = InlineKeyboardMarkup([tabs, [InlineKeyboardButton("⬅️ Asosiy menyu", callback_data="w:home")]])
    await query.edit_message_text("\n".join(lines), reply_markup=kb, parse_mode="Markdown")


# ─── Mahsulotlar (management) ──────────────────────────────────────────────────

async def _render_products(query, session, parent_id):
    children = await _children(session, parent_id)
    rows = []

    if parent_id in (None, 0):
        title = "📦 *Mahsulotlar*\n\nTur tanlang yoki yangi qo'shing:"
        for c in children:
            rows.append([
                InlineKeyboardButton(f"{ICON_TUR} {c.name}", callback_data=f"w:prod:{c.id}"),
                InlineKeyboardButton("🗑", callback_data=f"w:del1:{c.id}"),
            ])
        rows.append([InlineKeyboardButton("➕ Yangi tur qo'shish", callback_data="w:addask:0")])
        rows.append([InlineKeyboardButton("⬅️ Asosiy menyu", callback_data="w:home")])
    else:
        node = await _node(session, parent_id)
        crumb = await _breadcrumb(session, parent_id)
        depth_is_root_child = node.parent_id in (None, 0)
        title = f"📦 *{crumb}*\n\n"
        for c in children:
            leaf = await _is_leaf(session, c.id)
            icon = ICON_MODEL if leaf else ICON_SUB
            cb = f"w:del1:{c.id}" if leaf else f"w:prod:{c.id}"
            label = f"{icon} {c.name}" + ("" if leaf else "  ›")
            rows.append([
                InlineKeyboardButton(label, callback_data=cb),
                InlineKeyboardButton("🗑", callback_data=f"w:del1:{c.id}"),
            ])
        add_label = "➕ Sub-tur qo'shish" if depth_is_root_child else "➕ Model qo'shish"
        rows.append([InlineKeyboardButton(add_label, callback_data=f"w:addask:{parent_id}")])
        back_to = node.parent_id or 0
        rows.append([InlineKeyboardButton("⬅️ Orqaga", callback_data=f"w:prod:{back_to}")])
        if not children:
            title += "_Hali bo'sh._"

    await query.edit_message_text(title, reply_markup=InlineKeyboardMarkup(rows), parse_mode="Markdown")


async def _render_delete1(query, session, node_id):
    node = await _node(session, node_id)
    if not node:
        await query.answer("Topilmadi", show_alert=True)
        return
    ids = await _descendants(session, node_id)
    # leaves & their stock
    total = 0
    leaf_lines = []
    for cid in ids:
        if await _is_leaf(session, cid):
            qty = await _stock(session, cid)
            total += qty
            n = await _node(session, cid)
            leaf_lines.append(f"• {n.name}" + (f" — *{qty} dona*" if qty else ""))

    text = f"🗑 *O'chirishni tasdiqlang*\n\n\"*{node.name}*\" o'chiriladi."
    if len(ids) > 1:
        text += f"\nIchidagi {len(ids)-1} ta element ham o'chadi:"
    if leaf_lines:
        text += "\n" + "\n".join(leaf_lines)
    if total > 0:
        text += f"\n\n⚠️ Jami *{total} dona* sklatdan chiqariladi."

    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("Davom etish ▶️", callback_data=f"w:del2:{node_id}")],
        [InlineKeyboardButton("⬅️ Bekor", callback_data=f"w:prod:{node.parent_id or 0}")],
    ])
    await query.edit_message_text(text, reply_markup=kb, parse_mode="Markdown")


async def _render_delete2(query, session, node_id):
    node = await _node(session, node_id)
    if not node:
        return
    ids = await _descendants(session, node_id)
    total = 0
    for cid in ids:
        if await _is_leaf(session, cid):
            total += await _stock(session, cid)
    text = (f"⚠️ *Ishonchingiz komilmi?*\n\n"
            f"\"*{node.name}*\""
            + (f" va *{total} dona* mahsulot" if total else "")
            + " butunlay o'chib ketadi. Buni qaytarib bo'lmaydi.")
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Ha, o'chirish", callback_data=f"w:delyes:{node_id}")],
        [InlineKeyboardButton("⬅️ Yo'q, bekor", callback_data=f"w:prod:{node.parent_id or 0}")],
    ])
    await query.edit_message_text(text, reply_markup=kb, parse_mode="Markdown")


async def _do_delete(session, node_id, user):
    node = await _node(session, node_id)
    parent_id = node.parent_id or 0
    ids = await _descendants(session, node_id)
    now = datetime.datetime.now(datetime.timezone.utc)
    for cid in ids:
        if await _is_leaf(session, cid):
            qty = await _stock(session, cid)
            session.add(StockTransaction(
                category_id=cid, delta=-qty,
                performed_by=user.id,
                performed_by_name=user.first_name or user.username or "Noma'lum",
                action_type="delete",
            ))
            si = (await session.execute(
                select(StockItem).where(StockItem.category_id == cid))).scalar_one_or_none()
            if si:
                si.quantity = 0
        n = await _node(session, cid)
        n.deleted_at = now
    return parent_id


# ─── Add name via ForceReply ──────────────────────────────────────────────────

async def ask_new_name(query, context, parent_id):
    context.user_data["add_parent"] = parent_id
    if parent_id in (None, 0):
        prompt = "✏️ Yangi *tur* nomini kiriting (masalan: Nakitka):"
    else:
        async with AsyncSessionLocal() as s:
            node = await _node(s, parent_id)
            is_root_child = node.parent_id in (None, 0)
        prompt = (f"✏️ *{'Sub-tur' if is_root_child else 'Model'}* nomini kiriting:")
    await query.message.reply_text(
        prompt, parse_mode="Markdown",
        reply_markup=ForceReply(input_field_placeholder="Nom..."),
    )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Captures ForceReply replies for adding a new category."""
    if "add_parent" not in context.user_data:
        return
    if not await is_approved(update.effective_user.id):
        context.user_data.pop("add_parent", None)
        return

    parent_id = context.user_data.pop("add_parent")
    name = (update.message.text or "").strip()
    if not name:
        await update.message.reply_text("❌ Bo'sh nom. Qaytadan urinib ko'ring.")
        return

    pid = None if parent_id in (None, 0) else parent_id
    async with AsyncSessionLocal() as s:
        dup = (await s.execute(select(ProductCategory).where(
            ProductCategory.name == name,
            (ProductCategory.parent_id.is_(None) if pid is None else ProductCategory.parent_id == pid),
            ProductCategory.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if dup:
            await update.message.reply_text(f"❌ \"{name}\" allaqachon mavjud.")
            return
        s.add(ProductCategory(name=name, parent_id=pid))
        await s.commit()

    kb = InlineKeyboardMarkup([[InlineKeyboardButton("📦 Mahsulotlarga qaytish",
                                                     callback_data=f"w:prod:{parent_id}")]])
    await update.message.reply_text(f"✅ \"{name}\" qo'shildi!", reply_markup=kb)


# ─── Callback router ──────────────────────────────────────────────────────────

async def router(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    user = update.effective_user

    if not await is_approved(user.id):
        await query.answer("Ruxsat yo'q.", show_alert=True)
        return

    if data == "w:noop":
        await query.answer()
        return

    await query.answer()
    parts = data.split(":")
    kind = parts[1]

    async with AsyncSessionLocal() as session:
        if kind == "home":
            await show_main_menu(update, context, edit=True)

        elif kind == "io":            # w:io:<dir>:<parent_id>
            direction, pid = parts[2], int(parts[3])
            await _render_browse(query, session, direction, pid)

        elif kind == "leaf":          # w:leaf:<dir>:<id>:<qty>
            direction, lid, qty = parts[2], int(parts[3]), int(parts[4])
            await _render_qty(query, session, direction, lid, qty)

        elif kind == "q":             # w:q:<dir>:<id>:<qty>
            direction, lid, qty = parts[2], int(parts[3]), int(parts[4])
            await _render_qty(query, session, direction, lid, qty)

        elif kind == "save":          # w:save:<dir>:<id>:<qty>
            direction, lid, qty = parts[2], int(parts[3]), int(parts[4])
            delta = qty if direction == "in" else -qty
            new_qty = await _apply_stock(session, lid, delta, user)
            await session.commit()
            node = await _node(session, lid)
            sign = "➕" if direction == "in" else "➖"
            kb = InlineKeyboardMarkup([
                [InlineKeyboardButton("🔁 Yana", callback_data=f"w:io:{direction}:{node.parent_id or 0}")],
                [InlineKeyboardButton("⬅️ Asosiy menyu", callback_data="w:home")],
            ])
            await query.edit_message_text(
                f"✅ *{node.name}*\n{sign} {qty} dona\nJami: *{new_qty} dona*",
                reply_markup=kb, parse_mode="Markdown")

        elif kind == "rep":           # w:rep:<period>
            await _render_report(query, session, parts[2])

        elif kind == "prod":          # w:prod:<parent_id>
            await _render_products(query, session, int(parts[2]))

        elif kind == "addask":        # w:addask:<parent_id>
            await ask_new_name(query, context, int(parts[2]))

        elif kind == "del1":
            await _render_delete1(query, session, int(parts[2]))

        elif kind == "del2":
            await _render_delete2(query, session, int(parts[2]))

        elif kind == "delyes":
            parent_id = await _do_delete(session, int(parts[2]), user)
            await session.commit()
            await _render_products(query, session, parent_id)


# ─── Daily reminder ───────────────────────────────────────────────────────────

async def _stock_summary(session) -> str:
    cats = (await session.execute(
        select(ProductCategory).where(ProductCategory.deleted_at.is_(None))
    )).scalars().all()
    if not cats:
        return "📦 Sklat bo'sh."
    children_of = {}
    for c in cats:
        children_of.setdefault(c.parent_id, []).append(c)
    parents = {c.parent_id for c in cats if c.parent_id is not None}

    lines = ["📦 *Sklat holati:*\n"]
    async def walk(node, level):
        indent = "  " * level
        if node.id not in parents:  # leaf
            qty = await _stock(session, node.id)
            lines.append(f"{indent}└ {node.name}: *{qty} dona*")
        else:
            lines.append(f"{indent}*{node.name}*")
            for ch in sorted(children_of.get(node.id, []), key=lambda x: x.name):
                await walk(ch, level + 1)
    for root in sorted(children_of.get(None, []), key=lambda x: x.name):
        await walk(root, 0)
    return "\n".join(lines)


async def send_daily_reminder(context: ContextTypes.DEFAULT_TYPE):
    async with AsyncSessionLocal() as session:
        subs = (await session.execute(select(ReminderSubscriber))).scalars().all()
        if not subs:
            return
        text = "🌅 *Kunlik eslatma*\n\n" + await _stock_summary(session)
    for sub in subs:
        try:
            await context.bot.send_message(sub.chat_id, text, parse_mode="Markdown")
        except Exception as e:
            logger.warning("Reminder failed for %s: %s", sub.chat_id, e)

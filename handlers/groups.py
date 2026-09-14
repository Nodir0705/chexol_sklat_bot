"""`/ulash` — bind a Telegram group to a client in the ledger.

The owner runs /ulash inside the client's group; the bot answers with the group
title and a 6-character code. That code is typed into the Mini App against a
client, which sets `clients.telegram_chat_id`. Codes live 15 minutes and are
single-use (spec §4).

The codes table is created lazily here rather than in `database/models.py`
because it holds nothing worth keeping — it is a short-lived handshake, not
business data.
"""

import html
import logging
import secrets
from datetime import datetime, timedelta, timezone

from telegram import Update
from telegram.constants import ChatMemberStatus, ChatType
from telegram.ext import ContextTypes
from sqlalchemy import text

from database.db import engine
from config import ADMIN_ID, APPROVED_IDS

logger = logging.getLogger(__name__)

CODE_TTL_MINUTES = 15
CODE_LENGTH = 6
# No O/0 and no I/1 — the code is read off one phone screen and typed into another.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# SQLite has no datetime type: store text that matches CURRENT_TIMESTAMP, so it
# sorts lexicographically and reads the same from Python and from node:sqlite.
_TS_FMT = "%Y-%m-%d %H:%M:%S"

_GROUP_CHATS = (ChatType.GROUP, ChatType.SUPERGROUP)

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS group_link_codes (
    code       TEXT PRIMARY KEY,
    chat_id    INTEGER NOT NULL,
    title      TEXT,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME NULL
)
"""
_CREATE_INDEX = (
    "CREATE INDEX IF NOT EXISTS ix_group_link_codes_chat_id "
    "ON group_link_codes (chat_id)"
)


# ─── Errors ────────────────────────────────────────────────────────────────────

class LinkCodeError(Exception):
    """A /ulash code could not be redeemed. `.message` is Uzbek, safe to show."""

    message = "Kod yaroqsiz."

    def __init__(self, message=None):
        self.message = message or type(self).message
        super().__init__(self.message)


class UnknownCodeError(LinkCodeError):
    message = "Bunday kod topilmadi."


class ExpiredCodeError(LinkCodeError):
    message = "Kod muddati tugagan. Guruhda /ulash ni qayta yuboring."


class UsedCodeError(LinkCodeError):
    message = "Bu kod allaqachon ishlatilgan."


# ─── Storage ───────────────────────────────────────────────────────────────────

_table_ready = False


async def _ensure_table():
    """Create `group_link_codes` on first use. Idempotent, cheap after the first call."""
    global _table_ready
    if _table_ready:
        return
    async with engine.begin() as conn:
        await conn.execute(text(_CREATE_TABLE))
        await conn.execute(text(_CREATE_INDEX))
    _table_ready = True


def _stamp(when=None):
    return (when or datetime.now(timezone.utc)).strftime(_TS_FMT)


def _new_code():
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalise_code(code):
    """Owners retype codes by hand: accept lowercase and stray spaces/dashes."""
    return "".join(str(code or "").split()).replace("-", "").upper()


async def issue_code(chat_id, title):
    """Mint a fresh single-use code for `chat_id`, retiring any earlier live one."""
    await _ensure_table()
    now = datetime.now(timezone.utc)
    now_s = _stamp(now)
    expires_s = _stamp(now + timedelta(minutes=CODE_TTL_MINUTES))
    # Keep long-dead rows out of the table, but leave recently expired ones so a
    # late redeem still says "muddati tugagan" rather than "topilmadi".
    cutoff_s = _stamp(now - timedelta(hours=1))

    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM group_link_codes WHERE expires_at < :cutoff"),
            {"cutoff": cutoff_s},
        )
        # One live code per group — issuing a new one invalidates the previous.
        await conn.execute(
            text(
                "UPDATE group_link_codes SET used_at = :now "
                "WHERE chat_id = :chat_id AND used_at IS NULL"
            ),
            {"now": now_s, "chat_id": chat_id},
        )
        for _ in range(6):
            code = _new_code()
            taken = await conn.execute(
                text("SELECT 1 FROM group_link_codes WHERE code = :code"),
                {"code": code},
            )
            if taken.first() is not None:
                continue
            await conn.execute(
                text(
                    "INSERT INTO group_link_codes (code, chat_id, title, expires_at, used_at) "
                    "VALUES (:code, :chat_id, :title, :expires_at, NULL)"
                ),
                {"code": code, "chat_id": chat_id, "title": title, "expires_at": expires_s},
            )
            logger.info("Link code issued for chat %s (%s)", chat_id, title)
            return code

    raise LinkCodeError("Kod yaratib bo'lmadi, qayta urinib ko'ring.")


async def redeem_code(code, client_id):
    """Validate and consume `code`, returning the group chat_id to bind to `client_id`.

    Raises UnknownCodeError / ExpiredCodeError / UsedCodeError. The caller writes
    `clients.telegram_chat_id`; this function only hands over the chat_id.
    """
    await _ensure_table()
    normalised = normalise_code(code)
    if not normalised:
        raise UnknownCodeError()

    now_s = _stamp()
    async with engine.begin() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT chat_id, title, expires_at, used_at "
                    "FROM group_link_codes WHERE code = :code"
                ),
                {"code": normalised},
            )
        ).first()

        if row is None:
            raise UnknownCodeError()
        if row.used_at is not None:
            raise UsedCodeError()
        if str(row.expires_at) <= now_s:
            raise ExpiredCodeError()

        # The `used_at IS NULL` guard, not the read above, is what makes this
        # single-use: two concurrent redeems race here and exactly one wins.
        result = await conn.execute(
            text(
                "UPDATE group_link_codes SET used_at = :now "
                "WHERE code = :code AND used_at IS NULL"
            ),
            {"now": now_s, "code": normalised},
        )
        if result.rowcount != 1:
            raise UsedCodeError()

    chat_id = int(row.chat_id)
    logger.info("Link code %s redeemed for client %s → chat %s", normalised, client_id, chat_id)
    return chat_id


# ─── Handlers ──────────────────────────────────────────────────────────────────

async def ulash(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/ulash — operator-only, group-only. Replies with the group title and a code."""
    chat = update.effective_chat
    user = update.effective_user
    message = update.effective_message
    if chat is None or message is None:
        return

    if chat.type not in _GROUP_CHATS:
        await message.reply_text("Bu buyruq faqat mijoz guruhida ishlaydi.")
        return

    # Linking a group hands the ledger a place to publish receipts, so the sender
    # is checked here — unlike the approve/reject callbacks, which trust whoever taps.
    #
    # Telegram group ownership is irrelevant: the gate is the bot's own operator
    # list. ADMIN_ID alone was too narrow — it locked out the person who actually
    # runs the warehouse whenever ADMIN_ID points at a different account.
    allowed = {i for i in ({ADMIN_ID} | set(APPROVED_IDS)) if i}
    if not allowed or user is None or user.id not in allowed:
        logger.warning(
            "Refused /ulash from user %s in chat %s", getattr(user, "id", None), chat.id
        )
        await message.reply_text("⛔️ Bu buyruq faqat sklat operatorlari uchun.")
        return

    title = chat.title or str(chat.id)
    try:
        code = await issue_code(chat.id, title)
    except Exception as e:
        logger.error("Could not issue link code for chat %s: %s", chat.id, e)
        await message.reply_text("Kod yaratib bo'lmadi. Birozdan keyin qayta urinib ko'ring.")
        return

    await message.reply_html(
        f"🔗 Guruh: <b>{html.escape(title)}</b>\n\n"
        f"Kod: <code>{code}</code>\n\n"
        "Ushbu kodni Mini App'da mijoz kartochkasiga kiriting — shundan keyin "
        "har bir berish, qaytarish va to'lov shu guruhga yoziladi.\n"
        f"⏳ Kod {CODE_TTL_MINUTES} daqiqa amal qiladi va faqat bir marta ishlatiladi."
    )


async def on_my_chat_member(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Bot added to a group → say once how to link it. Never raises."""
    member = update.my_chat_member
    if member is None or member.chat.type not in _GROUP_CHATS:
        return

    joined = (ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER)
    if member.old_chat_member.status in joined or member.new_chat_member.status not in joined:
        return

    try:
        await context.bot.send_message(
            member.chat.id,
            "Salom! Bu guruhni mijozga bog'lash uchun admin <b>/ulash</b> buyrug'ini yuborsin.",
            parse_mode="HTML",
        )
    except Exception as e:
        logger.warning("Could not greet chat %s: %s", member.chat.id, e)

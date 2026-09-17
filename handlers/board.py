"""Answering taps on the living board's inline keyboard (spec §"Tapping a row").

The board is ONE message per client group holding a grid of buttons — one row
per ledger movement — that every delivery appends to. Every button must carry
`callback_data`, and an unanswered callback query leaves a spinner turning on
the tapper's phone until Telegram gives up. The board has up to 27 buttons and
lives in a group with the CLIENT in it, so it will be tapped, often by accident.

So the contract of this module is narrow and absolute:

    every callback query it matches is answered exactly once, fast, and nothing
    here ever raises.

`callback_data` is `led:<ledger_id>` for a movement's name cell and for every
cell of a cancelled row, `edq:<id>` / `eds:<id>` for the DONA and SUMMA cells of
a live one, and `boardhdr` for the day separator, the fold row and the JAMI
total — the buttons that carry no detail and exist only because a button needs
data.

The IMAGE board (spec 2026-09-17-image-board) replaces that grid with ONE photo
and a fixed two-button keyboard — `bed:<client_id>` for ✏️ Tahrirlash and
`brp:<client_id>` for 📊 Hisobot. They name a CLIENT, not a movement, and they
are answered by the same machinery on the same terms: 📊 reads the tapper's own
account and is bound to the tapping chat exactly as a row is; ✏️ is the
board-level twin of `edq:`/`eds:` and carries the `b_<client_id>` deep link.

An `edq:` / `eds:` tap is answered by WHO TAPPED, and the gate runs on
`callback_query.from.id` — Telegram's own field, not the client-supplied
`callback_data` — BEFORE any url exists:

    operator  → answerCallbackQuery(url=t.me/<bot>?start=e_<client>_<id>_<q|s>),
                which opens the bot's PRIVATE chat, where a `web_app` button is
                legal (it is not, in a group keyboard) and opens the Mini App on
                that row.
    anyone    → the read-only toast for that row, byte-identical to what `led:`
    else        answers. No url, no state, no hint that an edit control exists.

The deep-link payload is a POINTER, NOT A CAPABILITY: `/start` re-runs the same
operator gate and re-derives everything from the ledger, so possession of the
link — which any group member can read off `reply_markup` and craft — authorises
nothing. There is no state table, nothing to expire, nothing to collect.

Formatting mirrors server/notify.js, which is the single naming and money rule for
the whole system: productLabel() qualifies a bare leaf, money uses U+00A0
separators, and stamps are Tashkent time. A tap and the receipt that was posted
for the same movement must say the same words about the same thing.
"""

import asyncio
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone

from telegram import (Update, InlineKeyboardButton, InlineKeyboardMarkup,
                      WebAppInfo)
from telegram.constants import ChatType
from telegram.ext import ContextTypes
from sqlalchemy import text as sql

from database.db import AsyncSessionLocal
from config import ADMIN_ID, APPROVED_IDS, WEBAPP_URL


def _app_url(query: str) -> str:
    """Mini App URL with an explicit path.

    WEBAPP_URL is a bare origin, so f"{WEBAPP_URL}?x=1" yields
    "https://host?x=1" -- legal, but the missing "/" is the kind of thing a
    URL normaliser in the middle quietly rewrites. Spell the path.
    """
    base = WEBAPP_URL.rstrip("/")
    return f"{base}/?{query}"
# The deep link's fallback: any /start this module does not claim — no payload,
# a malformed one, a non-operator, a row that may not be edited — is handed to
# the ordinary greeting untouched. handlers/start.py imports nothing from here,
# so the dependency runs one way only.
from handlers.start import start as _ordinary_start

logger = logging.getLogger(__name__)

# ─── Constants ─────────────────────────────────────────────────────────────────

CALLBACK_LEDGER = r"^led:\d+$"
CALLBACK_HEADER = r"^boardhdr$"
# The DONA and SUMMA cells of a live row. Fully anchored and disjoint from
# `led:`, `boardhdr`, `approve_` and `reject_` — no pattern in bot.py can shadow
# another, whatever order they are registered in (asserted by the shadow test).
CALLBACK_EDIT = r"^ed[qs]:\d+$"
# The image board's two BOARD-LEVEL buttons — the whole keyboard under the photo
# (spec §"Editing"). They carry the CLIENT id, not a ledger id, because the photo
# is the client's whole ledger and neither button names a row. Four-byte prefixes,
# matching server/board-grid.js's CB_* convention, fully anchored and disjoint
# from `led:`, `ed[qs]:`, `boardhdr`, `approve_` and `reject_`.
CALLBACK_BOARD_EDIT = r"^bed:\d+$"
CALLBACK_BOARD_REPORT = r"^brp:\d+$"

_LED_RE = re.compile(r"^led:(\d+)$")
# Bounded digits: an id is a SQLite rowid, and an unbounded \d+ would hand a
# 400-digit integer to the driver's binder rather than failing to match here.
_EDIT_RE = re.compile(r"^ed([qs]):(\d{1,18})$")
_BOARD_EDIT_RE = re.compile(r"^bed:(\d{1,18})$")
_BOARD_REPORT_RE = re.compile(r"^brp:(\d{1,18})$")
# The /start deep-link payload — (client_id, entry_id, field), 11 characters for
# real ids. Same bound, same reason.
_START_EDIT_RE = re.compile(r"^e_(\d{1,18})_(\d{1,18})_([qs])$")
# The board button's payload: one client, no row. Same bound, same reason.
_START_BOARD_RE = re.compile(r"^b_(\d{1,18})$")

# The one live prompt in an operator's private chat. `user_data` is in-memory
# and per-user: losing it on a restart costs one stale message and nothing else.
_EDIT_PROMPT_KEY = "edit_prompt"

# answerCallbackQuery caps `text` at 200 characters; over that Telegram rejects
# the answer outright, which is the spinner we are here to prevent.
ANSWER_MAX = 200
# A category name is owner-entered and unbounded. Trimmed before assembly so the
# figures — the part a dispute turns on — are never the thing that gets cut.
PRODUCT_MAX = 64
# A client name is owner-entered too, and the account toast spends the rest of
# its 200 on five figures. Same rule: the name yields, the money never does.
CLIENT_MAX = 24

# Telegram invalidates a callback query after ~15s. The ledger read is a primary
# key lookup, but database/db.py sets busy_timeout=5000, so a WAL writer could
# park us for five seconds. Cap it far below the window and answer with "try
# again" rather than not answering at all.
QUERY_TIMEOUT_S = 3.0

# UTC+5, no DST — the same constant server/notify.js carries, written the same
# way so neither side needs a tz database to agree with the other.
TASHKENT = timezone(timedelta(hours=5))

NBSP = " "
MINUS = "−"      # U+2212, the adjustment sign — not an ASCII hyphen
PATH_SEP = " › "  # U+203A, the separator productLabel() uses

# The owner-controlled emoji + verb for each ledger kind. Same table as
# KIND_UI in server/notify.js.
_KIND_UI = {
    "handover":   ("\U0001F4E6", "Berildi"),
    "return":     ("↩️", "Qaytarildi"),
    "payment":    ("\U0001F4B5", "To'landi"),
    "adjustment": ("✏️", "Tuzatish"),
}
_KIND_FALLBACK = _KIND_UI["adjustment"]

# Uzbek answers for everything that is not a row.
MSG_NOT_FOUND = "Bu qator topilmadi — o'chirilgan yoki eski bo'lishi mumkin."
MSG_FORBIDDEN = "Bu qator bu guruhga tegishli emas."
MSG_BUSY = "Hozir javob bera olmadim. Yana bir marta bosing."

# Operator-only answers. A non-operator never reaches them — the gate runs
# first and hands them the ordinary read toast — so they may speak plainly.
MSG_EDIT_LOCKED = "Bu qatorni tuzatib bo'lmaydi."
MSG_EDIT_NO_QTY = "Bu qatorda dona yo'q — faqat summani tuzatish mumkin."
# get_me() failed at startup, so there is no @username to build a link from.
# Editing is silently unavailable bot-wide; the Mini App still works.
MSG_EDIT_OFF = "Tahrirlash hozir ishlamayapti. Mini App orqali tuzating."

# The board-level buttons answer about an ACCOUNT, not a row, so they need their
# own "no such thing" — said the same way, revealing the same nothing.
MSG_ACCOUNT_NOT_FOUND = "Bu hisob topilmadi."
MSG_ACCOUNT_FORBIDDEN = "Bu hisob bu guruhga tegishli emas."
MSG_NO_MOVEMENT = "Bu oy harakat bo'lmadi."

# The month's name, and the four bucket labels — the same words and the same
# spelling server/statement.js prints on the monthly Hisobot workbook, because a
# client reads the toast and the spreadsheet as one document.
UZ_MONTHS = ("yanvar", "fevral", "mart", "aprel", "may", "iyun",
             "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr")

# Who may read a row outside the client's own group: the same operator list
# /ulash uses. `users.status='approved'` is deliberately NOT consulted — it
# would cost a second query inside a 15-second window, and an operator reading
# a board outside a client group is not a case that happens in practice.
_OPERATORS = {i for i in ({ADMIN_ID} | set(APPROVED_IDS)) if i}

# ─── The one query ─────────────────────────────────────────────────────────────
#
# A primary-key lookup. Every join is on an integer primary key and 1:1
# (product_categories twice for productLabel's parent, clients for the chat
# binding, client_ledger once more for the row a reversal cancels); the only
# subquery rides ix_client_ledger_reverses_id. One round trip, no scan.
#
# `client_chat_id` is what makes this safe to run in a client group: it is the
# ONLY thing that says whether the tapped row belongs to the client bound to
# THIS chat. It is read here, never shown.
_SELECT = """
SELECT l.id, l.client_id, l.kind, l.category_id, l.qty, l.unit_price,
       l.amount, l.performed_by_name, l.reverses_id, l.created_at,
       pc.name AS category_name,
       pp.name AS parent_name,
       cl.telegram_chat_id AS client_chat_id,
       cl.name AS client_name,
       cl.deleted_at AS client_deleted_at,
       o.kind AS orig_kind,
       o.created_at AS orig_created_at,
       (SELECT r.created_at FROM client_ledger r
         WHERE r.reverses_id = l.id LIMIT 1) AS reversed_at
  FROM client_ledger l
  LEFT JOIN product_categories pc ON pc.id = l.category_id
  LEFT JOIN product_categories pp ON pp.id = pc.parent_id
  LEFT JOIN clients cl           ON cl.id = l.client_id
  LEFT JOIN client_ledger o      ON o.id  = l.reverses_id
 WHERE l.id = :id
"""

# ─── The account query (the two board-level buttons) ───────────────────────────
#
# One round trip for everything both board buttons can ever need: the chat
# binding, the name, the all-time balance and this month's four buckets.
#
# THE MONTH RULE IS PORTED FROM server/statement.js monthSlice(), not invented
# here, because the same client reads this toast and the monthly Hisobot
# workbook and they must agree to the so'm:
#
#   * the window is Tashkent wall-clock, half-open:
#     `datetime(created_at,'+5 hours') >= :m_start AND < :m_next`. Shifting the
#     COLUMN rather than the bounds also normalises whatever the writer stored
#     ('T', a trailing 'Z', fractional seconds), which raw string comparison
#     would not.
#   * a row is bucketed by `COALESCE(o.kind, l.kind)` — a REVERSAL lands in the
#     bucket of the row it cancels, whatever kind it was written with, or the
#     buckets would not net to zero.
#   * returns and payments are stored negative and REPORTED POSITIVE; handovers
#     and adjustments keep their sign. Same four lines as the workbook.
#
# The balance is a separate scalar over the WHOLE ledger — `SUM(amount)`, the
# one definition of a balance in this system — never derived from the buckets,
# so the two cannot drift.
_SELECT_CLIENT = """
SELECT cl.id                  AS client_id,
       cl.name                AS client_name,
       cl.telegram_chat_id    AS client_chat_id,
       cl.deleted_at          AS client_deleted_at,
       (SELECT COALESCE(SUM(b.amount), 0) FROM client_ledger b
         WHERE b.client_id = cl.id)                    AS balance,
       COALESCE(m.given, 0)    AS given,
       COALESCE(m.returned, 0) AS returned,
       COALESCE(m.paid, 0)     AS paid,
       COALESCE(m.adjusted, 0) AS adjusted
  FROM clients cl
  LEFT JOIN (
        SELECT l.client_id AS client_id,
               SUM(CASE WHEN COALESCE(o.kind, l.kind) = 'handover'
                        THEN l.amount ELSE 0 END)  AS given,
               SUM(CASE WHEN COALESCE(o.kind, l.kind) = 'return'
                        THEN -l.amount ELSE 0 END) AS returned,
               SUM(CASE WHEN COALESCE(o.kind, l.kind) = 'payment'
                        THEN -l.amount ELSE 0 END) AS paid,
               SUM(CASE WHEN COALESCE(o.kind, l.kind)
                             NOT IN ('handover', 'return', 'payment')
                        THEN l.amount ELSE 0 END)  AS adjusted
          FROM client_ledger l
          LEFT JOIN client_ledger o ON o.id = l.reverses_id
         WHERE l.client_id = :id
           AND datetime(l.created_at, '+5 hours') >= :m_start
           AND datetime(l.created_at, '+5 hours') <  :m_next
         GROUP BY l.client_id
       ) m ON m.client_id = cl.id
 WHERE cl.id = :id
"""


# ─── Product naming (the Python side of notify.js productLabel) ────────────────

# o' / o‘ / o’ / oʻ / oʼ is ONE Uzbek letter typed five ways, plus the two
# keyboard stand-ins ` and ´. Unified before comparison, and kept INSIDE the
# token so "qo'shimcha" stays one word.
_APOSTROPHES = re.compile("[‘’ʻʼ`´]")


def _tokens(name):
    """Comparison tokens for a category name.

    NFC first — the same Uzbek name can arrive pre-composed or decomposed and
    must compare equal. Every non-alphanumeric except the apostrophe is a token
    break, so the decorative chrome an owner types ("!Tikuvda tarpetka💈")
    cannot affect matching.
    """
    s = _APOSTROPHES.sub("'", unicodedata.normalize("NFC", str(name or "")).lower())
    out, cur = [], []
    for ch in s:
        if ch.isalnum() or ch == "'":
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def _contains_run(hay, needle):
    """Is `needle` a CONTIGUOUS, in-order run inside `hay`? A subarray test."""
    n = len(needle)
    if not n or n > len(hay):
        return False
    return any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def product_label(category_name, parent_name):
    """"Parent › Leaf", except when the leaf already contains the parent.

    Six leaves live under two different parents in the real catalogue, so a
    bare leaf is unrecoverably ambiguous; repeating a parent the leaf already
    names reads as a stutter. Port of productLabel() in server/notify.js —
    keep the two identical.
    """
    leaf = str(category_name or "").strip()
    parent = str(parent_name or "").strip()
    if not leaf or not parent:
        return leaf
    return leaf if _contains_run(_tokens(leaf), _tokens(parent)) else parent + PATH_SEP + leaf


# ─── Money and time ────────────────────────────────────────────────────────────

def _money(value):
    """Integer so'm, U+00A0 thousands separators. Magnitude only: 2400000 → "2 400 000"."""
    try:
        n = abs(int(value or 0))
    except (TypeError, ValueError):
        n = 0
    return f"{n:,}".replace(",", NBSP)


def _som(value):
    """A figure with its unit attached, unbreakably."""
    return f"{_money(value)}{NBSP}so'm"


def _signed(value):
    """Adjustments are the one row whose direction no verb states."""
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        n = 0
    return f"{MINUS if n < 0 else '+'}{_money(n)}{NBSP}so'm"


def _to_dt(value):
    """A ledger timestamp as an aware UTC datetime.

    SQLite has no datetime type and this module reads through text(), which
    bypasses SQLAlchemy's type engine — so `created_at` arrives as the string
    CURRENT_TIMESTAMP wrote ("YYYY-MM-DD HH:MM:SS"), or with microseconds when
    SQLAlchemy stored a Python datetime, or as a datetime when a caller hands
    one over. Naive means UTC, which is what SQLite writes. Anything
    unparseable degrades to "now" rather than raising inside a callback answer.
    """
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value or "").strip()
        dt = None
        if s:
            if s.endswith(("Z", "z")):
                s = s[:-1] + "+00:00"
            for parse in (
                datetime.fromisoformat,
                lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S"),
                lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S.%f"),
            ):
                try:
                    dt = parse(s)
                    break
                except (ValueError, TypeError):
                    continue
        if dt is None:
            dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def tashkent_stamp(value):
    """DD.MM.YYYY HH:MM in Tashkent time — the stamp the receipts carry."""
    return _to_dt(value).astimezone(TASHKENT).strftime("%d.%m.%Y %H:%M")


def _short_stamp(value):
    """DD.MM HH:MM — the secondary stamp, when a row names two moments."""
    return _to_dt(value).astimezone(TASHKENT).strftime("%d.%m %H:%M")


def _flow(value):
    """A month total: magnitude, and a real minus when the total went backwards.

    `_som()` alone would be a lie here. A bucket is a SUM over signed rows and a
    reversal lands in the bucket of the row it cancels — so a handover made last
    month and corrected this one leaves "Berildi" NEGATIVE, and printing its
    magnitude would report goods given out that were in fact taken back.
    """
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        n = 0
    return f"{MINUS}{_money(n)}{NBSP}so'm" if n < 0 else _som(n)


def month_bounds(now=None):
    """(start, next, label) for the Tashkent month `now` falls in.

    Port of monthBounds() in server/statement.js: the bounds are Tashkent
    wall-clock strings compared against `datetime(created_at,'+5 hours')`,
    half-open so no row is counted twice or lost, and December rolls the YEAR,
    not the month. The label is the workbook's — "2026-yil sentabr".
    """
    here = (now or datetime.now(timezone.utc)).astimezone(TASHKENT)
    year, month = here.year, here.month
    n_year, n_month = (year + 1, 1) if month == 12 else (year, month + 1)
    return (f"{year:04d}-{month:02d}-01 00:00:00",
            f"{n_year:04d}-{n_month:02d}-01 00:00:00",
            f"{year}-yil {UZ_MONTHS[month - 1]}")


# ─── Rendering ─────────────────────────────────────────────────────────────────

def _u16len(s):
    """Length the way Telegram counts it: UTF-16 code units, not code points.

    Every astral character costs TWO — and this module's headers lead with 📦
    (U+1F4E6), 💵 (U+1F4B5) and the rest. Measuring with len() would let a long
    reversal row past a 200-code-point check and into a MESSAGE_TOO_LONG
    rejection, i.e. no answer at all: the spinner, on the one row a client most
    needs to read.
    """
    return len(s.encode("utf-16-le")) // 2


def _fit(lines):
    """Join and hard-cap at Telegram's 200-character answerCallbackQuery limit.

    Over the cap Telegram rejects the whole answer, which is the spinner this
    module exists to prevent — so the cap is enforced here and never trusted to
    the caller. Trimmed one code point at a time so the cut can never land
    between a surrogate pair.
    """
    body = "\n".join(line for line in lines if line)
    if _u16len(body) <= ANSWER_MAX:
        return body
    body = body[:ANSWER_MAX - 1]
    while body and _u16len(body) > ANSWER_MAX - 1:
        body = body[:-1]
    return body.rstrip() + "…"


def _who(row):
    """"Kim: <name>", or nothing when the ledger never recorded a name.

    The NAME only. `performed_by` is a Telegram id and is never shown: it is
    the one field on the row that identifies a person to a stranger.
    """
    name = str(row["performed_by_name"] or "").strip()
    return f"Kim: {name}" if name else ""


def _goods(row):
    """The product line and the arithmetic line, or (None, figure) for a payment."""
    label = product_label(row["category_name"], row["parent_name"])
    if row["category_id"] is not None and not label:
        # The category was deleted, so the LEFT JOIN yielded a null name. '?'
        # survives rather than printing a dangling "Tarpetka › ".
        label = "?"
    if len(label) > PRODUCT_MAX:
        label = label[:PRODUCT_MAX - 1].rstrip() + "…"
    total = _som(row["amount"])
    if row["qty"] is None or row["category_id"] is None:
        return None, total
    return label, f"{row['qty']} dona × {_money(row['unit_price'])} = {total}"


def describe(row):
    """One ledger row as (answer_text, show_alert). Pure — no I/O, never raises.

    Figures print as MAGNITUDES and the verb carries the direction, exactly as
    the receipts do: a client checking the arithmetic by hand must never find a
    different number here than on the message in the same group.
    """
    icon, verb = _KIND_UI.get(row["kind"], _KIND_FALLBACK)
    stamp = tashkent_stamp(row["created_at"])
    label, figures = _goods(row)
    who = _who(row)

    if row["reverses_id"] is not None:
        # The row IS a cancellation. It leads with plain words, like the
        # correction receipt, so it can never be mistaken for a fresh sale.
        o_icon, o_verb = _KIND_UI.get(row["orig_kind"] or row["kind"], _KIND_FALLBACK)
        ref = f"Bekor qilingan: {o_icon} {o_verb} · {_short_stamp(row['orig_created_at'] or row['created_at'])}"
        body = [label, figures] if label else [figures]
        # DECISION: an alert, not a toast. A cancellation is the one thing on
        # this board a client must not miss, and reversals are rare enough that
        # a modal costs nothing in accidental taps.
        return _fit([f"❌ Bekor qilindi · {stamp}", ref] + body + [who]), True

    if row["reversed_at"] is not None:
        # The original, cancelled later by a reversing row. The board prefixes
        # it '✗' and leaves it out of JAMI; the tap says so in words.
        head = f"✗ Bekor qilingan · {_short_stamp(row['reversed_at'])}"
        body = [label, figures] if label else [figures]
        return _fit([head, f"{icon} {verb} · {stamp}"] + body + [who]), True

    if row["kind"] == "adjustment" and label is None:
        # No verb states an adjustment's direction, so the sign does.
        return _fit([f"{icon} {verb} · {stamp}", _signed(row["amount"]), who]), False

    body = [label, figures] if label else [figures]
    return _fit([f"{icon} {verb} · {stamp}"] + body + [who]), False


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def account_lines(row, month_label):
    """One client's account as lines, most important first. Pure, never raises.

    The ORDER is the design: the balance is what a dispute turns on, so it is
    line two and the month's detail is what `_fit` trims if a client somehow
    manages a 24-character name and nine-figure totals in all four buckets.

    The balance prints its MAGNITUDE under a flipped label — exactly what
    balanceLine() in notify.js and boardText() in board-grid.js do — because
    "Oldindan to'lov: −160 000" prints the minus twice and reads as a broken bot.
    """
    name = str(row["client_name"] or "").strip()
    if len(name) > CLIENT_MAX:
        name = name[:CLIENT_MAX - 1].rstrip() + "…"
    balance = _int(row["balance"])
    label = "Jami qarz" if balance >= 0 else "Oldindan to'lov"
    lines = [
        f"\U0001F4CA {name}" if name else "\U0001F4CA Hisob",
        f"{label}: {_som(balance)}",
        f"Bu oy · {month_label}",
    ]
    moved = False
    for key, word in (("given", "Berildi"), ("returned", "Qaytarildi"),
                      ("paid", "To'landi"), ("adjusted", "Tuzatish")):
        value = _int(row[key])
        if value:
            lines.append(f"{word}: {_flow(value)}")
            moved = True
    if not moved:
        lines.append(MSG_NO_MOVEMENT)
    return lines


def describe_account(row, month_label):
    """The account toast as (answer_text, show_alert). A toast, not an alert:
    both board buttons are tapped on purpose and often, by the client."""
    return _fit(account_lines(row, month_label)), False


# ─── Authorisation ─────────────────────────────────────────────────────────────

def may_see(row, chat, user):
    """May this tapper be told about this row?

    Boards live in CLIENT groups, so the tapper is usually the client, not an
    approved warehouse user. Two ways in, and nothing else:

      1. The row belongs to the client this chat is bound to. The client then
         learns exactly what the board button and the receipt already sitting
         in the same group show them.
      2. The tapper is a warehouse operator, wherever they tap.

    The binding — clients.telegram_chat_id — is the leak guard: a row belonging
    to another client can never be described here, whatever id the callback
    carries.
    """
    if is_operator(user):
        return True
    chat_id = getattr(chat, "id", None)
    bound = row["client_chat_id"]
    if chat_id is None or bound is None:
        return False
    try:
        return int(bound) == int(chat_id)
    except (TypeError, ValueError):
        return False


def may_see_account(row, chat, user):
    """May this tapper be told this client's balance?

    The same two ways in as may_see(), and the same guard doing the work — the
    row is bound to a chat by `clients.telegram_chat_id` and the tap must come
    from THAT chat. Written against the client row rather than a ledger row
    because the board-level buttons name a client, not a movement; a forged
    `brp:<any id>` and a forwarded board both dead-end here exactly as they do
    on the per-row path.
    """
    if is_operator(user):
        return True
    chat_id = getattr(chat, "id", None)
    bound = row["client_chat_id"]
    if chat_id is None or bound is None:
        return False
    try:
        return int(bound) == int(chat_id)
    except (TypeError, ValueError):
        return False


def is_operator(user):
    """The warehouse operator set — {ADMIN_ID} ∪ APPROVED_IDS, the set /ulash uses.

    Read from `callback_query.from.id` / `message.from.id`, which arrive inside
    Telegram's own update and are not forgeable by anything the client controls.
    `users.status='approved'` is deliberately NOT consulted, for the reason
    _OPERATORS states: this gate decides which TOAST a tapper gets and whether a
    url is offered. It never authorises a write — the Mini App's requireAuth
    does, on HMAC-verified initData — so it cannot diverge from it in a way that
    costs money.
    """
    uid = getattr(user, "id", None)
    return uid is not None and uid in _OPERATORS


def edit_block(row, field):
    """Why this row may not be edited, or None when it may. Pure, never raises.

    Reached only by an operator, and it is the last thing between a tap and a
    url — so it fails closed on everything the write route would refuse anyway,
    rather than handing out a link to a sheet that cannot save.
    """
    if row["reverses_id"] is not None:
        # The row IS a cancellation. A cancellation is not a business event with
        # a wrong number in it; it is the record that one was undone.
        return MSG_EDIT_LOCKED
    if row["reversed_at"] is not None:
        # Already cancelled. The board draws this row ✗ with `led:` on all three
        # cells, so reaching here means a stale keyboard in someone's scrollback.
        return MSG_EDIT_LOCKED
    if row["client_deleted_at"] is not None:
        return MSG_EDIT_LOCKED
    if field == "q" and row["qty"] is None:
        # A payment has no count. The board sends its DONA cell as `led:`; this
        # is the same stale-keyboard case.
        return MSG_EDIT_NO_QTY
    return None


# ─── Data access ───────────────────────────────────────────────────────────────

async def _fetch(ledger_id):
    async with AsyncSessionLocal() as session:
        result = await session.execute(sql(_SELECT), {"id": ledger_id})
        return result.mappings().first()


async def _fetch_account(client_id, now=None):
    """One client's binding, balance and this month's buckets — and the label
    for the month the figures were cut on, so the text can never name a
    different month than the one it summed."""
    m_start, m_next, label = month_bounds(now)
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            sql(_SELECT_CLIENT),
            {"id": client_id, "m_start": m_start, "m_next": m_next},
        )
        return result.mappings().first(), label


async def _resolve(data, chat, user):
    """(text, show_alert) for a `led:<id>` callback. Awaited under a timeout."""
    match = _LED_RE.match(str(data or ""))
    if not match:
        return MSG_NOT_FOUND, False
    row = await _fetch(int(match.group(1)))
    if row is None:
        # Unknown id, or a row whose client was purged. Either way the board is
        # older than the ledger; say so instead of leaving a spinner.
        return MSG_NOT_FOUND, False
    if not may_see(row, chat, user):
        # Deliberately says nothing about whose row it is.
        return MSG_FORBIDDEN, False
    return describe(row)


async def _resolve_edit(data, chat, user, bot_username):
    """(text, show_alert, url) for an `edq:`/`eds:` callback. Awaited under a timeout.

    THE ORDER IS THE SECURITY. may_see() — the leak guard, untouched — runs
    first, so the edit branch lives strictly INSIDE the set of rows this tapper
    could already read. Only then the operator test, and only after THAT does a
    url exist at all: a non-operator's tap cannot produce a deep link, even
    transiently, and produces no state for anyone to inspect.
    """
    match = _EDIT_RE.match(str(data or ""))
    if not match:
        return MSG_NOT_FOUND, False, None
    field, ledger_id = match.group(1), int(match.group(2))

    row = await _fetch(ledger_id)
    if row is None:
        return MSG_NOT_FOUND, False, None

    if not may_see(row, chat, user):
        # Deliberately says nothing about whose row it is. A forwarded board and
        # a hand-crafted `edq:<any id>` both dead-end here.
        return MSG_FORBIDDEN, False, None

    if not is_operator(user):
        # THE GATE. Byte-identical to what tapping the name cell gives them, and
        # to what `led:` answers today. From inside the official app the edit
        # cells and the read cells are indistinguishable — a courtesy to the
        # reader, never a security property: `reply_markup` is delivered to
        # every chat member and the prefixes are readable on any other client.
        # Nothing here depends on that secrecy.
        text, alert = describe(row)
        return text, alert, None

    blocked = edit_block(row, field)
    if blocked:
        return blocked, False, None

    if not bot_username:
        logger.error("bot_username missing from bot_data — edit deep links are DISABLED")
        return MSG_EDIT_OFF, False, None

    # A POINTER, NOT A CAPABILITY: /start re-runs this same gate.
    url = f"https://t.me/{bot_username}?start=e_{row['client_id']}_{row['id']}_{field}"
    return None, False, url


async def _resolve_board_report(data, chat, user):
    """(text, show_alert) for a `brp:<client_id>` tap. Awaited under a timeout.

    THE ROW IS BOUND TO THE TAPPING CHAT, exactly as the per-row guard binds it.
    A client tapping 📊 on their own board reads their own account — not a leak,
    it is their money — and the binding is what keeps it that and nothing more.
    """
    match = _BOARD_REPORT_RE.match(str(data or ""))
    if not match:
        return MSG_ACCOUNT_NOT_FOUND, False
    row, label = await _fetch_account(int(match.group(1)))
    if row is None:
        return MSG_ACCOUNT_NOT_FOUND, False
    if not may_see_account(row, chat, user):
        # Deliberately says nothing about whose account it is.
        return MSG_ACCOUNT_FORBIDDEN, False
    return describe_account(row, label)


async def _resolve_board_edit(data, chat, user, bot_username):
    """(text, show_alert, url) for a `bed:<client_id>` tap. Awaited under a timeout.

    THE ORDER IS THE SECURITY, and it is the order the per-row edit path already
    uses: the binding guard first, so the branch lives strictly inside the set of
    accounts this tapper could already read; then the operator test on
    `callback_query.from.id`; and only after THAT does a url exist at all.

    A non-operator — the CLIENT is in this group and the button is under their
    own photo, so they will tap it — gets the account toast, byte-identical to
    what 📊 answers for the same account. No url, no state, and nothing that
    says an edit affordance exists.
    """
    match = _BOARD_EDIT_RE.match(str(data or ""))
    if not match:
        return MSG_ACCOUNT_NOT_FOUND, False, None
    row, label = await _fetch_account(int(match.group(1)))
    if row is None:
        return MSG_ACCOUNT_NOT_FOUND, False, None

    if not may_see_account(row, chat, user):
        return MSG_ACCOUNT_FORBIDDEN, False, None

    if not is_operator(user):
        # THE GATE.
        text, alert = describe_account(row, label)
        return text, alert, None

    if row["client_deleted_at"] is not None:
        # Nothing to edit: the write route refuses every row of a deleted client,
        # so hand back the refusal here rather than a link to a sheet that cannot
        # save. An operator is reading this, so it may speak plainly.
        return MSG_EDIT_LOCKED, False, None

    if not bot_username:
        logger.error("bot_username missing from bot_data — edit deep links are DISABLED")
        return MSG_EDIT_OFF, False, None

    # A POINTER, NOT A CAPABILITY: /start re-runs this same gate.
    url = f"https://t.me/{bot_username}?start=b_{row['client_id']}"
    return None, False, url


async def _answer(query, message, show_alert=False, url=None):
    """The ONLY place this module answers. Never raises.

    Telegram rejects an answer to a query older than ~15 seconds with a
    BadRequest; a phone that went to sleep mid-tap must not turn into a
    traceback in the bot's log loop.
    """
    try:
        if url is not None:
            # ONE FIELD PER PATH. Telegram takes EITHER a url OR text; sending
            # both is how an answer gets rejected, which is the spinner again.
            await query.answer(url=url)
        else:
            await query.answer(message, show_alert=show_alert)
    except Exception as e:
        logger.warning("Could not answer callback %s: %s", getattr(query, "id", None), e)


# ─── Handlers ──────────────────────────────────────────────────────────────────

async def on_ledger_tap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`led:<ledger_id>` — describe one movement of the board's table.

    Structured so that exactly one answer() happens on every path: the text is
    computed inside the guard, and answering is the single statement after it.
    """
    query = update.callback_query
    if query is None:
        return

    try:
        message, alert = await asyncio.wait_for(
            _resolve(query.data, update.effective_chat, update.effective_user),
            timeout=QUERY_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning("Ledger tap %s timed out after %.1fs", query.data, QUERY_TIMEOUT_S)
        message, alert = MSG_BUSY, False
    except Exception as e:
        logger.error("Ledger tap %s failed: %s", query.data, e)
        message, alert = MSG_BUSY, False

    await _answer(query, message, alert)


async def on_board_header(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`boardhdr` — the header, the fold row and the JAMI total.

    They carry callback_data only because a button must. An empty answer clears
    the spinner and shows the tapper nothing at all, which is correct: they hit
    a table heading.
    """
    query = update.callback_query
    if query is None:
        return
    await _answer(query, None, False)


async def on_edit_tap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`edq:<id>` / `eds:<id>` — the DONA and SUMMA cells of a live row.

    Same shape as on_ledger_tap and for the same reason: exactly one answer()
    on every path, computed inside the guard, issued by the single statement
    after it. A tap that is not answered inside Telegram's ~15s window leaves a
    spinner turning on a CLIENT's phone.
    """
    query = update.callback_query
    if query is None:
        return

    # Read once at startup by bot.py's post_init. Absent means get_me() failed
    # and there is no link to build; _resolve_edit fails closed on it.
    bot_data = getattr(context, "bot_data", None) or {}
    bot_username = bot_data.get("bot_username")

    try:
        message, alert, url = await asyncio.wait_for(
            _resolve_edit(query.data, update.effective_chat, update.effective_user,
                          bot_username),
            timeout=QUERY_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning("Edit tap %s timed out after %.1fs", query.data, QUERY_TIMEOUT_S)
        message, alert, url = MSG_BUSY, False, None
    except Exception as e:
        logger.error("Edit tap %s failed: %s", query.data, e)
        message, alert, url = MSG_BUSY, False, None

    await _answer(query, message, alert, url)


async def on_board_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`brp:<client_id>` — 📊 Hisobot, the right-hand board button.

    Same shape as every handler here: exactly one answer() on every path,
    computed inside the guard, issued by the single statement after it.
    """
    query = update.callback_query
    if query is None:
        return

    try:
        message, alert = await asyncio.wait_for(
            _resolve_board_report(query.data, update.effective_chat,
                                  update.effective_user),
            timeout=QUERY_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning("Board report %s timed out after %.1fs", query.data, QUERY_TIMEOUT_S)
        message, alert = MSG_BUSY, False
    except Exception as e:
        logger.error("Board report %s failed: %s", query.data, e)
        message, alert = MSG_BUSY, False

    await _answer(query, message, alert)


async def on_board_edit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`bed:<client_id>` — ✏️ Tahrirlash, the left-hand board button.

    An operator is answered with a url and everyone else with a toast, and the
    two are indistinguishable from outside: both clear the spinner, neither
    posts anything into the group.
    """
    query = update.callback_query
    if query is None:
        return

    # Read once at startup by bot.py's post_init. Absent means get_me() failed
    # and there is no link to build; _resolve_board_edit fails closed on it.
    bot_data = getattr(context, "bot_data", None) or {}
    bot_username = bot_data.get("bot_username")

    try:
        message, alert, url = await asyncio.wait_for(
            _resolve_board_edit(query.data, update.effective_chat,
                                update.effective_user, bot_username),
            timeout=QUERY_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning("Board edit %s timed out after %.1fs", query.data, QUERY_TIMEOUT_S)
        message, alert, url = MSG_BUSY, False, None
    except Exception as e:
        logger.error("Board edit %s failed: %s", query.data, e)
        message, alert, url = MSG_BUSY, False, None

    await _answer(query, message, alert, url)


# ─── The deep link (private chat only) ─────────────────────────────────────────

def _is_private(chat):
    return getattr(chat, "type", None) == ChatType.PRIVATE


async def _prompt_row(client_id, entry_id, field):
    """The row a payload points at, or None if it may not be prompted for.

    NEVER TRUST THE PAYLOAD. Anyone who can see the button can read its
    `callback_data` and craft the link, so the client_id is not taken as a fact
    about the row — it is CHECKED against it, and a mismatch is treated exactly
    like a row that does not exist.
    """
    row = await _fetch(entry_id)
    if row is None:
        return None
    try:
        if int(row["client_id"]) != client_id:
            return None
    except (TypeError, ValueError):
        return None
    if edit_block(row, field):
        return None
    return row


async def _edit_prompt(update, context, client_id, entry_id, field):
    """Send the one private prompt for a deep link. True if this /start is ours.

    False means "not handled" and the caller falls through to the ORDINARY
    /start reply — which reveals nothing: not that the id exists, not which
    client it touches, not that an edit facility exists at all. No `users` row
    is created and no admin approval ping is sent on this branch; a control on
    every row of every client's board would otherwise turn that ping into a
    stream.
    """
    chat = update.effective_chat
    if not _is_private(chat):
        return False

    # THE GATE AGAIN, on this update's own from.id. The link authorises nothing.
    if not is_operator(update.effective_user):
        return False

    try:
        row = await asyncio.wait_for(
            _prompt_row(client_id, entry_id, field), timeout=QUERY_TIMEOUT_S
        )
    except Exception as e:
        # A busy WAL writer, a binder that refused the id — either way this is
        # not our /start. Fall through rather than answer with nothing.
        logger.warning("Edit prompt lookup failed for %s/%s: %s", client_id, entry_id, e)
        return False
    if row is None:
        return False

    label, figures = _goods(row)
    client_name = str(row["client_name"] or "").strip()
    head = "✏️ Tuzatish" + (f" · {client_name}" if client_name else "")
    subject = " · ".join(x for x in (label, tashkent_stamp(row["created_at"])) if x)
    # PLAIN TEXT, no parse_mode: the product name and the client name are both
    # owner-entered and may contain '<'. Nothing here needs markup.
    body = "\n".join(x for x in (head, subject, f"Hozir: {figures}") if x)

    markup = None
    if WEBAPP_URL:
        # `web_app` is used here and ONLY here: "Available only in private chats
        # between a user and the bot." No group keyboard in this design carries
        # one — which is the whole reason the deep link exists.
        sheet = _app_url(f"edit={client_id}.{entry_id}&f={field}")
        markup = InlineKeyboardMarkup(
            [[InlineKeyboardButton("✏️ Tahrirlash", web_app=WebAppInfo(url=sheet))]]
        )
    else:
        # Never a web_app button that cannot open. The figures still arrive.
        logger.error("WEBAPP_URL is empty — edit prompt sent without a button")

    return await _replace_prompt(context, chat, body, markup)


async def _replace_prompt(context, chat, body, markup):
    """DELETE THEN SEND, which is what makes a deep link idempotent: whether the
    client auto-sends the payload on opening an existing chat or shows a START
    button the operator taps, exactly ONE live prompt sits at the bottom of the
    chat. Always returns True — the /start was ours, handled, whatever Telegram
    then did with it.

    ONE key for both deep links, deliberately: a row prompt and a board prompt
    are the same object — the one live thing an operator is being asked to act
    on — and leaving a stale one above it is how an operator edits last week's
    row believing it is this one.
    """
    store = getattr(context, "user_data", None)
    previous = store.get(_EDIT_PROMPT_KEY) if isinstance(store, dict) else None
    if previous:
        try:
            await context.bot.delete_message(chat.id, previous)
        except Exception as e:
            logger.debug("Could not delete stale edit prompt %s: %s", previous, e)
        store.pop(_EDIT_PROMPT_KEY, None)

    try:
        sent = await context.bot.send_message(chat.id, body, reply_markup=markup)
    except Exception as e:
        # Handled, and it failed. Returning False here would send this operator a
        # greeting instead, which is a second message and a worse answer.
        logger.error("Could not send edit prompt to %s: %s", chat.id, e)
        return True

    message_id = getattr(sent, "message_id", None)
    if isinstance(store, dict) and message_id:
        store[_EDIT_PROMPT_KEY] = message_id
    return True


async def _board_prompt(update, context, client_id):
    """Send the one private prompt for a `b_<client_id>` deep link.

    True if this /start is ours. False means "not handled" and the caller falls
    through to the ORDINARY greeting — which reveals nothing: not that the id
    exists, not which client it names, not that an edit facility exists at all.
    """
    chat = update.effective_chat
    if not _is_private(chat):
        return False

    # THE GATE AGAIN, on this update's own from.id. Anyone in the group can read
    # `bed:<id>` off the board's reply_markup and craft this link, so possession
    # of it authorises exactly nothing.
    if not is_operator(update.effective_user):
        return False

    try:
        row, label = await asyncio.wait_for(
            _fetch_account(client_id), timeout=QUERY_TIMEOUT_S
        )
    except Exception as e:
        # A busy WAL writer, a binder that refused the id — either way this is
        # not our /start. Fall through rather than answer with nothing.
        logger.warning("Board prompt lookup failed for %s: %s", client_id, e)
        return False
    if row is None or row["client_deleted_at"] is not None:
        return False

    # A MESSAGE, not a callback answer: 4096 characters, so the figures are
    # joined whole here rather than squeezed through _fit's 200.
    # PLAIN TEXT, no parse_mode: the client name is owner-entered and may
    # contain '<'. Nothing here needs markup.
    body = "\n".join(["✏️ Tuzatish"] + account_lines(row, label))

    markup = None
    if WEBAPP_URL:
        # `web_app` is used here and ONLY here: "Available only in private chats
        # between a user and the bot." The board's keyboard lives in a GROUP,
        # which is the whole reason this deep link exists.
        #
        # `?edit=<clientId>.<entryId>` is the Mini App's existing deep-link
        # parameter. Entry 0 names no row: ClientsPage opens this client's
        # ledger on it, and ClientDetailPage's readEditParam rejects an entryId
        # below 1, so no edit sheet is forced open — the operator lands on the
        # ledger and picks the row, which is what a board-level button means.
        sheet = _app_url(f"edit={client_id}.0")
        markup = InlineKeyboardMarkup(
            [[InlineKeyboardButton("✏️ Tahrirlash", web_app=WebAppInfo(url=sheet))]]
        )
    else:
        # Never a web_app button that cannot open. The figures still arrive.
        logger.error("WEBAPP_URL is empty — board prompt sent without a button")

    return await _replace_prompt(context, chat, body, markup)


async def on_start_edit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/start — the edit deep link, or the ordinary greeting.

    Registered in place of handlers.start.start so there is ONE /start entry
    point and one parser. Everything this branch does not claim is handed on
    untouched, so a plain /start behaves exactly as it always did.
    """
    if update.effective_user is None or update.effective_message is None:
        return

    if not _is_private(update.effective_chat):
        # P0. /start in a group is how a client gets the pending `users` row
        # that a forged approve_<id> would flip, and how a group gets a public
        # refusal on demand. bot.py filters it out before this runs; saying it
        # again here means removing that filter cannot silently reopen the hole.
        return

    args = getattr(context, "args", None) or []
    payload = str(args[0]) if args else ""

    match = _START_EDIT_RE.match(payload)
    if match and await _edit_prompt(update, context, int(match.group(1)),
                                    int(match.group(2)), match.group(3)):
        return

    # The board button's payload. Disjoint from the row payload by its prefix,
    # so the two branches can never both claim one /start.
    match = _START_BOARD_RE.match(payload)
    if match and await _board_prompt(update, context, int(match.group(1))):
        return

    await _ordinary_start(update, context)

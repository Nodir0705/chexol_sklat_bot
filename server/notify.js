// Rendering and posting ledger receipts into a client's Telegram group.
//
// This file is the ONLY place a receipt is formatted. server/clients.js used to
// carry a second, divergent copy; the two drifted (one escaped its interpolated
// text, the other did not) and that is how a category named "Qora & Oq" could
// make Telegram reject a message and silently cut a client off from receipts.
// clients.js now imports formatReceipt from here — keep it that way.
//
// The ledger row is committed before a receipt is attempted, and nothing here
// ever throws: a Telegram outage must not stop the owner recording business.
// Every failure is one log line and a { ok: false, error } return value.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000
const TELEGRAM_TIMEOUT_MS = 10_000

// U+00A0. Money never wraps: the digit groups AND the gap before "so'm" are
// non-breaking, so a 320px screen can never end a line on "2 400" and leave the
// rest of a debt figure below. (Spec picks U+00A0 over the thin U+202F, which
// renders as tofu on older Android/Windows font stacks.)
const NBSP  = ' '
const MINUS = '−' // U+2212, the adjustment sign — not an ASCII hyphen

// Exactly one owner-controlled emoji per message, always character 1.
const KIND_UI = {
  handover:   { icon: '📦', label: 'Berildi' },
  return:     { icon: '↩️', label: 'Qaytarildi' },
  payment:    { icon: '💵', label: "To'landi" },
  adjustment: { icon: '✏️', label: 'Tuzatish' },
}

const NOTE_MAX = 120
// The reverse route writes this when the owner gives no reason; it is bookkeeping
// noise, not a message to the client.
const AUTO_NOTE = /^Bekor qilindi #\d+$/

// ─── Formatting ────────────────────────────────────────────────────────────────

/** Integer so'm, NBSP thousands separators: 2400000 → "2 400 000". Magnitude only. */
function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** A figure with its unit attached, unbreakably: "2 400 000 so'm". */
const som = value => `${money(value)}${NBSP}so'm`

/** Adjustments are the one message whose direction no verb states. */
const signed = value => `${Number(value) < 0 ? MINUS : '+'}${money(value)}${NBSP}so'm`

// Category names and notes are owner-entered and the message goes out as
// parse_mode HTML. cleanNote() in clients.js stores the note raw (trim + 500),
// so escaping has to happen here, at render time.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The owner's note, italic, inside the quote — '' when there is nothing to say.
 * ORDER MATTERS: collapse whitespace, slice the RAW text, and escape last.
 * Escaping first and slicing after can cut "&amp;" in half, and Telegram answers
 * a half-entity with "can't parse entities" — i.e. no receipt at all.
 */
function noteLine(note) {
  if (note === null || note === undefined) return ''
  const flat = String(note).replace(/\s+/g, ' ').trim()
  if (!flat || AUTO_NOTE.test(flat)) return ''
  return `\n<i>${esc(flat.slice(0, NOTE_MAX).trimEnd())}</i>`
}

/**
 * The invariant last line. It always names what its number is, so a balance is
 * never ambiguous between this entry and the running total, and an overpayment
 * prints its magnitude under a flipped label instead of "Qarz: -160 000", which
 * reads as a broken bot.
 */
function balanceLine(balance) {
  const n = Math.trunc(Number(balance) || 0)
  return n >= 0
    ? `<b>Jami qarz: ${som(n)}</b>`
    : `<b>Oldindan to'lov: ${som(n)}</b>`
}

function toDate(at) {
  if (at instanceof Date) return at
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at)
  if (typeof at === 'string' && at.trim()) {
    const s = at.trim()
    // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; anything
    // that already carries one is left alone.
    const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)
    const d = new Date(s.replace(' ', 'T') + (zoned ? '' : 'Z'))
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

/** DD.MM.YYYY HH:MM in Tashkent time (UTC+5, no DST). */
function tashkentStamp(at) {
  const t = new Date(toDate(at).getTime() + TASHKENT_OFFSET_MS)
  const p = n => String(n).padStart(2, '0')
  return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}` +
         ` ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

/**
 * One receipt grammar for all five kinds: emoji+verb header, <blockquote> detail
 * box, one bold bottom line naming the balance. Read down a group, the messages
 * line up as an account book — a column of badges on the left, a column of
 * balances at the bottom.
 *
 *   📦 <b>Berildi</b>
 *   <blockquote>Ali cantara safir Qora
 *   5 dona × 120 000 = 600 000 so'm
 *   14.09.2026 15:04</blockquote>
 *   <b>Jami qarz: 2 400 000 so'm</b>
 *
 * The timestamp is the LAST line inside the quote, not the first: the push
 * preview is spent on verb + product + amount, and Telegram already stamps the
 * message itself. Returns show a POSITIVE total — the verb carries the
 * direction, and a client checking the arithmetic by hand must never find a
 * wrong sum on a receipt.
 *
 * @param entry   a client_ledger row (LEDGER_SELECT shape): kind, category_id,
 *                category_name, qty, unit_price, amount, note, reverses_id,
 *                created_at. `amount` is signed; figures print as magnitudes.
 * @param balance the client's balance AFTER this entry, signed.
 * @param orig    for a reversal, the row being cancelled — its label and its
 *                stamp head the quote, because the message points backwards.
 *                Falls back to the reversal's own kind/stamp when absent.
 */
export function formatReceipt(entry, balance, orig = null) {
  const e  = entry ?? {}
  const ui = KIND_UI[orig?.kind ?? e.kind] ?? KIND_UI.adjustment

  const total    = som(Math.abs(Math.trunc(Number(e.amount) || 0)))
  const hasGoods = e.category_id != null && e.qty != null
  const product  = esc(e.category_name ?? '?')
  const goods    = `${e.qty} dona × ${money(e.unit_price)} = ${total}`
  const note     = noteLine(e.note)

  let header, body

  if (e.reverses_id != null) {
    // Not carried by <s> alone: "Bekor qilindi" is characters 3-16, and the
    // quote's first line is an UNSTRUCK reference to the cancelled row. Strip
    // every entity (push preview, ancient client) and it still reads as a
    // cancellation rather than a fresh sale.
    header = '❌ <b>Bekor qilindi</b>'
    const ref = `${ui.label} · ${tashkentStamp(orig?.created_at ?? e.created_at)}`
    body = hasGoods
      ? `${ref}\n<s>${product}</s>\n<s>${goods}</s>${note}`
      : `${ref}\n<s>${total}</s>${note}`
  } else {
    const stamp = tashkentStamp(e.created_at)
    header = `${ui.icon} <b>${ui.label}</b>`
    if (e.kind === 'adjustment') {
      // The only message carrying a sign: no verb states its direction, and the
      // sign is not hanging off an "=".
      body = `${signed(e.amount)}${note}\n${stamp}`
    } else if (hasGoods) {
      // The product owns a full-width line so a long name wraps into itself
      // instead of shattering the arithmetic beneath it.
      body = `${product}\n${goods}${note}\n${stamp}`
    } else {
      body = `${total}${note}\n${stamp}`
    }
  }

  return `${header}\n<blockquote>${body}</blockquote>\n${balanceLine(balance)}`
}

// ─── Posting ───────────────────────────────────────────────────────────────────

/**
 * Build the poster. `notify(chatId, text)` resolves to:
 *   { ok: true, messageId }        — delivered
 *   { ok: false, skipped: true }   — client has no linked group
 *   { ok: false, error }           — anything else; already logged, never thrown
 */
export function makeNotifier(botToken) {
  const token = typeof botToken === 'string' ? botToken.trim() : ''
  if (!token) console.warn('[notify] BOT_TOKEN missing — receipts will not be posted')

  return async function notify(chatId, text) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true }
    }
    if (!token) return { ok: false, error: 'no_token' }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text ?? ''),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      })
      // A proxy error page is not JSON, so this parse is inside the try too.
      const json = await res.json()
      if (!json || json.ok !== true) {
        const error = json?.description ?? `http_${res.status}`
        console.warn(`[notify] chat ${chatId}: ${error}`)
        return { ok: false, error }
      }
      return { ok: true, messageId: json.result?.message_id }
    } catch (err) {
      const error = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err)
      console.warn(`[notify] chat ${chatId}: ${error}`)
      return { ok: false, error }
    }
  }
}

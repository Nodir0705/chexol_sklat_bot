// Rendering and posting ledger receipts into a client's Telegram group.
//
// This file is the ONLY place a receipt is formatted. server/clients.js used to
// carry a second, divergent copy; the two drifted (one escaped its interpolated
// text, the other did not) and that is how a category named "Qora & Oq" could
// make Telegram reject a message and silently cut a client off from receipts.
// clients.js now imports formatReceipt from here — keep it that way.
//
// It is also the ONLY place a product is NAMED. productLabel() is exported for
// server/statement.js, so the Mahsulot column of the monthly workbook and the
// receipt the client got in September say the same words about the same thing.
//
// Three entry points:
//   productLabel(name, parent)            — "Tarpetka › Damas"
//   formatReceipt(entry, balance, orig)   — one ledger row
//   formatBatchReceipt(entries, balance, opts) — two or more rows, one message
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

// The batch list's rule, U+2500 × 10. Ten columns is wide enough to read as a
// rule and short enough that it can never be the line that wraps.
const RULE = '──────────'

// ─── Product naming ────────────────────────────────────────────────────────────
//
// One rule, one place. Six leaves ("Damas", "Coblet", "Lasetiy", "N2", "N3",
// "Onex") exist under BOTH "Tarpetka" and "!Tikuvda tarpetka💈", and three more
// ("Qora", "Seriy", "Donalik") are bare colours — a receipt naming only the leaf
// is unrecoverably ambiguous. Qualifying costs ~11 characters; not qualifying
// costs a dispute nobody can settle from the message.

/** U+203A — the separator fullPath() and the workbook's Joylashuv column use. */
const PATH_SEP = ' › '

// o' / o‘ / o’ / oʻ / oʼ is ONE Uzbek letter typed five ways (plus the two
// keyboard stand-ins ` and ´). Unified before comparison, and kept INSIDE the
// token so "qo'shimcha" stays one word instead of becoming "qo" + "shimcha".
// Written as escapes so no editor or copy-paste can quietly re-fold the class.
const APOSTROPHES = /[\u2018\u2019\u02BB\u02BC\u0060\u00B4]/g

/**
 * Comparison tokens for a category name. NFC first — the same Uzbek name can
 * arrive pre-composed or decomposed and must compare equal. Then .toLowerCase(),
 * deliberately the locale-INDEPENDENT one: toLocaleLowerCase() is locale-sensitive,
 * and a product's printed name must not depend on the server's LANG.
 *
 * Every non-alphanumeric except the apostrophe is a token break: space, !, (, ),
 * -, ., emoji, ZWJ, variation selectors. So "!Tikuvda tarpetka💈" → ["tikuvda",
 * "tarpetka"], and the decorative chrome the owner types cannot affect matching.
 */
function tokens(name) {
  return String(name ?? '').normalize('NFC').toLowerCase()
    .replace(APOSTROPHES, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
}

/**
 * Is `needle` a CONTIGUOUS, in-order run inside `hay`? A subarray test, not a
 * subset test: "Ali cantara safir" must not be considered present in a leaf that
 * merely happens to use all three words somewhere.
 */
function containsRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { hit = false; break }
    }
    if (hit) return true
  }
  return false
}

/**
 * How a product is named ANYWHERE in this system: "Parent › Leaf", except when
 * the leaf's tokens already contain the parent's tokens as a contiguous in-order
 * run — then the leaf alone, because repeating it reads as a stutter.
 *
 *   ("Ali cantara safir Qora", "Ali cantara safir") → "Ali cantara safir Qora"
 *   ("Qora",  "Cristal")                            → "Cristal › Qora"
 *   ("Damas", "Tarpetka")                           → "Tarpetka › Damas"
 *   ("Damas", "!Tikuvda tarpetka💈")                → "!Tikuvda tarpetka💈 › Damas"
 *
 * Two cases that look alike and are NOT:
 *   - No parent at all — a root category, or a caller whose SELECT does not join
 *     one yet — returns the leaf alone. That is what keeps every existing receipt
 *     byte-identical until LEDGER_SELECT grows its parent JOIN, and it is why
 *     this function degrades instead of printing a dangling "Tarpetka › ".
 *   - A parent that TOKENISES to nothing ("💈", "!!!") is NOT contained, so the
 *     parent is KEPT. Deliberate asymmetry: a wrongly suppressed parent is an
 *     ambiguous receipt nobody can recover from; a wrongly kept one costs
 *     ~11 characters.
 *
 * Returns RAW text — no HTML escaping. The Telegram renderers esc() the finished
 * label; the Excel workbook must never receive "&amp;" in a cell. (PATH_SEP holds
 * nothing HTML-special, so escaping the whole label equals escaping its parts.)
 *
 * The parent name must come from a JOIN, never from splitting category_path:
 * POST /api/categories only trims the name, so an owner-entered name may itself
 * contain " › ".
 */
export function productLabel(categoryName, parentName) {
  const leaf   = String(categoryName ?? '').trim()
  const parent = String(parentName ?? '').trim()
  if (!leaf || !parent) return leaf
  return containsRun(tokens(leaf), tokens(parent)) ? leaf : parent + PATH_SEP + leaf
}

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
 *                category_name, parent_name, qty, unit_price, amount, note,
 *                reverses_id, created_at. `amount` is signed; figures print as
 *                magnitudes. `parent_name` is optional — absent, the product
 *                renders exactly as it did before productLabel() existed.
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
  // productLabel() is the one naming rule; '?' survives for a row whose category
  // was deleted (LEDGER_SELECT's LEFT JOIN yields a null name), so a receipt can
  // never print a dangling "Tarpetka › ".
  const product  = esc(productLabel(e.category_name, e.parent_name) || '?')
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

/**
 * One message for a whole batch: same grammar, a list where the single receipt
 * has one product.
 *
 *   📦 <b>Berildi</b>
 *   <blockquote>Tarpetka › Damas
 *   5 dona · 600 000
 *   !Tikuvda tarpetka💈 › Damas
 *   2 dona · 240 000
 *   ──────────
 *   Jami: 840 000 so'm
 *   14.09.2026 15:04</blockquote>
 *   <b>Jami qarz: 3 240 000 so'm</b>
 *
 * THE LAYOUT DECISION (the tension the spec left open).
 * The owner chose a "compact list, one line per product". One physical line per
 * product is not reachable with this catalogue, and the parent is not why.
 * Measured against the real names at a ~30-character budget (320px, Telegram's
 * 16px body font, inside a blockquote's indent):
 *
 *   "Ali cantara safir dark bule (Kok)"            33 — wraps with NO parent at all
 *   "Ali cantara safir Qora · 12 dona · 1 440 000" 44 — wraps
 *   "!Tikuvda tarpetka💈 › Damas · 5 dona · 600 000" 45 — wraps
 *
 * So "render the parent more quietly" cannot save the one-line form: the LEAVES
 * alone already spend the line. The choice is therefore between a list that
 * wraps mid-figure — exactly the mush the owner complained about — and the
 * invariant the previous round already established for the single receipt: the
 * product name owns a full-width line, the figures own the line beneath. Same
 * rule, applied to every row. A 33-character name wraps into ITSELF, harmlessly,
 * and the arithmetic underneath is never split.
 *
 * "Compact" is then honoured where it is actually paid for: ONE message instead
 * of twelve, no unit price and no repeated "so'm" per row (the Jami line carries
 * the unit), and the qty/total line is ~16 characters. Uniform two lines for
 * every item, never a mix — a list where some rows are one line and some are two
 * reads as a bug, and the letters-then-digits alternation is its own row
 * boundary, so no blank lines or bullets are needed.
 *
 * Size: 50 items (the API cap) ≈ 3 000 characters, inside Telegram's 4 096.
 *
 * @param entries  ledger rows, all the same kind (the batch routes write
 *                 handover-only or return-only). Fewer than two delegates to
 *                 formatReceipt, so a one-row list is unreachable from here.
 * @param balance  the client's balance AFTER the whole batch, signed.
 * @param opts     { note, at } — the batch's own note and stamp. Both default to
 *                 the first row's, which is what the batch routes write.
 */
export function formatBatchReceipt(entries, balance, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (list.length < 2) return formatReceipt(list[0] ?? null, balance)

  const o  = opts ?? {}
  // A batch is goods only; the fallback exists so an unknown kind still renders a
  // receipt rather than throwing inside a fire-and-forget post().
  const ui = KIND_UI[list[0].kind] ?? KIND_UI.handover

  const rows = []
  let grand = 0
  for (const e of list) {
    // Magnitudes, like the single receipt: a return prints a positive total and
    // the verb in the header carries the direction. The bottom line is where the
    // client sees the debt drop.
    const amount = Math.abs(Math.trunc(Number(e.amount) || 0))
    grand += amount
    rows.push(esc(productLabel(e.category_name, e.parent_name) || '?'))
    rows.push(`${e.qty} dona · ${money(amount)}`)
  }

  const note  = noteLine(o.note !== undefined ? o.note : list[0].note)
  const stamp = tashkentStamp(o.at ?? list[0].created_at)

  // The note sits in the same slot as in the single receipt — after the money,
  // before the stamp — so the timestamp stays the last line inside the quote.
  const body = `${rows.join('\n')}\n${RULE}\nJami: ${som(grand)}${note}\n${stamp}`
  return `${ui.icon} <b>${ui.label}</b>\n<blockquote>${body}</blockquote>\n${balanceLine(balance)}`
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

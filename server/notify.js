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
import { existsSync } from 'node:fs'

const TELEGRAM_TIMEOUT_MS = 10_000

// U+00A0. Money never wraps: the digit groups AND the gap before "so'm" are
// non-breaking, so a 320px screen can never end a line on "2 400" and leave the
// rest of a debt figure below. (Spec picks U+00A0 over the thin U+202F, which
// renders as tofu on older Android/Windows font stacks.)
const NBSP  = ' '
const MINUS = '−' // U+2212, the adjustment sign — not an ASCII hyphen

// Exactly one owner-controlled emoji per message, always character 1.
export const KIND_UI = {
  handover:   { icon: '📦', label: 'Berildi' },
  return:     { icon: '↩️', label: 'Qaytarildi' },
  payment:    { icon: '💵', label: "To'landi" },
  adjustment: { icon: '✏️', label: 'Tuzatish' },
}

const NOTE_MAX = 120
// What the reverse and edit routes write when the owner gives no reason. It is
// bookkeeping noise pointing at a row id, not a message to a client -- and the
// client cannot resolve the id anyway.
const AUTO_NOTE = /^(Bekor qilindi|Tuzatildi) #\d+$/

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
export function tashkentStamp(at) {
  const t = new Date(toDate(at).getTime() + TASHKENT_OFFSET_MS)
  const p = n => String(n).padStart(2, '0')
  return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}` +
         ` ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

// ─── Correction ink ────────────────────────────────────────────────────────────
//
// THE ADDITIVE RULE, identical to the picture's: a posted receipt is a DATED
// DOCUMENT. A correction ADDS ink and nothing else — no figure the message ever
// printed is recomputed, moved or removed. `Jami:`, the stamp and balanceLine()
// say what the document said when it was issued; only the cancelled rows gain a
// strike and one header line is prepended above the existing header.
//
// Both entry points take the ink through `opts`, and both are byte-identical to
// their pre-correction output when it is absent — which is what lets the same
// function render a card and, months later, re-render that same card stamped.

/** Ledger-id membership, duck-typed so any Set-like works and a missing/odd
 *  `cancelled` degrades to "nothing is cancelled" rather than throwing inside a
 *  fire-and-forget post. An entry with no `id` is never cancelled. */
function isCancelled(cancelled, id) {
  return id != null && typeof cancelled?.has === 'function' && cancelled.has(id)
}

/** Wrap a line in <s> exactly once. */
const strike = line => `<s>${line}</s>`

/**
 * The one line a correction prepends, ABOVE the existing emoji+verb header —
 * never replacing it. The verb still records what was originally done; the
 * cancellation is a second fact stacked on top of it, and it leads with plain
 * words so that a push preview stripped of every entity still reads as a
 * cancellation.
 *
 *   ❌ <b>Bekor qilindi</b> · 1 qator · 15.09.2026 14:22
 *   📦 <b>Berildi</b>
 *   <blockquote>…
 *
 * Returns '' when there is no correction, so callers can interpolate it blind.
 */
function correctionHead(correction) {
  if (!correction) return ''
  const count = Math.max(1, Math.trunc(Number(correction.count) || 0))
  return `❌ <b>Bekor qilindi</b> · ${count} qator · ${esc(correction.at ?? '')}\n`
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
 * @param opts    { cancelled?: Set<number>, correction?: { count, at } } — the
 *                CORRECTION INK, and nothing else. See correctionHead(): every
 *                figure this message printed stays, in place, unchanged; a
 *                cancelled row is struck where it already sits and one header
 *                line is prepended. Absent or empty, the output is byte-identical
 *                to what this function returned before corrections existed.
 */
export function formatReceipt(entry, balance, orig = null, opts = {}) {
  const e  = entry ?? {}
  const ui = KIND_UI[orig?.kind ?? e.kind] ?? KIND_UI.adjustment
  const o  = opts ?? {}

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
    // A reversal card is never a stamp target (E.isReversal forbids reversing a
    // reversal), so the ink is applied in this branch only — the branch above is
    // already struck and must stay byte-identical.
    const out = isCancelled(o.cancelled, e.id)
    if (e.kind === 'adjustment') {
      // The only message carrying a sign: no verb states its direction, and the
      // sign is not hanging off an "=".
      // DECISION: for a row with no goods the signed figure IS the row's
      // qty/total line, so that is what the strike lands on — the same mark the
      // picture makes on the no-table payment card.
      body = `${out ? strike(signed(e.amount)) : signed(e.amount)}${note}\n${stamp}`
    } else if (hasGoods) {
      // The product owns a full-width line so a long name wraps into itself
      // instead of shattering the arithmetic beneath it.
      body = out
        ? `${strike(product)}\n${strike(goods)}${note}\n${stamp}`
        : `${product}\n${goods}${note}\n${stamp}`
    } else {
      body = `${out ? strike(total) : total}${note}\n${stamp}`
    }
  }

  return `${correctionHead(o.correction)}${header}\n<blockquote>${body}</blockquote>\n` +
         balanceLine(balance)
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
 * @param opts     { note, at, cancelled?, correction? } — the batch's own note
 *                 and stamp (both default to the first row's, which is what the
 *                 batch routes write), plus the correction ink: `cancelled` is a
 *                 Set of ledger ids whose two lines are struck in place, and
 *                 `correction` prepends one header line. `Jami:`, the stamp and
 *                 the balance line are NEVER recomputed and never struck.
 */
export function formatBatchReceipt(entries, balance, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  // The ink travels with the delegation: a batch that merged down to one row is
  // still a stampable card. Passing only the two ink fields keeps `note`/`at`
  // out of formatReceipt, which does not take them.
  if (list.length < 2) {
    return formatReceipt(list[0] ?? null, balance, null,
      { cancelled: opts?.cancelled, correction: opts?.correction })
  }

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
    // The row is summed into `grand` whether it was cancelled or not: JAMI is
    // what this document said when it was issued. The strike below is the only
    // difference a cancellation makes to this list.
    grand += amount
    const label = esc(productLabel(e.category_name, e.parent_name) || '?')
    const figs  = `${e.qty} dona · ${money(amount)}`
    if (isCancelled(o.cancelled, e.id)) {
      rows.push(strike(label))
      rows.push(strike(figs))
    } else {
      rows.push(label)
      rows.push(figs)
    }
  }

  const note  = noteLine(o.note !== undefined ? o.note : list[0].note)
  const stamp = tashkentStamp(o.at ?? list[0].created_at)

  // The note sits in the same slot as in the single receipt — after the money,
  // before the stamp — so the timestamp stays the last line inside the quote.
  const body = `${rows.join('\n')}\n${RULE}\nJami: ${som(grand)}${note}\n${stamp}`
  return `${correctionHead(o.correction)}${ui.icon} <b>${ui.label}</b>\n` +
         `<blockquote>${body}</blockquote>\n${balanceLine(balance)}`
}

// ─── Posting ───────────────────────────────────────────────────────────────────

/**
 * Build the poster. `notify(chatId, text, { replyTo })` resolves to:
 *   { ok: true, messageId }        — delivered
 *   { ok: false, skipped: true }   — client has no linked group
 *   { ok: false, error }           — anything else; already logged, never thrown
 *
 * Three methods hang off it, documented at their definitions:
 *   notify.receipt(chatId, { svg, caption, text, followUp, replyTo })
 *     — picture first, degrading to the text receipt on any render or upload
 *       failure. `photo: true` comes back ONLY from the picture path.
 *   notify.photo(chatId, { svg, caption, reply_markup })
 *     — a picture WITH an inline keyboard, and NO text fallback of its own.
 *       The living board's fresh post. Its caller owns the degrade, because
 *       its caller is the one that must RECORD which form was posted.
 *   notify.edit(chatId, messageId, { isPhoto, svg, caption, text, reply_markup })
 *     — re-post in place, with a permanent/transient verdict.
 */
/** Rasterise an SVG receipt to PNG. Kept behind a lazy import so a renderer
 *  fault can never stop the server booting -- the ledger write matters more
 *  than the picture, and notifyReceipt falls back to text on any failure. */
const FONT_FILES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]

async function renderPng(svg) {
  const { Resvg } = await import('@resvg/resvg-js')
  // Load the faces by PATH. loadSystemFonts relies on fontconfig, which this
  // image does not install -- the .ttf files are present but undiscoverable, so
  // every glyph silently rendered as nothing and receipts arrived as empty
  // boxes and rules. Explicit paths need no fontconfig and pin the exact faces
  // the advance table in metrics.json was measured from.
  const fontFiles = FONT_FILES.filter(f => existsSync(f))
  if (!fontFiles.length) throw new Error('no font files found — refusing to render textless receipt')

  // The SVG declares its own width/height (1080 wide, 3x the 360pt layout), so
  // 'original' is right -- forcing a width would rescale an already-scaled card.
  return new Resvg(String(svg), {
    font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'DejaVu Sans' },
    fitTo: { mode: 'original' },
  }).render().asPng()
}

/**
 * Telegram's reply_parameters for a threaded post — or null when there is
 * nothing to thread under.
 *
 * allow_sending_without_reply IS NOT OPTIONAL. A correction card is the one
 * message in this system that must arrive whatever else has failed, and without
 * this flag Telegram REJECTS THE SEND OUTRIGHT when the message being replied to
 * has been deleted — turning a missing thread line into a missing receipt. With
 * it, a dead parent costs the arrow and nothing else.
 */
function replyParams(replyTo) {
  if (replyTo === null || replyTo === undefined || replyTo === '') return null
  return { message_id: Number(replyTo), allow_sending_without_reply: true }
}

export function makeNotifier(botToken) {
  const token = typeof botToken === 'string' ? botToken.trim() : ''
  if (!token) console.warn('[notify] BOT_TOKEN missing — receipts will not be posted')

  async function notify(chatId, text, { replyTo = null, reply_markup = null } = {}) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true }
    }
    if (!token) return { ok: false, error: 'no_token' }

    const reply = replyParams(replyTo)
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text ?? ''),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          // Omitted entirely when there is no parent, so every existing
          // two-argument caller sends exactly the body it sends today.
          ...(reply ? { reply_parameters: reply } : {}),
          // The living board posts its grid with the message that carries it.
          ...(reply_markup ? { reply_markup } : {}),
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

  /** Post a receipt as a picture with a searchable caption.
   *
   *  The image carries the itemised detail; the caption carries direction,
   *  total and balance, because a photo cannot be searched, copied or read by a
   *  screen reader and a client may need to find this months later.
   *
   *  Falls back to the text receipt on ANY rendering or upload failure. A
   *  picture is a nicety; the client being told what they received is not.
   */
  notify.receipt = async function sendReceipt(
    chatId, { svg, caption, text, followUp = null, replyTo = null }
  ) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true }
    }
    if (!token) return { ok: false, error: 'no_token' }

    const reply = replyParams(replyTo)
    try {
      const png = await renderPng(svg)
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('photo', new Blob([png], { type: 'image/png' }), 'receipt.png')
      if (caption != null && typeof caption !== 'string') {
        throw new TypeError('caption must be a string, got ' + typeof caption)
      }
      form.append('caption', String(caption ?? '').slice(0, 1024))
      form.append('parse_mode', 'HTML')
      // multipart carries no JSON types: Telegram reads this field as a JSON
      // STRING, like every other object parameter in a FormData request.
      if (reply) form.append('reply_parameters', JSON.stringify(reply))
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 3),
      })
      const json = await res.json()
      if (!json || json.ok !== true) throw new Error(json?.description ?? `http_${res.status}`)
      if (followUp) await notify(chatId, followUp)
      return { ok: true, messageId: json.result?.message_id, photo: true }
    } catch (err) {
      console.warn(`[notify] chat ${chatId}: photo failed (${err?.message ?? err}) — sending text`)
      // THE THREAD SURVIVES THE DEGRADE. If only the photo path carried replyTo,
      // a render fault would silently unthread the correction card — the reader
      // would get the text of the correction with no arrow back to the receipt
      // it corrects, which is the one link the whole design rests on.
      //
      // The return shape stays ASYMMETRIC on purpose: { ok, messageId, photo:true }
      // here, and notify()'s { ok, messageId } with NO photo field below. A caller
      // reads `res.photo === true` to choose editMessageMedia over editMessageText;
      // adding photo:false would not "tidy" that up, it would only invite someone
      // to read the field as present-and-meaningful on a text message.
      return notify(chatId, text, { replyTo })
    }
  }

  /** Post a picture that CARRIES AN INLINE KEYBOARD — the living board's fresh
   *  post. Verified against the live API (2026-09-17): sendPhoto accepts
   *  reply_markup, so the board's buttons arrive with the board itself and there
   *  is no window in which a picture sits in the group without its controls.
   *
   *  THE ONE WAY THIS DIFFERS FROM notify.receipt: there is no text fallback in
   *  here. A receipt degrades to text INSIDE notify.receipt because the caller
   *  does not care which form arrived; a BOARD's caller cares absolutely, because
   *  a photo board is edited with editMessageMedia and a text board with
   *  editMessageText, and guessing wrong fails every subsequent edit. So this
   *  function reports one unambiguous outcome and server/board.js chooses the
   *  fallback AND records what it chose. Same never-throws discipline as the
   *  rest of this file:
   *
   *    { ok: true, messageId, photo: true }  — delivered as a picture
   *    { ok: false, skipped: true }          — no chat to post into
   *    { ok: false, error }                  — render, upload, network, Telegram
   */
  notify.photo = async function sendBoardPhoto(chatId, { svg, caption, reply_markup = null } = {}) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true }
    }
    if (!token) return { ok: false, error: 'no_token' }

    try {
      // Inside the try: a renderer fault is just another reason this returns
      // { ok: false }, and the caller's text board covers it.
      const png = await renderPng(svg)
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('photo', new Blob([png], { type: 'image/png' }), 'board.png')
      form.append('caption', String(caption ?? '').slice(0, 1024))
      form.append('parse_mode', 'HTML')
      // multipart carries no JSON types: Telegram reads this field as a JSON
      // STRING, exactly like reply_parameters in notify.receipt above.
      if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup))
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 3),
      })
      const json = await res.json()
      if (!json || json.ok !== true) {
        const error = json?.description ?? `http_${res.status}`
        console.warn(`[notify] photo ${chatId}: ${error}`)
        return { ok: false, error }
      }
      // `photo: true` is the same flag notify.receipt sets on the same path, and
      // it means the same thing: this message can only ever be edited as media.
      return { ok: true, messageId: json.result?.message_id, photo: true }
    } catch (err) {
      const error = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err)
      console.warn(`[notify] photo ${chatId}: ${error}`)
      return { ok: false, error }
    }
  }

  const EDIT_PERMANENT = [
    'message to edit not found',
    'message_id_invalid',
    "message can't be edited",
    'message to be edited not found',
    'chat not found',
    'bot was kicked',
    'bot was blocked',
    'not enough rights',
    'chat_write_forbidden',
    'bot is not a member',
    // THE WRONG-PATH VERDICT. editMessageText against a photo, or
    // editMessageMedia against a text message, answers one of these — i.e. "the
    // stored is_photo disagrees with the message that is actually up there".
    // Retrying that forever would freeze the board at whatever it last said, so
    // it is PERMANENT: the caller marks the message gone and posts a fresh
    // board, which re-records the form correctly. A bookkeeping slip then costs
    // one duplicate board, not a client who never sees their balance move again.
    'there is no text in the message to edit',
    'there is no media in the message to edit',
  ]

  /** Re-post a receipt IN PLACE: the correction stamp on an already-delivered
   *  card. Never throws, never retries — one attempt, one classified answer, and
   *  the caller decides. Same house rule as everything else here: a notification
   *  failure can never reach a ledger write or an API response.
   *
   *    { ok: true }                              — edited, or already says this
   *    { ok: false, permanent: true, error }     — this message can never be
   *                                                edited again: deleted, chat
   *                                                left, rights lost. STOP.
   *    { ok: false, error, retryAfter? }         — transient: network, 5xx, 429,
   *                                                a render fault. Try later.
   *
   *  PERMANENT vs TRANSIENT IS THE WHOLE POINT OF THE RETURN SHAPE. A permanent
   *  answer that is read as transient retries forever against a message that no
   *  longer exists; a transient answer recorded as final abandons a live card
   *  over a five-second network blip. Only a Telegram `description` can earn
   *  `permanent` — every LOCAL fault (no token, render throw, non-JSON proxy
   *  page, socket error) is transient, because the next attempt may well work
   *  and a renderer fault must never mark a live card 'gone'.
   */

  notify.edit = async function editReceipt(chatId, messageId, { isPhoto, svg, caption, text, reply_markup = null }) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true }
    }
    // Not permanent: a message_id we do not have is a bookkeeping gap, not a
    // verdict from Telegram about a message that exists.
    if (messageId === null || messageId === undefined || messageId === '') {
      return { ok: false, error: 'no_message_id' }
    }
    if (!token) return { ok: false, error: 'no_token' }

    try {
      let url, init
      if (isPhoto) {
        // ONE call replaces the picture, the caption AND the keyboard, so no two
        // of them can ever disagree — a card showing a strike under a caption
        // that does not mention it would be worse than either half alone, and a
        // living board whose buttons outlive the picture they belong to is the
        // same fault one layer out. The render is inside the try: a render throw
        // is a transient failure, not a permanent one.
        const png = await renderPng(svg)
        const form = new FormData()
        form.append('chat_id', String(chatId))
        form.append('message_id', String(messageId))
        form.append('media', JSON.stringify({
          type: 'photo',
          media: 'attach://receipt',
          caption: String(caption ?? '').slice(0, 1024),
          parse_mode: 'HTML',
        }))
        form.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png')
        // A TOP-LEVEL field, NOT a key inside the `media` object: reply_markup is
        // a parameter of editMessageMedia, and Telegram silently ignores unknown
        // keys inside InputMediaPhoto — the buttons would just quietly vanish.
        // As with `media` itself, multipart carries it as a JSON string.
        //
        // Omitting it REMOVES the keyboard, exactly as on the text path below, so
        // every photo edit that wants buttons must resend them. Verified against
        // the live API (2026-09-17): media + reply_markup in one call replaces
        // both together.
        if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup))
        url  = `https://api.telegram.org/bot${token}/editMessageMedia`
        init = { method: 'POST', body: form,
                 signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 3) }
      } else {
        url  = `https://api.telegram.org/bot${token}/editMessageText`
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: String(text ?? ''),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            // MUST be sent on every edit. editMessageText WITHOUT reply_markup
            // REMOVES the inline keyboard, so omitting it would wipe the living
            // board's grid on the first edit after it was posted.
            ...(reply_markup ? { reply_markup } : {}),
          }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        }
      }

      const res = await fetch(url, init)
      // A proxy error page is not JSON, so this parse is inside the try too —
      // and lands in the transient catch below, which is where an HTML 502
      // belongs.
      const json = await res.json()
      if (json && json.ok === true) return { ok: true }

      const error = json?.description ?? `http_${res.status}`
      const d = String(error).toLowerCase()

      // SUCCESS-EQUIVALENT. The message already says exactly this, which is the
      // state the caller wanted; reporting failure here would make it stamp
      // forever, and reporting PERMANENT would mark a live card 'gone' and cost
      // it every later correction. It can only ever fire on the text path:
      // editMessageMedia with attach:// uploads a fresh PNG every time, so
      // Telegram can never call it a no-op. (Which is why the caller's own
      // stamped_ids is the only idempotence guard on the photo path.)
      if (d.includes('message is not modified')) return { ok: true }

      if (EDIT_PERMANENT.some(p => d.includes(p))) {
        console.warn(`[notify] edit ${chatId}/${messageId}: ${error} (permanent)`)
        return { ok: false, permanent: true, error }
      }

      // 429. retry_after is Telegram's own instruction; it is passed up rather
      // than slept on here, because this function makes exactly one attempt.
      const retryAfter = json?.parameters?.retry_after
      if (retryAfter != null || json?.error_code === 429 || res.status === 429) {
        console.warn(`[notify] edit ${chatId}/${messageId}: ${error} (rate)`)
        return retryAfter != null
          ? { ok: false, error, retryAfter }
          : { ok: false, error }
      }

      console.warn(`[notify] edit ${chatId}/${messageId}: ${error}`)
      return { ok: false, error }
    } catch (err) {
      // Timeout, socket, non-JSON body, or a throw out of renderPng. All
      // transient by construction: nothing here is Telegram telling us the
      // message cannot be edited.
      const error = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err)
      console.warn(`[notify] edit ${chatId}/${messageId}: ${error}`)
      return { ok: false, error }
    }
  }

  return notify
}

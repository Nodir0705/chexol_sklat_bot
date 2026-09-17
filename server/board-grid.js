// server/board-grid.js — the living board's renderer.
//
// One message per client group. Its TEXT carries the balance; its
// inline_keyboard IS the ledger table, and every movement appends rows to it.
// This file turns `client_ledger` rows into that message. It talks to nothing:
// no db, no Telegram, no clock beyond the row timestamps. Pure function in,
// { text, reply_markup } out — so it is testable without either process running.
//
//   buildBoard(rows, { clientName, balance }) -> { text, reply_markup }
//
// `rows` is the client's COMPLETE ledger as LEDGER_SELECT joins it, oldest
// first, INCLUDING reversals and the rows they reverse. Complete matters: the
// JAMI QARZ row is DERIVED from these rows on every call, never accumulated, so
// a LIMITed slice would print a total that contradicts the balance in the text.
// Deriving is the whole point — an accumulator is a second source of truth that
// can drift from SUM(amount), and this board is a view, not a book.
//
// ─── The shape: TWO keyboard rows per movement ────────────────────────────────
//
// Telegram gives every button in a keyboard row EQUAL width and clips with an
// end-ellipsis, never wraps. So a product name can be shown IN FULL only if it
// owns a FULL-WIDTH row — a keyboard row containing exactly one button. Every
// movement is therefore two keyboard rows:
//
//     [ Ali cantara safir dark bule (Kok)          ]   ← NAME row,   full width
//     [ 6 dona            | 720 000 so'm           ]   ← FIGURES row, 2 columns
//
// and the day is lifted OFF the movement entirely, onto a full-width separator
// that opens each day's block:
//
//     [ 📅 15.09.2026                              ]
//
// The board spans many days, so there is no single date to put in the message
// text; a separator is the only place a date can live once it is off the row.
// The 📅 is load-bearing, not decoration — a name row is ALSO a lone full-width
// button, and without a mark the two shapes are indistinguishable.
//
// The old MAHSULOT / DONA / SUMMA header row is GONE. It existed to name three
// anonymous narrow columns; there are now two numeric columns and they
// self-label — "6 dona" and "720 000 so'm" say what they are. A 2-cell header
// above a full-width name row reads as misalignment, not as a header.
//
// The total is likewise two rows: a `═══ JAMI QARZ ═══` rule row plus a 2-column
// figure row, because a total must put its figures in the SAME COLUMNS as the
// figures it sums, and a single full-width line cannot. The ═ rule closes the
// table the way 📅 opens each day.
//
// ─── What the reader sees, and why ────────────────────────────────────────────
//
// A reversed movement STAYS in the table, prefixed ✗, and is excluded from the
// totals. Buttons cannot render strikethrough, so a prefix is the only channel
// there is. The ✗ goes on the NAME row AND BOTH figure cells: the reader who
// scans the SUMMA column and adds it up sees "✗ 270 000 so'm" and knows to skip
// it; without that they would find a column that does not sum to its own JAMI
// and report the board as broken.
//
// The reversal row itself is NOT drawn. It is the same event as the row it
// voids, and the pair's amounts and quantities cancel exactly (the reverse route
// inserts -orig.amount with orig's kind, qty and category), so dropping both
// leaves every total identical to SUM(amount) over the whole ledger. That
// identity is what makes the board unable to drift: see pairVoids().
//
// A CORRECTED movement — one that replaces an earlier row via `corrects_id` —
// is marked ✎ on the NAME ROW ONLY, and is drawn at the ORIGINAL's position,
// under the ORIGINAL's day separator, because that is the day the delivery
// happened. Its figures are the live ones and DO belong in JAMI, so marking them
// would read as "these numbers are suspect". A principled difference from ✗,
// not an inconsistency.
//
// PRECEDENCE: ✗ DOMINATES ✎. A corrected row that is itself later cancelled
// draws `✗ <name>` and ✗ figures — never both marks, never `✎✗`. ✗ means "skip
// this figure", which is the instruction that must win.
//
// ─── Column budget ────────────────────────────────────────────────────────────
//
// A full-width row is about 18.0 em at 15 sp on a 360 dp phone; each half of a
// 2-column row is about 9.0 em. Measured with this repo's own instrument —
// server/metrics.json, DejaVu advances, emoji (absent from the face) counted at
// 1.0 em; Roboto, what a phone actually uses, runs ~12% narrower:
//
//     ok   15.86 / 18  "Ali cantara safir dark bule (Kok)"    ← longest real label
//     ok   17.01 / 18  "✗ Ali cantara safir dark bule (Kok)"  ← voided, still fits
//     ok   15.59 / 18  "✎ !Tikuvda tarpetka💈 › Damas"
//     ok   16.86 / 18  "+13 oldingi · 41 dona · 9 870 000"
//     ok    7.04 / 18  "📅 15.09.2026"
//     ok    9.55 / 18  "═══ JAMI QARZ ═══"
//     ok    7.79 /  9  "1 100 000 so'm"
//     ok    4.60 /  9  "✗ 5 dona"
//     OVER  9.26 /  9  "−12 570 000 so'm"    ← the one overflow, and it drives a rule
//     ok    6.56 /  9  "−12 570 000"
//
// Every real catalogue label fits a full-width row with margin. Full names are
// satisfied by measurement, not by hope.
//
// COL is the CODEPOINT proxy for that em budget, and both numbers below are
// derived from the strings above, not rounded to taste:
//
//   COL.label = 36.  The longest real label is 33 codepoints; with the ✗ mark in
//     front of it, 35 — and 35 codepoints measure 17.01 em inside an 18 em row.
//     36 is 35 plus one codepoint of margin. NOT 32: an em-per-letter estimate
//     (18 ÷ 0.563 ≈ 32) lands one codepoint BELOW the longest real label and
//     hands "Ali cantara safir dark bule (Ko…" to the client — permanently, for
//     every reader on every device — while the measurement says the whole name
//     fits with 2.14 em to spare. A proportional font is not 32 equal letters.
//     Above 36, fitLabel() survives for the pathological owner-entered
//     200-character name, which is the only case it now fires on.
//
//   COL.sum = 15.  "−12 570 000 so'm" is EXACTLY 16 codepoints, so a budget of
//     16 with an "exceeds" test never fires on the one string the rule exists
//     for. 15 is the tight threshold: for every so'm figure this system can
//     print, (codepoints ≤ 15) ⟺ (width ≤ 9.0 em).
//
//   COL.qty = 12 is advisory — it documents the half-cell's room ("−99 999 dona"
//     is 12) and no rule fires on it. Figures never truncate.
//
// Cells are NOT space-padded into columns. The font is proportional and the
// client centres each cell in its own button, so padding buys no alignment and
// spends budget that the label needs.
//
// Where a label does exceed the budget, the two ways text gets shortened are not
// symmetric. Clipping is done by the CLIENT, costs nothing, and is undone by
// rotating the phone or opening Telegram Desktop. Truncating here is PERMANENT
// for every reader. So this file truncates only where its rule beats the
// client's: the client end-clips, which eats the leaf that productLabel() exists
// to print, while fitLabel() eats the parent instead and keeps the leaf. Below
// the budget the client's own clipping finishes the job — and a tap on the name
// row answers with the full name anyway.
//
// Figures never truncate — a cut so'm figure is a lie, the same rule
// receipt-image.js states. Past the budget a SUMMA cell drops its UNIT before it
// drops a digit: so'm is a unit, not a digit. See somOrBare().
//
// ─── Height ───────────────────────────────────────────────────────────────────
//
// A movement costs 2 keyboard rows plus a share of a day separator, against 1
// before. So the cap is budgeted in ROWS, not in movements — the limit was
// always a screen-height budget and counting movements was only ever a proxy for
// it. Two limits, folded from the oldest until BOTH hold: VISIBLE_MAX movements
// and ROW_BUDGET keyboard rows. At the typical 3–4 movements per day, 12
// movements cost ~31 rows; at the worst case of one movement per day the row
// budget folds down to 10 movements and 33 rows. The board is taller and shows
// less history than the old one-row-per-movement grid. That is the price of full
// names. Full history is unchanged and still lives in the statement route.

import { productLabel, tashkentStamp, KIND_UI } from './notify.js'

// ─── Conventions shared with notify.js ─────────────────────────────────────────

// U+00A0 between digit groups, exactly as notify.js and receipt-image.js do. The
// board's figures live inside buttons, which never wrap, but the separator is
// part of how a so'm figure LOOKS in this system and a board that spelled its
// numbers differently from the receipt beside it would read as a second system.
const NBSP  = ' '
const MINUS = '−' // U+2212, not an ASCII hyphen
const ELL   = '…'
const VOID  = '✗' // U+2717 — the reversal mark; buttons have no strikethrough
const EDIT  = '✎' // U+270E — the correction mark. NOT ✏️, which is KIND_UI.adjustment's icon
const DAY   = '📅' // the day separator's mark; see the shape note above
const RULE  = '═══' // U+2550 ×3 — closes the table the way DAY opens each day
const NONE  = '—' // — the DONA cell of a movement that has no quantity
const PATH_SEP = ' › ' // U+203A, productLabel()'s separator

/** money(): byte-for-byte the helper in notify.js — U+00A0 groups, magnitude only. */
const money = n => String(Math.abs(Math.trunc(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
/** A figure with its unit attached, unbreakably: "2 400 000 so'm". */
const som = n => `${money(n)}${NBSP}so'm`
/** Table cells carry their own sign: plain when positive, U+2212 when negative. */
const signed = n => (Math.trunc(Number(n) || 0) < 0 ? MINUS : '') + money(n)

const int = n => Math.trunc(Number(n) || 0)

// Owner-entered names and the message goes out as parse_mode HTML. Escape LAST,
// after any slicing: slicing an escaped string can cut "&amp;" in half, and
// Telegram answers a half-entity with "can't parse entities" — no board at all.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ─── Layout constants ──────────────────────────────────────────────────────────

const COL = { label: 36, qty: 12, sum: 15 } // derived above, from the measurement
const PARENT_FLOOR = 6   // receipt-image.js's floor: below this a parent stub says nothing
const VISIBLE_MAX  = 12  // movements
const ROW_BUDGET   = 34  // keyboard rows — the limit that actually binds
const NAME_MAX     = 64  // the client name in the text line

const TOTAL_DEBT   = 'JAMI QARZ'
const TOTAL_CREDIT = "OLDINDAN TO'LOV"

// Telegram caps callback_data at 64 BYTES. The prefixes here are 4 bytes each,
// leaving 60 digits — a SQLite rowid maxes out at 19 (9 223 372 036 854 775 807),
// so this cannot overflow in this universe. CB_MAX is checked anyway because the
// failure mode if it ever did is not a bad button, it is Telegram rejecting
// BUTTON_DATA_INVALID for the whole reply_markup and the client losing their
// entire board. An oversized id degrades to `boardhdr`, which the Python handler
// already answers with an empty toast: the tap goes quiet, the board survives.
const CB_HDR = 'boardhdr'
const CB_LED = 'led:' // read: the detail toast, identical for client and operator
const CB_EDQ = 'edq:' // the DONA cell of a live handover/return — the edit control
const CB_EDS = 'eds:' // the SUMMA cell of any live row — the edit control
const CB_MAX = 64

/** `<prefix><id>`, or the inert header id when there is no usable id. */
function cb(prefix, id) {
  if (id === null || id === undefined) return CB_HDR
  const data = `${prefix}${id}`
  return Buffer.byteLength(data, 'utf8') <= CB_MAX ? data : CB_HDR
}

/** `led:<id>` — the read callback, which every inert-to-edit cell falls back to. */
const rowCallback = id => cb(CB_LED, id)

// ─── Fitting ───────────────────────────────────────────────────────────────────

const cps = s => [...String(s ?? '')]

/** Tail truncation by CODEPOINT (never UTF-16 unit) with U+2026. */
function fitTail(s, budget) {
  const cp = cps(s)
  if (cp.length <= budget) return s
  if (budget <= 1) return ELL
  return cp.slice(0, budget - 1).join('').replace(/[\s›]+$/u, '') + ELL
}

/**
 * The product-label rule: parent-first, mirroring receipt-image.js. The leaf is
 * the token productLabel() exists to print — six leaves live under BOTH
 * "Tarpetka" and "!Tikuvda tarpetka💈" — so "!Tikuvd… › Damas" beats
 * "!Tikuvda tarpe… › Da…", and beats the client's own end-clip, which would
 * eat the leaf entirely. Parent stub floor is 6 codepoints; below that a stub
 * disambiguates nothing and tail truncation is the honest fallback.
 *
 * At COL.label = 36 this fires on no real catalogue label — see the derivation
 * above. It stays for the pathological owner-entered 200-character name, where
 * parent-first still beats the client's end-clip.
 */
function fitLabel(s, budget) {
  const cp = cps(s)
  if (cp.length <= budget) return s
  const i = String(s).indexOf(PATH_SEP)
  if (i > 0) {
    const parent = cps(String(s).slice(0, i))
    const tail   = String(s).slice(i)              // " › Damas"
    const tailLen = cps(tail).length
    for (let n = parent.length - 1; n >= PARENT_FLOOR; n--) {
      if (n + 1 + tailLen <= budget) {
        return parent.slice(0, n).join('').trimEnd() + ELL + tail
      }
    }
  }
  return fitTail(s, budget)
}

/**
 * A SUMMA cell. so'm is a UNIT, not a digit: past the half-cell's budget the
 * cell drops the unit BEFORE it drops a digit, because a cut so'm figure is a
 * lie and a bare figure is merely terse. The measured case is
 * "−12 570 000 so'm" at 9.26 em against a 9.0 em half-cell.
 */
function somOrBare(n) {
  const full = `${signed(n)}${NBSP}so'm`
  return cps(full).length <= COL.sum ? full : signed(n)
}

// ─── Dates ─────────────────────────────────────────────────────────────────────

const DD_MM_YYYY = /^\d{2}\.\d{2}\.\d{4}/
const NO_DAY = '??.??.????'

/**
 * DD.MM.YYYY in Tashkent, sliced off tashkentStamp() on purpose: one Tashkent
 * clock in the codebase means the board, the receipt and the toast can never
 * disagree about which day a movement fell on. The regex is the guard — if that
 * format ever changes this prints "??.??.????" instead of silently printing a
 * wrong day, and every unparseable row then groups under one honest separator.
 *
 * This doubles as the GROUPING KEY: two movements share a separator exactly when
 * this string matches, so the key and the label can never disagree either.
 */
function dayKey(at) {
  const s = tashkentStamp(at)
  return DD_MM_YYYY.test(s) ? s.slice(0, 10) : NO_DAY
}

/** The full-width row that opens a day's block. */
const dayLabel = key => `${DAY} ${key}`

/**
 * A key that sorts chronologically for every shape created_at arrives in.
 * SQLite hands back "YYYY-MM-DD HH:MM:SS", which already sorts lexicographically,
 * but a plain String() on a Date would yield "Mon Sep 14 2026 …" and SCRAMBLE a
 * list that arrived correctly ordered — a defensive sort that can corrupt the
 * order is worse than no sort.
 */
function sortKey(v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  return String(v ?? '')
}

// ─── Rows ──────────────────────────────────────────────────────────────────────

/**
 * Pair each reversal with the row it voids, BY PRESENCE IN `rows` — not by the
 * reversed_by column. That is what makes the arithmetic a theorem instead of a
 * promise: a row is dropped from the totals only when its opposite number is
 * also dropped, so the excluded set always sums to exactly zero and
 *
 *     Σ(displayed live) === Σ(every row) === SUM(amount) === balance
 *
 * holds for ANY subset of the ledger, including a partial one. Trusting
 * reversed_by instead would exclude an original whose reversal is not in hand
 * and quietly move the total by that amount.
 *
 * Each original is consumed once; a second reversal aimed at the same original
 * (which the reverse route rejects, but which nothing here can assume) stays
 * live, because its amount genuinely is in SUM(amount).
 *
 * @returns {{ voided: Set<number|string>, hidden: Set<number|string> }}
 */
function pairVoids(rows) {
  const byId = new Map()
  for (const r of rows) if (r?.id !== null && r?.id !== undefined) byId.set(r.id, r)
  const voided = new Set()  // originals: drawn with ✗, excluded from totals
  const hidden = new Set()  // reversals: not drawn at all, excluded from totals
  for (const r of rows) {
    const target = r?.reverses_id
    if (target === null || target === undefined) continue
    if (!byId.has(target) || voided.has(target)) continue
    voided.add(target)
    hidden.add(r.id)
  }
  return { voided, hidden }
}

/**
 * An EDIT is recorded as a reversal plus a re-entry carrying `corrects_id`. Drawn
 * naively that is three rows for one delivery: the ✗ original, the (already
 * hidden) reversal, and the successor — sitting under TODAY's separator, days
 * away from the delivery it describes.
 *
 * So the original is COLLAPSED: moved out of `voided` (drawn ✗) and into
 * `hidden` (not drawn at all), and the successor inherits its position and its
 * day. The reader sees one row for one delivery, marked ✎, where it happened.
 *
 * THE ARITHMETIC IS UNTOUCHED, and that is the point. This moves the pair
 * {original, reversal} — which sums to EXACTLY zero — from {voided, hidden} to
 * {hidden, hidden}, and draws a successor that was already being drawn. Both
 * sets are excluded from the totals either way, so the excluded set still sums
 * to zero and the theorem above still holds for any subset. This changes only
 * WHERE a live row is DRAWN, never which rows are summed.
 *
 * It fires ONLY when the original is present AND genuinely voided in the rows
 * handed in. A `corrects_id` pointing at a row not in hand, or at one whose
 * reversal is missing, is IGNORED and both rows draw normally: under-collapse,
 * never mis-total — the same defensive posture pairVoids() takes.
 *
 * @returns {Map<number|string, object>} successor id → the anchor row it is drawn at
 */
function collapseCorrections(rows, voided, hidden) {
  const byId = new Map()
  for (const r of rows) if (r?.id !== null && r?.id !== undefined) byId.set(r.id, r)

  const direct = new Map()
  for (const s of rows) {
    const target = s?.corrects_id
    if (target === null || target === undefined) continue
    const o = byId.get(target)
    if (!o || !voided.has(o.id)) continue
    voided.delete(o.id)
    hidden.add(o.id)
    direct.set(s.id, o)
  }

  // A row corrected twice chains: s2 → s1 → o. Walk back to the EARLIEST row in
  // hand so every link in the chain lands on the day the delivery happened, not
  // on the day of the previous correction. `seen` is the cycle guard: corrects_id
  // is written once at INSERT on a row that did not exist a moment earlier, so a
  // cycle is impossible — but a renderer that can loop forever on bad data is a
  // renderer that can cost a client their board.
  const anchorOf = new Map()
  for (const id of direct.keys()) {
    const seen = new Set([id])
    let a = direct.get(id)
    while (a && direct.has(a.id) && !seen.has(a.id)) {
      seen.add(a.id)
      a = direct.get(a.id)
    }
    anchorOf.set(id, a)
  }
  return anchorOf
}

/**
 * The NAME row's subject. A handover or return NAMES a product; a payment and an
 * adjustment have none, so they say what they are instead — they still move the
 * balance and must still occupy a row.
 *
 * The kind icon is prefixed to everything EXCEPT a handover. Handovers are the
 * common row and the name is what the owner asked to see in full; the other
 * three are rare, and on them the icon is what separates a return from a payment
 * at a glance, both being negative figures.
 */
function subject(r) {
  const ui = KIND_UI[r?.kind]
  const label = productLabel(r?.category_name, r?.parent_name)
  const icon = ui && r?.kind !== 'handover' ? `${ui.icon} ` : ''
  if (label) return icon + label
  if (ui) return `${ui.icon} ${ui.label}`
  return icon + '?'
}

/**
 * One drawable movement. `qty` is signed by the DIRECTION OF MONEY, matching
 * the heldQty rule in clients.js: a reversed handover keeps kind='handover'
 * with a negative amount, so reading direction from kind would make a voided
 * delivery ADD to what the client holds.
 *
 * `day` and the sort keys come from the ANCHOR when there is one, so a
 * correction is drawn where the delivery happened. The FIGURES always come from
 * the row itself: they are what is live now.
 */
function movement(r, isVoid, anchor) {
  const at = anchor ?? r
  const amount = int(r?.amount)
  const rawQty = r?.qty === null || r?.qty === undefined ? null : int(r.qty)
  return {
    id: r?.id,
    void: isVoid,
    corrected: !!anchor,
    day: dayKey(at?.created_at),
    sortAt: sortKey(at?.created_at),
    sortId: int(at?.id),
    subject: subject(r),
    qty: rawQty === null ? null : (amount < 0 ? -rawQty : rawQty),
    amount,
  }
}

const button = (text, data) => ({ text, callback_data: data })
const gridRow = (cells, data) => cells.map(c => button(c, data))

/**
 * The full-width NAME row. ✗ dominates ✎ — never both marks. The callback is
 * ALWAYS `led:`: the name row is a read, never an edit control, so a tap on it
 * answers with the full name for client and operator alike.
 */
function nameRow(m) {
  const mark = m.void ? `${VOID} ` : m.corrected ? `${EDIT} ` : ''
  const budget = Math.max(COL.label - cps(mark).length, PARENT_FLOOR)
  return [button(mark + fitLabel(m.subject, budget), rowCallback(m.id))]
}

/**
 * The 2-column FIGURES row. On a LIVE row these two cells are the operator's
 * edit control — `edq:` takes the DONA, `eds:` takes the SUMMA — and a
 * non-operator's tap on either is answered with the same detail toast `led:`
 * gives. On a ✗ row all cells carry `led:`: there is nothing on a dead row to
 * edit, so no affordance exists whose only purpose is to be refused. A qty-less
 * row (a payment) has nothing to count, so its DONA cell is inert too, while its
 * SUMMA cell stays editable — the amount IS the row.
 */
function figureRow(m) {
  const mark = m.void ? `${VOID}${NBSP}` : ''
  const qtyText = mark + (m.qty === null ? NONE : `${signed(m.qty)} dona`)
  const sumText = mark + somOrBare(m.amount)
  const qtyCb = m.void || m.qty === null ? rowCallback(m.id) : cb(CB_EDQ, m.id)
  const sumCb = m.void ? rowCallback(m.id) : cb(CB_EDS, m.id)
  return [button(qtyText, qtyCb), button(sumText, sumCb)]
}

/** Separators emitted for a run of movements: one for the first, then on change. */
function separatorCount(ms) {
  let n = 0
  for (let i = 0; i < ms.length; i++) if (i === 0 || ms[i].day !== ms[i - 1].day) n++
  return n
}

// ─── Entry point ───────────────────────────────────────────────────────────────

/**
 * Render the living board.
 *
 * @param {Array<object>} rows   client_ledger joined as LEDGER_SELECT does,
 *                               oldest first, INCLUDING reversals and originals.
 *                               Must be the client's COMPLETE ledger: JAMI is
 *                               derived from it.
 * @param {{ clientName?: string, balance?: number }} [opts]
 *        balance defaults to the derived total; when `rows` is complete the two
 *        are equal by construction (see pairVoids).
 * @returns {{ text: string, reply_markup: { inline_keyboard: Array<Array<object>> } }}
 */
export function buildBoard(rows, { clientName, balance } = {}) {
  // Oldest first is the caller's contract; sorting a copy makes it an invariant
  // instead. Newest at the BOTTOM is the whole point of the layout — the total
  // sits adjacent to the movement that just changed it.
  const list = (Array.isArray(rows) ? rows.filter(Boolean) : [])
    .slice()
    .sort((a, b) => {
      const ta = sortKey(a.created_at), tb = sortKey(b.created_at)
      return ta < tb ? -1 : ta > tb ? 1 : int(a.id) - int(b.id)
    })

  const { voided, hidden } = pairVoids(list)
  const anchorOf = collapseCorrections(list, voided, hidden)

  const movements = list
    .filter(r => !hidden.has(r.id))
    .map(r => movement(r, voided.has(r.id), anchorOf.get(r.id)))
    // Re-sort by the ANCHOR's (created_at, id) so a correction sits at the
    // original's position, under the original's day. Every anchor is a hidden
    // row and ids are unique, so this order is total and deterministic.
    .sort((a, b) => (a.sortAt < b.sortAt ? -1 : a.sortAt > b.sortAt ? 1 : a.sortId - b.sortId))

  // Totals, derived. Every figure below is a fresh reduction over `movements`;
  // nothing is carried, so the board cannot drift from SUM(amount).
  const sumAmount = ms => ms.reduce((t, m) => m.void ? t : t + m.amount, 0)
  const sumQty    = ms => ms.reduce((t, m) => m.void || m.qty === null ? t : t + m.qty, 0)

  // Fold from the oldest until BOTH limits hold. The fold row itself costs a row,
  // so its term is recomputed each pass — it flips the moment foldCount goes 0→1.
  // `foldCount < movements.length` terminates the loop on any degenerate input:
  // an empty visible set always fits.
  const rowsNeeded = (v, folding) => separatorCount(v) + 2 * v.length + (folding ? 1 : 0) + 2
  let foldCount = Math.max(movements.length - VISIBLE_MAX, 0)
  while (foldCount < movements.length &&
         rowsNeeded(movements.slice(foldCount), foldCount > 0) > ROW_BUDGET) foldCount++

  const folded  = movements.slice(0, foldCount)
  const visible = movements.slice(foldCount)

  const totalAmount = sumAmount(movements)
  const totalQty    = sumQty(movements)

  const inline_keyboard = []

  // The fold row is the board's top row, so the visible movements stay contiguous
  // and the newest still touches the total. Its COUNT is every folded movement
  // (they all happened); its FIGURES obey the totals rule and count only the live
  // ones, so fold + visible + JAMI stay one consistent arithmetic. No so'm: at
  // 16.86 em of 18 the row has no room for a unit, and it carries two figures
  // whose units the reader already has from the columns below.
  if (foldCount > 0) {
    const text = `+${foldCount} oldingi · ${signed(sumQty(folded))} dona · ${signed(sumAmount(folded))}`
    inline_keyboard.push([button(text, CB_HDR)])
  }

  // A separator for the FIRST visible movement always — the fold row hides the
  // context above it, so an unopened day would leave the top row dateless — and
  // thereafter only when the Tashkent day changes.
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i]
    if (i === 0 || m.day !== visible[i - 1].day) {
      inline_keyboard.push([button(dayLabel(m.day), CB_HDR)])
    }
    inline_keyboard.push(nameRow(m))
    inline_keyboard.push(figureRow(m))
  }

  // An overpaid client gets the MAGNITUDE under a flipped label, exactly as
  // balanceLine() in notify.js does: "OLDINDAN TO'LOV · −160 000" prints the
  // minus twice and reads as a broken bot.
  const totalLabel = totalAmount >= 0 ? TOTAL_DEBT : TOTAL_CREDIT
  inline_keyboard.push([button(`${RULE} ${totalLabel} ${RULE}`, CB_HDR)])
  inline_keyboard.push(gridRow([`${signed(totalQty)} dona`, somOrBare(Math.abs(totalAmount))], CB_HDR))

  const shown = balance === null || balance === undefined ? totalAmount : int(balance)
  return { text: boardText(clientName, shown), reply_markup: { inline_keyboard } }
}

/**
 * The message body. The keyboard is a grid of buttons that no client can search,
 * copy or quote, so the one thing a client actually needs — who this is and what
 * they owe — lives in real text, in bold.
 */
function boardText(clientName, balance) {
  const n = int(balance)
  const label = n >= 0 ? 'Jami qarz' : "Oldindan to'lov"
  // Slice RAW, escape LAST.
  const name = esc(fitTail(String(clientName ?? '').trim() || '?', NAME_MAX))
  return `📦 <b>${name}</b> · ${label}: <b>${som(n)}</b>`
}

// server/board-image.js — the living board as ONE PICTURE.
//
// Sibling of receipt-image.js. That file renders ONE DELIVERY as a warehouse
// docket; this one renders a CLIENT'S WHOLE LEDGER as a standing statement card
// that is replaced in place (editMessageMedia) on every movement.
//
//   boardImage(rows, { clientName, balance }) -> { svg, width, height, caption }
//
// `rows` is the client's COMPLETE ledger as LEDGER_SELECT joins it, oldest
// first, INCLUDING reversals and the rows they reverse — the same contract
// buildBoard() takes, because the two renderers are two views of one board and a
// second contract is a second source of truth.
//
// It talks to nothing: no db, no Telegram, no clock beyond the row timestamps.
// Pure function in, SVG string out. resvg lays out NOTHING — every x, every y,
// every line break is computed here.
//
// Form: the same manila stock on the same dark desk as the docket, but the docket
// is a dated one-off and this is a running account, so the furniture differs:
//   - a reversed-out HERO BAND at the TOP carrying the balance, the largest ink
//     on the card by ~3×, because the balance is the one figure a client must
//     read without opening the picture;
//   - ruled DAY SEPARATORS, one per Tashkent day, in place of the docket's
//     stamped SANA field;
//   - ONE LINE PER MOVEMENT (name · dona · summa), not the two keyboard rows
//     buildBoard() is forced into: a picture has no equal-width-button rule, so
//     the longest real catalogue label and its figures share a line with room
//     to spare (verified by measurement below);
//   - the docket's double-ruled JAMI, kept verbatim, because a total must put
//     its figures in the SAME COLUMNS as the figures it sums.
//
// ─── WHAT IS DUPLICATED, AND WHY ──────────────────────────────────────────────
//
// receipt-image.js exports `receiptSvg` and `receiptCaption`; board-grid.js
// exports `buildBoard`. Neither exports the parts this file needs, and this file
// is not permitted to edit them. So two blocks below are COPIES, each marked
// with its source, and both should become shared modules the moment anyone is
// allowed to touch those files (see the report / header note at each block):
//
//   (a) THE INSTRUMENT — metrics.json, has/W/capMid, strip/cleanLabel/cleanText,
//       the numeric-reference esc(), money(), fitTail/fitLabel/fitSize, the
//       palette C and N().  Source: receipt-image.js.
//   (b) THE LEDGER SEMANTICS — pairVoids(), collapseCorrections(), dayKey(),
//       sortKey(), separatorCount() and the movement/anchor sort.
//       Source: board-grid.js.
//
// Nothing is FORKED: no constant is retuned, no rule is restated differently. A
// divergence between this file and either source is a bug in this file.
//
// productLabel(), tashkentStamp() and KIND_UI ARE exported by notify.js and are
// imported, never copied — one Tashkent clock, one naming rule, one icon table.

import fs from 'node:fs'
import { productLabel, tashkentStamp, KIND_UI } from './notify.js'

// ══ (a) THE INSTRUMENT — copied from receipt-image.js ══════════════════════════
// SHOULD BE SHARED. Every line between here and the end of the palette is
// byte-equivalent to receipt-image.js; extracting it to server/render-text.js and
// importing it from both is the correct end state and the only reason it is not
// done here is that receipt-image.js is off limits in this change.

// metrics.json is a BUILD ARTIFACT: every codepoint present in BOTH DejaVuSans
// and DejaVuSans-Bold (5 778 of them), with its advance in em (unitsPerEm 2048).
// Two jobs, one table: width(), because there is no measuring API; and "does the
// font have this character?", which is the only correct emoji test — U+1F488 is
// absent, but (c) (r) (tm) ✗ ✎ are PRESENT and must not be stripped.
const ADV = JSON.parse(fs.readFileSync(new URL('./metrics.json', import.meta.url), 'utf8'))
const CAP = 0.729          // cap height, em — identical in both weights

const has = cp => ADV.r[cp] !== undefined
/** Width of `s` at `size` px in weight 'r'|'b', including tracking. */
function W(s, size, weight = 'r', ls = 0) {
  const t = ADV[weight]
  let em = 0, n = 0
  for (const ch of String(s)) { em += t[ch.codePointAt(0)] ?? 0.60; n++ }
  return em * size + (n > 1 ? ls * (n - 1) : 0)
}
/** Baseline that centres CAPS in the band [top, top+h]. */
const capMid = (top, h, size) => top + h / 2 + (CAP * size) / 2

const ZERO = new Set([0x200d, 0xfe0e, 0xfe0f]) // joiners/selectors: in the cmap, zero-width
const PATH_SEP = ' › '
function strip(s) {
  let out = ''
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0)
    if (ZERO.has(cp) || !has(cp)) continue
    out += ch
  }
  return out.replace(/\s+/g, ' ').trim()
}
/**
 * Sanitise a product label WITHOUT destroying productLabel()'s disambiguation.
 * notify.js keeps a parent that tokenises to nothing ("💈") on purpose, because a
 * suppressed parent is an ambiguous row nobody can recover from. Stripping per
 * SEGMENT and substituting "?" for a segment that empties keeps that promise:
 * "💈 › Damas" prints "? › Damas", never the bare "Damas" of another parent, and
 * "!Tikuvda tarpetka💈 › Damas" prints "!Tikuvda tarpetka › Damas" — the segment
 * survives the emoji, so the disambiguation survives with it.
 */
function cleanLabel(s) {
  const segs = String(s ?? '').split('›').map(x => strip(x)).map(x => x || '?')
  return segs.join(PATH_SEP) || '?'
}
const cleanText = s => strip(s)

// XML-escape, then fold EVERY non-ASCII codepoint to a numeric character
// reference. The emitted SVG is pure ASCII, so no transport, editor or shell can
// mangle the U+00A0 money separators, the U+203A path arrow, the ✗ or "Абдурахим".
// Escaping happens ONCE, after slicing — slicing an escaped string can cut
// "&amp;" in half, which is how "Qora & Oq" once cost a client their receipts.
const esc = s => {
  let out = ''
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0)
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else if (cp > 0x7e) out += `&#${cp};`
    else out += ch
  }
  return out
}

// U+00A0. Named NBSP but holding an ordinary U+0020, this let a caption break
// mid-figure -- "1 880" ending a line with "000" beneath it, which on a
// statement of account is a trust defect, not a typographic one.
const NBSP = '\u00A0'
const MINUS = '−'  // U+2212, never an ASCII hyphen
const ELL = '…'
/** money(): byte-for-byte the helper in notify.js — U+00A0 groups, magnitude only. */
const money = n => String(Math.abs(Math.trunc(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

/** Tail truncation by CODEPOINT (never UTF-16 unit) with U+2026, re-measured each step. */
function fitTail(s, budget, size, weight = 'r', ls = 0) {
  if (W(s, size, weight, ls) <= budget) return s
  const cp = [...s]
  for (let n = cp.length - 1; n > 0; n--) {
    const cut = cp.slice(0, n).join('').replace(/[\s›]+$/u, '') + ELL
    if (W(cut, size, weight, ls) <= budget) return cut
  }
  return ELL
}
/**
 * The product-label rule: parent-first. The leaf is the token productLabel()
 * exists to print, so "!Tikuvda tarp… › Damas" beats "!Tikuvda tarpetka › Da…".
 * Parent stub floor is 6 codepoints; below that, fall back to tail truncation.
 */
function fitLabel(s, budget, size, weight = 'r') {
  if (W(s, size, weight) <= budget) return s
  const i = s.indexOf(PATH_SEP)
  if (i > 0) {
    const parent = [...s.slice(0, i)], tail = s.slice(i)
    for (let n = parent.length - 1; n >= PARENT_FLOOR; n--) {
      const cand = parent.slice(0, n).join('').trimEnd() + ELL + tail
      if (W(cand, size, weight) <= budget) return cand
    }
  }
  return fitTail(s, budget, size, weight)
}
/** Figures are NEVER truncated — a cut so'm figure is a lie. They step DOWN instead. */
function fitSize(s, budget, size, weight = 'r', min = 8.5, step = 0.5) {
  let f = size
  while (f > min && W(s, f, weight) > budget) f -= step
  return Number(f.toFixed(2))
}

// One committed look: warm manila stock on a dark desk. The PNG is opaque, so the
// viewer's Telegram theme only ever touches the 6px surround.
const C = {
  desk:  '#23221D',
  paper: '#F2EFE6',
  zebra: '#EBE7DA',
  panel: '#DED8C6',
  ink:   '#1C1B16',
  faint: '#514D40',
  rule:  '#B4AC97',
  up:    '#9E2F1D',  // the debt ROSE
  down:  '#155C4C',  // the debt FELL
  // NEW, and the only addition to the docket's palette: C.down is chosen to read
  // as ink on manila and is invisible on C.ink, so the hero band — which has no
  // counterpart on the docket — needs a credit tint that survives a dark ground.
  credit: '#8ED9C4',
}
const N = v => Number(Number(v).toFixed(3))

// ══ (b) THE LEDGER SEMANTICS — copied from board-grid.js ═══════════════════════
// SHOULD BE SHARED. pairVoids/collapseCorrections/dayKey/sortKey/separatorCount
// are the board's MEANING, not its pixels: the two board renderers must agree
// about which rows are voided, which are hidden, where a correction is drawn and
// which day a movement fell on, or the picture and the keyboard become two boards.
// board-grid.js should export them; until it may, they are copied verbatim.

const int = n => Math.trunc(Number(n) || 0)
/** Table cells carry their own sign: plain when positive, U+2212 when negative. */
const signed = n => (int(n) < 0 ? MINUS : '') + money(n)
/** A figure with its unit attached, unbreakably: "2 400 000 so'm". */
const som = n => `${money(n)}${NBSP}so'm`

const PARENT_FLOOR = 6   // receipt-image.js's floor: below this a parent stub says nothing
const DD_MM_YYYY = /^\d{2}\.\d{2}\.\d{4}/
const NO_DAY = '??.??.????'

/**
 * DD.MM.YYYY in Tashkent (UTC+5, no DST), sliced off tashkentStamp() on purpose:
 * one Tashkent clock in the codebase means the board, the receipt and the toast
 * can never disagree about which day a movement fell on. The regex is the guard —
 * if that format ever changes this prints "??.??.????" instead of silently
 * printing a wrong day. This doubles as the GROUPING KEY, so the key and the
 * label can never disagree either.
 */
function dayKey(at) {
  const s = tashkentStamp(at)
  return DD_MM_YYYY.test(s) ? s.slice(0, 10) : NO_DAY
}

/**
 * A key that sorts chronologically for every shape created_at arrives in.
 * A plain String() on a Date would yield "Mon Sep 14 2026 …" and SCRAMBLE a list
 * that arrived correctly ordered — a defensive sort that can corrupt the order is
 * worse than no sort.
 */
function sortKey(v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  return String(v ?? '')
}

/**
 * Pair each reversal with the row it voids, BY PRESENCE IN `rows` — not by the
 * reversed_by column. That is what makes the arithmetic a theorem instead of a
 * promise: a row is dropped from the totals only when its opposite number is also
 * dropped, so the excluded set always sums to exactly zero and
 *
 *     Σ(displayed live) === Σ(every row) === SUM(amount) === balance
 *
 * holds for ANY subset of the ledger, including a partial one. Trusting
 * reversed_by instead would exclude an original whose reversal is not in hand and
 * quietly move the total by that amount.
 */
function pairVoids(rows) {
  const byId = new Map()
  for (const r of rows) if (r?.id !== null && r?.id !== undefined) byId.set(r.id, r)
  const voided = new Set()  // originals: drawn struck, excluded from totals
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
 * naively that is three rows for one delivery. So the original is COLLAPSED:
 * moved out of `voided` (drawn struck) and into `hidden` (not drawn at all), and
 * the successor inherits its position and its day. One row for one delivery,
 * marked ✎, where it happened.
 *
 * THE ARITHMETIC IS UNTOUCHED: this moves the pair {original, reversal} — which
 * sums to EXACTLY zero — from {voided, hidden} to {hidden, hidden}, and draws a
 * successor that was already being drawn. This changes only WHERE a live row is
 * DRAWN, never which rows are summed.
 *
 * It fires ONLY when the original is present AND genuinely voided in the rows
 * handed in: under-collapse, never mis-total.
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
  // hand. `seen` is the cycle guard: a renderer that can loop forever on bad data
  // is a renderer that can cost a client their board.
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

/** Separators emitted for a run of movements: one for the first, then on change. */
function separatorCount(ms) {
  let n = 0
  for (let i = 0; i < ms.length; i++) if (i === 0 || ms[i].day !== ms[i - 1].day) n++
  return n
}

// ══ THE PICTURE ═══════════════════════════════════════════════════════════════

const G = {
  W: 360, SCALE: 3, EDGE: 6,
  L: 16, R: 344,
  X_NAME: 21,
  HERO: 68, GAP: 9, BOT: 7,
  DAY: 17, ROW: 19, FOLD: 19, EMPTY: 30, TOTAL: 26,
  MIN_NAME: 140,
  // THE FOLD RULE, stated once and enforced in exactly one loop below:
  //
  //   The card's height may never exceed ASPECT_MAX × its width. Movements are
  //   folded from the OLDEST, one at a time, into a single "+N oldingi" row until
  //   it does not — and that row costs a row itself, so its term is recomputed on
  //   every pass and flips the moment foldCount goes 0→1. The newest movement is
  //   therefore always drawn, and the total always touches it.
  //
  // 1.30, tighter than the docket's 1.40, because the docket is a one-off a
  // client taps open and this is a standing message they read in the stream:
  // Telegram scales a photo down to fit the bubble, and every pixel of height
  // spent is width — i.e. legibility — taken from the balance.
  //
  // [UNCERTAIN: I cannot observe Telegram's actual preview crop from this
  // checkout, and I will not reconstruct a client-side constant from memory. The
  // design does not depend on the number: the balance is the FIRST thing on the
  // card, in the top 68px of a ≤468px card, so any top-anchored crop keeps it
  // whole, and the caption carries it in text for the chat-list line and the
  // push notification. ASPECT_MAX is the legibility budget, not a crop oracle.]
  ASPECT_MAX: 1.30,
}

const VOID = '✗'  // U+2717 — present in both faces; see the metrics check
const EDIT = '✎'  // U+270E — the correction mark. NOT ✏️, which has no glyph here
const NONE = '—'  // the DONA cell of a movement that has no quantity
const TOTAL_DEBT   = 'JAMI QARZ'
const TOTAL_CREDIT = "OLDINDAN TO'LOV"
const EMPTY_LINE   = "Hali harakat yo'q"

/**
 * The NAME cell's subject. A handover or return NAMES a product; a payment and an
 * adjustment have none, so they say what they are instead — they still move the
 * balance and must still occupy a row.
 *
 * NO KIND ICON, unlike buildBoard()'s subject(): ↩️ 💵 ✏️ are absent from
 * DejaVu and strip() would delete them, leaving a blank where the direction was
 * supposed to be. In the picture direction is carried by the SIGNED figures
 * instead — "−3 dona / −270 000" is a return, "— / −360 000" is a payment — which
 * is board-grid's own qty rule and needs no glyph the font does not have.
 */
function subject(r) {
  const raw = productLabel(r?.category_name, r?.parent_name)
  if (raw) return cleanLabel(raw)
  const ui = KIND_UI[r?.kind]
  return ui ? cleanText(ui.label) || '?' : '?'
}

/**
 * One drawable movement. `qty` is signed by the DIRECTION OF MONEY, matching the
 * heldQty rule in clients.js: a reversed handover keeps kind='handover' with a
 * negative amount, so reading direction from kind would make a voided delivery
 * ADD to what the client holds.
 *
 * `day` and the sort keys come from the ANCHOR when there is one, so a correction
 * is drawn where the delivery happened. The FIGURES always come from the row
 * itself: they are what is live now.
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

/** The mark that opens a name cell. ✗ DOMINATES ✎ — never both, never "✎✗". */
const markOf = m => (m.void ? `${VOID} ` : m.corrected ? `${EDIT} ` : '')
const qtyText = m => (m.qty === null ? NONE : `${signed(m.qty)} dona`)

/**
 * Render the living board as a picture.
 *
 * @param {Array<object>} rows   client_ledger joined as LEDGER_SELECT does,
 *                               oldest first, INCLUDING reversals and originals.
 *                               Must be the client's COMPLETE ledger: JAMI is
 *                               derived from it.
 * @param {{ clientName?: string, balance?: number }} [opts]
 *        balance defaults to the derived total; when `rows` is complete the two
 *        are equal by construction (see pairVoids).
 * @returns {{ svg: string, width: number, height: number, caption: string }}
 *        width/height are the VIEWBOX units (px of the card), not the rasterised
 *        pixels — the <svg> element itself asks for G.SCALE× that, exactly as
 *        receiptSvg() does, so a caller sizing a Telegram upload multiplies.
 */
export function boardImage(rows, opts) {
  // `opts ?? {}` rather than a default parameter: a default only fires on
  // `undefined`, and a caller that passes an explicitly null options object
  // would throw on destructuring. A renderer that can throw is a renderer that
  // can cost a client their board — the caller falls back to text, but only
  // after the picture has already failed for a reason that is not the picture.
  const { clientName, balance } = opts ?? {}
  // Oldest first is the caller's contract; sorting a copy makes it an invariant.
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
    // original's position, under the original's day.
    .sort((a, b) => (a.sortAt < b.sortAt ? -1 : a.sortAt > b.sortAt ? 1 : a.sortId - b.sortId))

  // Totals, derived. Every figure below is a fresh reduction over `movements`;
  // nothing is carried, so the card cannot drift from SUM(amount).
  const sumAmount = ms => ms.reduce((t, m) => m.void ? t : t + m.amount, 0)
  const sumQty    = ms => ms.reduce((t, m) => m.void || m.qty === null ? t : t + m.qty, 0)

  // ── the fold, in pixels ───────────────────────────────────────────────────
  // FIXED is everything that is not a movement, a separator or the fold row, so
  // no content term can be forgotten out of the height formula.
  const fixed = G.EDGE + G.HERO + G.GAP + G.TOTAL + G.BOT + G.EDGE
  const bodyH = (v, folding) =>
    (folding ? G.FOLD : 0) + separatorCount(v) * G.DAY + v.length * G.ROW
  const heightOf = (v, folding) => fixed + bodyH(v, folding) + (movements.length ? 0 : G.EMPTY)

  const CEIL = G.ASPECT_MAX * G.W
  let foldCount = 0
  while (foldCount < movements.length &&
         heightOf(movements.slice(foldCount), foldCount > 0) > CEIL) foldCount++

  const folded  = movements.slice(0, foldCount)
  const visible = movements.slice(foldCount)

  const totalAmount = sumAmount(movements)
  const totalQty    = sumQty(movements)
  const shownBal    = balance === null || balance === undefined ? totalAmount : int(balance)

  // ── column arithmetic, derived from THIS board ────────────────────────────
  // The money column is exactly as wide as this board's widest figure and no
  // wider; the DONA column likewise; everything left over goes to the name, the
  // only column that ever truncates. Sizes step DOWN a ladder before any label is
  // cut, because a stepped-down row is still the whole name and a cut one is not.
  const sumStrings = visible.map(m => signed(m.amount))
  const qtyStrings = visible.map(m => qtyText(m))
  if (foldCount > 0) {
    sumStrings.push(signed(sumAmount(folded)))
    qtyStrings.push(`${signed(sumQty(folded))} dona`)
  }
  const totalSumStr = money(Math.abs(totalAmount))
  const totalQtyStr = `${signed(totalQty)} dona`
  const labels = visible.map(m => markOf(m) + m.subject)

  const cand = []
  for (const drop of [0, 0.5, 1, 1.5, 2]) {
    const cell = 10.5 - drop
    const jami = Math.max(10, 12.5 - drop)
    const sums = sumStrings.map(s => W(s, cell, 'b'))
    sums.push(W(totalSumStr, jami, 'b'))
    const qtys = qtyStrings.map(s => W(s, cell))
    qtys.push(W(totalQtyStr, cell - 1, 'b'))
    const colS = G.R - (Math.max(0, ...sums) + 8)
    const colQ = colS - (Math.max(0, ...qtys) + 8)
    const nameBudget = colQ - 5 - G.X_NAME
    const fitsAll = labels.every(l => W(l, cell) <= nameBudget)
    cand.push({ drop, cell, jami, colS, colQ, nameBudget, fitsAll })
  }
  const plan = cand.find(c => c.fitsAll && c.nameBudget >= G.MIN_NAME)
            || cand.find(c => c.nameBudget >= G.MIN_NAME)
            || cand.find(c => c.fitsAll)
            || cand[cand.length - 1]
  const { cell, jami, colS, colQ, nameBudget } = plan
  const xQty = colS - 4, xSum = G.R - 4

  // ── the vertical stack ────────────────────────────────────────────────────
  const yHero  = G.EDGE
  const yTable = yHero + G.HERO + G.GAP
  const emptyH = movements.length ? 0 : G.EMPTY
  const bodyHeight = bodyH(visible, foldCount > 0) + emptyH
  const yTotal = yTable + bodyHeight
  const tableH = bodyHeight + G.TOTAL
  // G.BOT keeps the table's bottom rule off the paper's own edge: flush, the
  // double-ruled JAMI reads as a card that was cut short rather than closed.
  const H      = yTotal + G.TOTAL + G.BOT + G.EDGE

  const o = []
  const push = (...s) => o.push(...s)
  const text = (x, y, s, { size = 10.5, w = 'r', fill = C.ink, anchor, ls } = {}) =>
    `<text x="${N(x)}" y="${N(y)}" font-size="${size}"` +
    (w === 'b' ? ' font-weight="bold"' : '') +
    (anchor ? ` text-anchor="${anchor}"` : '') +
    (ls ? ` letter-spacing="${ls}"` : '') +
    ` fill="${fill}">${esc(s)}</text>`
  // A tracked run is ALWAYS start-anchored at a computed x: end-anchoring a run
  // with letter-spacing leaves the trailing track inside the measured advance.
  const tracked = (xEnd, y, s, opt) => text(xEnd - W(s, opt.size, opt.w ?? 'r', opt.ls), y, s, opt)
  const rect = (x, y, w, h, fill) => `<rect x="${N(x)}" y="${N(y)}" width="${N(w)}" height="${N(h)}" fill="${fill}"/>`
  const hline = (x1, y, x2, stroke, sw = 1) => `<path d="M${N(x1)} ${N(y)}H${N(x2)}" stroke="${stroke}" stroke-width="${sw}"/>`

  push(rect(0, 0, G.W, H, C.desk))
  push(rect(G.EDGE, G.EDGE, G.W - 2 * G.EDGE, H - 2 * G.EDGE, C.paper))

  // ── 1. the hero: the balance, and nothing else competing with it ──────────
  // First on the card, reversed out of ink, at ~3× the largest figure below it.
  // A client reading the stream sees one number. The docket's stub puts the
  // balance LAST because a docket is read top-to-bottom once; a standing board is
  // glanced at, and a glance lands on the top-left.
  const credit = shownBal < 0
  const balLabel = credit ? TOTAL_CREDIT : TOTAL_DEBT
  push(rect(G.EDGE, yHero, G.W - 2 * G.EDGE, G.HERO, C.ink))

  const yName = yHero + 20, yBal = yHero + 53
  const labS = 8, labLS = 1.2
  const labW = W(balLabel, labS, 'b', labLS)
  if (credit) {
    // CREDIT is marked by the PRESENCE OF A SHAPE, not by a hue and a small word
    // — receipt-image.js's rule for the stub, kept here: a filled pill the debt
    // state does not have, the flipped label, and the figure in the same tint.
    // No minus ever touches the figure; the magnitude sits under a flipped label.
    push(`<rect x="${N(G.R - labW - 13)}" y="${N(yName - 11)}" width="${N(labW + 14)}" height="15" rx="7.5" fill="${C.credit}"/>`)
    push(tracked(G.R - 7, yName, balLabel, { size: labS, w: 'b', fill: C.ink, ls: labLS }))
  } else {
    push(tracked(G.R, yName, balLabel, { size: labS, w: 'b', fill: C.rule, ls: labLS }))
  }
  const nameBud = (G.R - labW - 22) - G.L
  push(text(G.L, yName, fitTail(cleanText(clientName) || '?', nameBud, 11.5, 'b'), { size: 11.5, w: 'b', fill: C.paper }))

  const balInk = credit ? C.credit : C.paper
  const somS = 13, somW = W("so'm", somS) + 5
  const balS = fitSize(money(shownBal), G.R - G.L - somW, 30, 'b', 18, 1)
  push(text(G.L, yBal, money(shownBal), { size: balS, w: 'b', fill: balInk }))
  push(text(G.L + W(money(shownBal), balS, 'b') + 5, yBal, "so'm", { size: somS, fill: credit ? C.credit : C.rule }))

  // ── 2. the table ──────────────────────────────────────────────────────────
  let y = yTable
  let zebra = 0

  // The fold row is the board's TOP row, so the visible movements stay contiguous
  // and the newest still touches the total. Its COUNT is every folded movement
  // (they all happened); its FIGURES obey the totals rule and count only the live
  // ones, so fold + visible + JAMI stay one consistent arithmetic.
  if (foldCount > 0) {
    const base = y + 13
    push(rect(G.L + 0.6, y, G.R - G.L - 1.2, G.FOLD, C.panel))
    push(text(G.X_NAME, base, `+${foldCount} oldingi`, { size: cell, fill: C.faint }))
    const fq = `${signed(sumQty(folded))} dona`, fs = signed(sumAmount(folded))
    push(text(xQty, base, fq, { size: fitSize(fq, xQty - colQ - 4, cell), fill: C.faint, anchor: 'end' }))
    push(text(xSum, base, fs, { size: fitSize(fs, xSum - colS - 4, cell, 'b'), w: 'b', fill: C.faint, anchor: 'end' }))
    y += G.FOLD
  }

  for (let i = 0; i < visible.length; i++) {
    const m = visible[i]
    // A separator for the FIRST visible movement always — the fold row hides the
    // context above it, so an unopened day would leave the top row dateless — and
    // thereafter only when the Tashkent day changes. 📅 is ABSENT from DejaVu, so
    // where buildBoard() needs an emoji to tell a date row from a name row, the
    // picture uses the rule itself: a hairline running to the right margin is a
    // shape no movement row has.
    if (i === 0 || m.day !== visible[i - 1].day) {
      // Indented to X_NAME, not to L: L is where the table's own border rule is,
      // and a date sitting on it reads as a clipped digit.
      const db = y + 12
      push(text(G.X_NAME, db, m.day, { size: 8, w: 'b', fill: C.faint, ls: 0.8 }))
      push(hline(G.X_NAME + W(m.day, 8, 'b', 0.8) + 7, db - 3, G.R - 4, C.rule, 0.7))
      y += G.DAY
      zebra = 0
    }
    const top = y, base = top + 13
    if (zebra % 2 === 1) push(rect(G.L + 0.6, top, G.R - G.L - 1.2, G.ROW, C.zebra))
    if (zebra > 0) push(hline(G.L, top, G.R, C.rule, 0.5))
    // A reversed movement STAYS VISIBLE, struck, and excluded from the totals.
    // The picture has the channel buttons lack: a real strike, plus faded ink.
    // The ✗ mark is kept anyway, so the picture and the keyboard board mark the
    // same row the same way.
    const ci = m.void ? C.faint : C.ink
    push(text(G.X_NAME, base, fitLabel(markOf(m) + m.subject, nameBudget, cell), { size: cell, fill: ci }))
    const q = qtyText(m), s = signed(m.amount)
    push(text(xQty, base, q, { size: fitSize(q, xQty - colQ - 4, cell), fill: C.faint, anchor: 'end' }))
    push(text(xSum, base, s, { size: fitSize(s, xSum - colS - 4, cell, 'b'), w: 'b', fill: ci, anchor: 'end' }))
    if (m.void) push(hline(G.X_NAME - 3, base - 3.5, xSum + 2, C.ink, 0.9))
    y += G.ROW
    zebra++
  }

  if (emptyH) {
    push(text(G.X_NAME, y + 19, EMPTY_LINE, { size: 10.5, fill: C.faint }))
    y += G.EMPTY
  }

  // ── 3. the derived JAMI ───────────────────────────────────────────────────
  // Double-ruled, in the docket's own furniture. An overpaid client gets the
  // MAGNITUDE under a flipped label, exactly as balanceLine() in notify.js and
  // buildBoard() do: "OLDINDAN TO'LOV · −160 000" prints the minus twice and
  // reads as a broken bot.
  push(rect(G.L + 0.6, yTotal, G.R - G.L - 1.2, G.TOTAL, C.panel))
  push(hline(G.L, yTotal, G.R, C.ink, 1))
  push(hline(G.L, yTotal + 2.4, G.R, C.ink, 0.6))
  const tb = capMid(yTotal + 2.4, G.TOTAL - 2.4, 11)
  push(text(G.X_NAME, tb, totalAmount >= 0 ? TOTAL_DEBT : TOTAL_CREDIT,
    { size: fitSize(totalAmount >= 0 ? TOTAL_DEBT : TOTAL_CREDIT, colQ - 6 - G.X_NAME, 10, 'b', 7.5), w: 'b', ls: 1.1 }))
  push(text(xQty, tb, totalQtyStr, { size: fitSize(totalQtyStr, xQty - colQ - 4, cell - 1, 'b'), w: 'b', anchor: 'end' }))
  push(text(xSum, tb, totalSumStr, { size: fitSize(totalSumStr, xSum - colS - 4, jami, 'b', 10), w: 'b', anchor: 'end' }))

  // rules last, and THROUGH the JAMI row so its two figures never abut
  for (const x of [colQ, colS]) push(`<path d="M${N(x)} ${N(yTable)}V${N(yTotal + G.TOTAL)}" stroke="${C.rule}" stroke-width="0.7"/>`)
  push(`<rect x="${N(G.L)}" y="${N(yTable)}" width="${N(G.R - G.L)}" height="${N(tableH)}" fill="none" stroke="${C.ink}" stroke-width="1.1"/>`)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${G.W * G.SCALE}" height="${N(H * G.SCALE)}" ` +
    `viewBox="0 0 ${G.W} ${N(H)}" font-family="DejaVu Sans">` + o.join('') + '</svg>'

  return {
    svg, width: G.W, height: H,
    caption: boardCaption(list.length ? list[list.length - 1] : null, shownBal),
    // Diagnostics. Not part of the contract, and nothing downstream may compute
    // money from them — they exist so a test can assert the theorem out loud.
    aspect: Number((H / G.W).toFixed(3)),
    foldCount, visibleCount: visible.length, totalAmount, totalQty, plan, balance: shownBal,
  }
}

// ── The caption ───────────────────────────────────────────────────────────────
// ONE line. It is the client's NOTIFICATION (editing a message notifies nobody,
// so each movement also posts one short line) and the only searchable, copyable,
// screen-reader-readable part of the board — and it carries the emoji the picture
// cannot, because Telegram renders a caption with the system emoji font.
//
// Three things, in the order a client asks them: what happened, for how much,
// and what they now owe.
//
// DIRECTION comes from the verb where the verb states it, and from an explicit
// sign where it does not — notify.js's own rule ("Adjustments are the one message
// whose direction no verb states", signed()). So:
//   handover / return / payment  → magnitude. "Berildi", "Qaytarildi",
//                                  "To'landi" each say which way the debt went.
//   adjustment / reversal        → SIGNED. "Tuzatish" and "Bekor qilindi" do
//                                  not, and a reversal OF A PAYMENT raises the
//                                  debt while its verb reads "cancelled".
//
// // DECISION: a CORRECTION (corrects_id set) reads "✏️ Tuzatish · <new amount>",
// unsigned. Its verb must not be "Berildi" — no new delivery happened — and its
// figure is the row's own amount, i.e. WHAT THE DELIVERY IS NOW WORTH, not the
// net delta from the row it replaces. A signed delta would assert a movement the
// figure is not, and the balance on the same line is already authoritative for
// the net. Precedence: reversal > correction > kind.
const CAP_UI = {
  // Built FROM notify.js's table so the icons and words can never fork.
  ...Object.fromEntries(Object.entries(KIND_UI).map(([k, v]) => [k, { ...v, signed: k === 'adjustment' }])),
  reversal:   { icon: '❌', label: 'Bekor qilindi', signed: true },
  correction: { ...KIND_UI.adjustment, signed: false },
}
const BOARD_ICON = '📦'
// The caption goes out as parse_mode HTML. This is NOT the SVG esc() above and
// the two must never be crossed: numeric character references in a Telegram
// caption print as literal "&#1080;".
const capEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * @param {object|null} latest  the newest row by (created_at, id) over the WHOLE
 *        input — a reversal included, because a reversal IS the event the client
 *        is being notified about even though the board does not draw its row.
 * @param {number} balance      the figure the hero prints.
 */
function boardCaption(latest, balance) {
  const n = int(balance)
  const balLab = n >= 0 ? 'Jami qarz' : "Oldindan to'lov"
  const tail = `${capEsc(balLab)}: <b>${capEsc(som(n))}</b>`
  if (!latest) return `${BOARD_ICON} ${tail}`

  const isReversal   = latest.reverses_id !== null && latest.reverses_id !== undefined
  const isCorrection = latest.corrects_id !== null && latest.corrects_id !== undefined
  const ui = isReversal ? CAP_UI.reversal
           : isCorrection ? CAP_UI.correction
           : (CAP_UI[latest.kind] ?? CAP_UI.adjustment)
  const amount = int(latest.amount)
  const fig = ui.signed
    ? `${amount < 0 ? MINUS : '+'}${som(amount)}`
    : som(amount)
  return `${ui.icon} <b>${capEsc(ui.label)}</b> · ${capEsc(fig)} · ${tail}`
}

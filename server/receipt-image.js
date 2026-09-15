// server/receipt-image.js — the receipt PNG. One SVG string per receipt, rendered
// by @resvg/resvg-js with DejaVu Sans (Regular + Bold) and nothing else.
// resvg lays out NOTHING: every x, every y, every line break is computed here.
//
// Form: a warehouse goods docket on manila stock — reversed-out kind band with a
// hung +/- sign, two stamped form fields, a ruled MAHSULOT/MIQDOR/SUMMA table
// with a double-ruled JAMI, and a perforated tear-off stub carrying the balance.

import fs from 'node:fs'

// ── Font metrics ──────────────────────────────────────────────────────────────
// metrics.json is a BUILD ARTIFACT: every codepoint present in BOTH DejaVuSans
// and DejaVuSans-Bold (5 778 of them), with its advance in em (unitsPerEm 2048).
// Two jobs, one table:
//   1. width(), because there is no measuring API;
//   2. "does the font have this character?", which is the only correct emoji test
//      — U+1F488 is absent, but (c) (r) (tm) are PRESENT and must not be stripped.
// Kerning is deliberately ignored: DejaVu's GPOS pairs are almost all negative,
// so a sum of advances is a conservative UPPER bound.
const ADV = JSON.parse(fs.readFileSync(new URL('./metrics.json', import.meta.url), 'utf8'))
const CAP = 0.729          // cap height, em — identical in both weights (H yMax 1493/2048)
const SIGN_ADV = 0.83789   // '+' and U+2212, bold: same advance,
const SIGN_LSB = 0.10596   //   same left side bearing,
const SIGN_MID = 0.313475  //   same ink centre. One hang rule serves both.
const SIGN_RAISE = CAP / 2 - SIGN_MID // 0.051025em: puts the sign's ink centre on the caps' centre

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

// ── Text sanitising ───────────────────────────────────────────────────────────
// Emoji never reach the image: there is no colour-emoji font, so 💈 rasterises as
// .notdef. The predicate is "absent from the shipped faces", not a pictographic
// regex — DejaVu HAS (c)(r)(tm)(checkmark) and those are the owner's text.
// Applied to EVERY printed string: labels, client name, note, aggregate row.
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
 * suppressed parent is an ambiguous receipt nobody can recover from. Stripping
 * per SEGMENT and substituting "?" for a segment that empties keeps that promise:
 * "💈 › Damas" prints "? › Damas", never the bare "Damas" of another parent.
 */
function cleanLabel(s) {
  const segs = String(s ?? '').split('›').map(x => strip(x)).map(x => x || '?')
  const out = segs.join(PATH_SEP)
  return out.replace(/^\? › /, '? › ') || '?'
}
const cleanText = s => strip(s)

// XML-escape, then fold EVERY non-ASCII codepoint to a numeric character
// reference. The emitted SVG is pure ASCII, so no transport, editor or shell can
// mangle the U+00A0 money separators, the U+203A path arrow or "Абдурахим".
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

const NBSP = ' '
const MINUS = '−'
const ELL = '…'
/** money(): byte-for-byte the helper in notify.js — U+00A0 groups, magnitude only. */
const money = n => String(Math.abs(Math.trunc(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

// ── Fitting ───────────────────────────────────────────────────────────────────
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
    for (let n = parent.length - 1; n >= 6; n--) {
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
/**
 * The note is the only wrapped text. Greedy by word, with a CHARACTER-level hard
 * break so a 120-character URL or card number cannot produce one 900px line.
 */
function wrapNote(s, budget, size, maxLines = 2) {
  const words = String(s).split(' ').filter(Boolean)
  const lines = []
  let cur = ''
  const flush = () => { if (cur) { lines.push(cur); cur = '' } }
  for (const word of words) {
    if (lines.length >= maxLines) break
    const next = cur ? cur + ' ' + word : word
    if (W(next, size) <= budget) { cur = next; continue }
    flush()
    let w = word
    while (W(w, size) > budget && lines.length < maxLines) {   // hard break
      const cp = [...w]
      let n = cp.length
      while (n > 1 && W(cp.slice(0, n).join(''), size) > budget) n--
      lines.push(cp.slice(0, n).join(''))
      w = cp.slice(n).join('')
    }
    cur = w
    if (lines.length >= maxLines) { cur = ''; break }
  }
  flush()
  const joined = lines.join(' ').replace(/\s+/g, ' ')
  if (joined.length < String(s).replace(/\s+/g, ' ').length && lines.length) {
    lines[lines.length - 1] = fitTail(lines[lines.length - 1] + ELL, budget, size)
  }
  return lines.slice(0, maxLines)
}

// ── Palette ───────────────────────────────────────────────────────────────────
// One committed look: warm manila stock on a dark desk. The PNG is opaque, so the
// viewer's Telegram theme only ever touches the 6px surround — which is exactly
// why the surround is dark: the docket floats on a hairline in dark mode instead
// of glaring, and reads as a photographed paper ticket in light mode.
const C = {
  desk:  '#23221D',
  paper: '#F2EFE6',
  zebra: '#EBE7DA',
  panel: '#DED8C6',
  stub:  '#E4DFD1',
  ink:   '#1C1B16',
  faint: '#514D40',
  rule:  '#B4AC97',
  up:    '#9E2F1D',  // the debt ROSE  — handover, reversed payment, positive adjustment
  down:  '#155C4C',  // the debt FELL  — return, payment, reversed handover, credit
  flat:  '#4A4636',  // movement exactly zero
}

// ── Geometry ──────────────────────────────────────────────────────────────────
const G = {
  W: 360, SCALE: 3, EDGE: 6,
  L: 16, R: 344,
  X_NUM: 29, X_NAME: 38, COL_N: 34,
  BAND: 40, META: 48, REF: 16, HEAD: 15, ROW: 20, TOTAL: 24,
  PAY: 52, PERF: 8, STUB: 74, CORR: 22,
  MIN_ROWS: 3, ASPECT_MAX: 1.40, MIN_NAME: 132,
  META_NAME_R: 206, META_DATE_L: 214,
}
const KIND = {
  handover:   { label: 'BERILDI',       dir: +1 },
  return:     { label: 'QAYTARILDI',    dir: -1 },
  payment:    { label: "TO'LANDI",      dir: -1 },
  reversal:   { label: 'BEKOR QILINDI', dir:  0 },
  adjustment: { label: 'TUZATISH',      dir:  0 },
}
const N = v => Number(Number(v).toFixed(3))

// ── Renderer ──────────────────────────────────────────────────────────────────
export function receiptSvg(r) {
  const kind  = KIND[r.kind] ?? KIND.adjustment
  const items = (Array.isArray(r.items) ? r.items : []).map(i => ({
    label: cleanLabel(i.label), qty: Math.trunc(i.qty) || 0,
    amount: Math.abs(Math.trunc(i.amount) || 0), unit: Math.abs(Math.trunc(i.unit_price ?? 0)),
    // The stamp flag rides along; i.id is deliberately NOT carried — clients.js
    // maps a cancelled ledger row to its item, the renderer never needs an id.
    cancelled: i.cancelled === true,
  }))
  const hasTable = items.length > 0
  const grand = Math.abs(Math.trunc(r.total ?? items.reduce((a, i) => a + i.amount, 0)))

  // DIRECTION comes from the SIGNED movement (sum of the ledger rows' `amount`),
  // never from the kind word: clients.js writes handover +total, return -total,
  // payment -amount, reversal -orig.amount, so a reversal OF A PAYMENT raises the
  // debt while its header reads "Bekor qilindi". Four channels carry it — the
  // verb, the hung sign, the stamped triangle, the stub triangle — colour fifth.
  const delta = Math.trunc(r.delta ?? (kind.dir ? kind.dir * grand : grand))
  const dir = Math.sign(delta)
  const accent = dir > 0 ? C.up : dir < 0 ? C.down : C.flat
  const sign = dir > 0 ? '+' : dir < 0 ? MINUS : ''

  // ── column arithmetic, derived from THIS receipt ──────────────────────────
  // The money column is exactly as wide as this receipt's widest figure and no
  // wider; everything left over goes to MAHSULOT, the only column that ever
  // truncates. FORM A prints "5 × 120 000" in MIQDOR (the unit price the text
  // receipt gives the client); FORM B prints the bare quantity. One form for the
  // whole table, chosen by fit — a table whose rows change form reads as a bug.
  // ── vertical stack ────────────────────────────────────────────────────────
  const noteRaw = cleanText(r.note).slice(0, 120).trimEnd()
  const noteLines = noteRaw ? wrapNote(noteRaw, G.R - G.L - 8, 9) : []
  const noteH = noteLines.length ? 10 + noteLines.length * 12 : 0
  const refH = r.kind === 'reversal' && r.orig ? G.REF : 0
  // FIXED is everything that is not a row, and the slot count is DERIVED from it,
  // so no content term can ever be forgotten out of the height formula.
  //
  // `fixed` is DELIBERATELY THE STAMPLESS HEIGHT. The correction bar and the
  // "shundan bekor" sub-row are added to the y-stack BELOW, never here, because
  // slotCap is derived from `fixed`: counting the 22pt bar in would drop slotCap
  // from 14 to 13 on a plain batch and silently push a named product row into the
  // "+N mahsulot" aggregate — the edit meant to protect the card would delete a
  // line from it. A stamped card may be TALLER than the original and may exceed
  // G.ASPECT_MAX. It may never show FEWER named rows than the original showed.
  const fixed = G.EDGE + G.BAND + G.META + refH + G.HEAD + G.TOTAL + noteH + G.PERF + G.STUB + G.EDGE
  const slotCap = Math.max(G.MIN_ROWS, Math.floor((G.ASPECT_MAX * G.W - fixed) / G.ROW))
  const overflow = hasTable && items.length > slotCap
  const shown = overflow ? items.slice(0, slotCap - 1) : items
  const rest = items.slice(shown.length)
  const slots = hasTable ? Math.max(G.MIN_ROWS, overflow ? slotCap : items.length) : 0

  // FORM A prints "5 × 120 000" in MIQDOR — the unit price today's text receipt
  // gives the client. FORM B prints the bare quantity. A is taken ONLY when it
  // costs no product name: a name is identity, a unit price is detail, and the
  // caption carries the detail anyway. One form for the whole table, never a mix.
  let plan = null
  if (hasTable) {
    const totalQty = items.reduce((a, i) => a + i.qty, 0)
    const aggQty = overflow ? `${rest.reduce((a, x) => a + x.qty, 0)} dona` : null
    // FORM A needs a real unit price on EVERY row; a caller that omits one gets B.
    const priced = items.every(i => i.unit > 0)
    const cand = []
    for (const form of (priced ? ['A', 'B'] : ['B'])) {
      for (const drop of [0, 0.5, 1, 1.5, 2]) {
        const cell = 10.5 - drop
        const jami = Math.max(10, 12.5 - drop)
        const qtyS = form === 'A' ? 9.5 - drop : cell
        const sums = items.map(i => W(money(i.amount), cell, 'b'))
        sums.push(W(money(grand), jami, 'b'), W('SUMMA', 7.5, 'b', 1.1))
        const qtys = items.map(i => W(form === 'A' ? `${i.qty} × ${money(i.unit)}` : String(i.qty), qtyS))
        qtys.push(W(`${totalQty} dona`, cell - 1, 'b'), W('MIQDOR', 7.5, 'b', 1.1))
        if (aggQty) qtys.push(W(aggQty, qtyS, 'r'))
        const colS = G.R - (Math.max(...sums) + 8)
        const colQ = colS - (Math.max(...qtys) + 8)
        const nameBudget = colQ - 4 - G.X_NAME
        const fitsAll = items.every(i => W(i.label, cell) <= nameBudget)
        cand.push({ form, drop, cell, jami, qtyS, colS, colQ, nameBudget, totalQty, fitsAll })
      }
    }
    const at = (f, d) => cand.find(c => c.form === f && c.drop === d)
    plan = cand.find(c => c.drop === 0 && c.form === 'A' && c.fitsAll && c.nameBudget >= G.MIN_NAME)
        || cand.find(c => c.drop === 0 && c.form === 'B' && c.fitsAll && c.nameBudget >= G.MIN_NAME)
        || (priced && at('A', 0).nameBudget >= G.MIN_NAME ? at('A', 0) : null)
        || cand.find(c => c.form === 'B' && c.nameBudget >= G.MIN_NAME)
        || at('B', 2)
  }

  const yBand  = G.EDGE
  const yMeta  = yBand + G.BAND
  const yRef   = yMeta + G.META
  const yTable = yRef + refH
  const yRows  = yTable + G.HEAD
  // The two stamp terms. Both are 0 when r.correction is null, which is what makes
  // this whole file a strict no-op for every card issued before the stamp existed.
  const corrH  = r.correction ? G.CORR : 0
  const restCancelled = rest.filter(i => i.cancelled)          // overflow remainder
  const aggCancelH = (r.correction && overflow && restCancelled.length) ? G.ROW : 0
  const yTotal = yRows + slots * G.ROW + aggCancelH
  const tableH = hasTable ? G.HEAD + slots * G.ROW + aggCancelH + G.TOTAL : G.PAY
  const yCorr  = yTable + tableH
  const yNote  = yCorr + corrH
  const yPerf  = yNote + noteH
  const py     = yPerf + G.PERF            // the tear line AND the top of the stub
  const H      = py + G.STUB + G.EDGE

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
  const tri = (cx, cy, up, fill, s = 6) => `<path d="${up
    ? `M${N(cx)} ${N(cy - s)}L${N(cx + s * 1.15)} ${N(cy + s * 0.85)}H${N(cx - s * 1.15)}Z`
    : `M${N(cx)} ${N(cy + s)}L${N(cx + s * 1.15)} ${N(cy - s * 0.85)}H${N(cx - s * 1.15)}Z`}" fill="${fill}"/>`

  push(rect(0, 0, G.W, H, C.desk))
  push(rect(G.EDGE, G.EDGE, G.W - 2 * G.EDGE, H - 2 * G.EDGE, C.paper))

  // ── 1. kind band ──────────────────────────────────────────────────────────
  // The hung sign is the first fixation on the page: its INK edge sits on the
  // left margin and its ink centre on the caps' centre, so it reads as part of
  // the word without being a letter of it. Direction before language, before hue.
  push(rect(G.EDGE, yBand, G.W - 2 * G.EDGE, G.BAND, accent))
  const boxX = G.R - 30, boxY = yBand + 9, boxW = 30, boxH = 22
  const bandBudget = (boxX - 8) - G.L
  let ks = 19
  const kindW = s => (sign ? SIGN_ADV * s + 1.2 : 0) + W(kind.label, s, 'b', 1.6)
  while (ks > 13 && kindW(ks) > bandBudget) ks -= 0.5
  const kx = G.L + (sign ? SIGN_ADV * ks + 1.2 : 0)
  const kbase = capMid(yBand, G.BAND, ks)
  if (sign) push(text(G.L - SIGN_LSB * ks, kbase - SIGN_RAISE * ks, sign, { size: ks, w: 'b', fill: C.paper }))
  push(text(kx, kbase, kind.label, { size: ks, w: 'b', fill: C.paper, ls: 1.6 }))
  push(`<rect x="${boxX}" y="${N(boxY)}" width="${boxW}" height="${boxH}" fill="none" stroke="${C.paper}" stroke-width="1.3"/>`)
  if (dir === 0) push(rect(boxX + 7, boxY + boxH / 2 - 1.3, 16, 2.6, C.paper))
  else push(tri(boxX + boxW / 2, boxY + boxH / 2, dir > 0, C.paper))

  // ── 2. meta fields ────────────────────────────────────────────────────────
  const fLab = yMeta + 15, fVal = yMeta + 33, fRule = yMeta + 39
  push(text(G.L, fLab, 'MIJOZ', { size: 7.5, fill: C.faint, ls: 1.1 }))
  push(text(G.L, fVal, fitTail(cleanText(r.client) || '?', G.META_NAME_R - G.L, 13, 'b'), { size: 13, w: 'b' }))
  push(hline(G.L, fRule, G.META_NAME_R, C.rule, 0.9))
  push(text(G.META_DATE_L, fLab, 'SANA', { size: 7.5, fill: C.faint, ls: 1.1 }))
  push(text(G.META_DATE_L, fVal, r.at, { size: 10.5 }))
  push(hline(G.META_DATE_L, fRule, G.R, C.rule, 0.9))

  // ── 2b. reversal reference ────────────────────────────────────────────────
  // The message points BACKWARDS, so it names what was cancelled — notify.js's
  // own rule, and the workbook's word for the column ("Amal", statement.js:335).
  if (refH) {
    push(text(G.L, yRef + 11, 'AMAL', { size: 7.5, fill: C.faint, ls: 1.1 }))
    push(text(G.L + 34, yRef + 11, `${r.orig.label} · ${r.orig.at}`, { size: 9.5, fill: C.faint }))
  }

  if (hasTable) {
    // ── 3. the table ────────────────────────────────────────────────────────
    const { form, cell, jami, qtyS, colS, colQ, nameBudget, totalQty } = plan
    const xQty = colS - 4, xSum = G.R - 4
    push(rect(G.L, yTable, G.R - G.L, G.HEAD, C.panel))
    const hb = capMid(yTable, G.HEAD, 7.5)
    push(text(G.X_NUM, hb, '№', { size: 7.5, w: 'b', fill: C.faint, anchor: 'end' }))
    push(text(G.X_NAME, hb, 'MAHSULOT', { size: 7.5, w: 'b', fill: C.faint, ls: 1.1 }))
    push(tracked(xQty, hb, 'MIQDOR', { size: 7.5, w: 'b', fill: C.faint, ls: 1.1 }))
    push(tracked(xSum, hb, 'SUMMA', { size: 7.5, w: 'b', fill: C.faint, ls: 1.1 }))

    for (let i = 0; i < slots; i++) {
      const top = yRows + i * G.ROW, base = top + 13.5
      if (i % 2 === 1) push(rect(G.L + 0.6, top, G.R - G.L - 1.2, G.ROW, C.zebra))
      if (i > 0) push(hline(G.L, top, G.R, C.rule, 0.5))
      if (i < shown.length) {
        const it = shown[i]
        const q = form === 'A' ? `${it.qty} × ${money(it.unit)}` : String(it.qty)
        // A cancelled row keeps its figures, its size and its place. Only the ink
        // fades and the strike lands on top. `it.cancelled ||` is ADDED to the kind
        // test rather than replacing it, so the standalone reversal card (card B)
        // stays byte-identical to what it prints today.
        const ci = it.cancelled ? C.faint : C.ink
        push(text(G.X_NUM, base, String(i + 1), { size: 8.5, fill: C.faint, anchor: 'end' }))
        push(text(G.X_NAME, base, fitLabel(it.label, nameBudget, cell), { size: cell, fill: ci }))
        push(text(xQty, base, q, { size: fitSize(q, xQty - colQ - 4, qtyS), fill: C.faint, anchor: 'end' }))
        push(text(xSum, base, money(it.amount), { size: fitSize(money(it.amount), xSum - colS - 4, cell, 'b'), w: 'b', fill: ci, anchor: 'end' }))
        if (it.cancelled || r.kind === 'reversal') push(hline(G.X_NAME - 3, base - 3.5, xSum + 2, C.ink, 0.9))
      } else if (overflow && i === slots - 1) {
        // The remainder as ONE aggregate row. JAMI below stays the true total of
        // every item, so no figure on the page is a subset of the truth.
        const rq = `${rest.reduce((a, x) => a + x.qty, 0)} dona`, rs = money(rest.reduce((a, x) => a + x.amount, 0))
        push(text(G.X_NAME, base, `+${rest.length} mahsulot`, { size: cell, fill: C.faint }))
        push(text(xQty, base, rq, { size: fitSize(rq, xQty - colQ - 4, qtyS), fill: C.faint, anchor: 'end' }))
        push(text(xSum, base, rs, { size: fitSize(rs, xSum - colS - 4, cell, 'b'), w: 'b', fill: C.faint, anchor: 'end' }))
      }
    }
    // Unused slots take ONE diagonal cancellation stroke — the clerk's mark that
    // nothing can be written in below the last item.
    const used = overflow ? slots : items.length
    if (used < slots) {
      const t0 = yRows + used * G.ROW, t1 = yRows + slots * G.ROW
      push(`<path d="M${N(G.L + 3)} ${N(t1 - 3)}L${N(G.R - 3)} ${N(t0 + 3)}" stroke="${C.rule}" stroke-width="0.8"/>`)
    }
    // Cancelled money that fell inside the overflow aggregate gets its OWN row
    // beneath it. The aggregate above is NOT recomputed — it keeps saying exactly
    // what it printed, because printed figures do not move — and no named row is
    // evicted to make space, because this row is added below the last slot and
    // pushes JAMI down instead. Both figures use the same fitSize budgets the
    // aggregate row already uses, so the column planner needs no new terms.
    if (aggCancelH) {
      const top = yRows + slots * G.ROW, base = top + 13.5
      push(hline(G.L, top, G.R, C.rule, 0.5))
      const cq = `${restCancelled.reduce((a, x) => a + x.qty, 0)} dona`
      const cs = money(restCancelled.reduce((a, x) => a + x.amount, 0))
      push(text(G.X_NAME, base, `shundan bekor: ${restCancelled.length}`, { size: cell, fill: C.faint }))
      push(text(xQty, base, cq, { size: fitSize(cq, xQty - colQ - 4, qtyS), fill: C.faint, anchor: 'end' }))
      push(text(xSum, base, cs, { size: fitSize(cs, xSum - colS - 4, cell, 'b'), w: 'b', fill: C.faint, anchor: 'end' }))
      push(hline(G.X_NAME - 3, base - 3.5, xSum + 2, C.ink, 0.9))
    }
    push(rect(G.L + 0.6, yTotal, G.R - G.L - 1.2, G.TOTAL, C.panel))
    push(hline(G.L, yTotal, G.R, C.ink, 1))
    push(hline(G.L, yTotal + 2.4, G.R, C.ink, 0.6))
    const tb = capMid(yTotal + 2.4, G.TOTAL - 2.4, 11)
    push(text(G.X_NAME, tb, 'JAMI', { size: 11, w: 'b', ls: 1.2 }))
    push(text(xQty, tb, `${totalQty} dona`, { size: fitSize(`${totalQty} dona`, xQty - colQ - 4, cell - 1, 'b'), w: 'b', anchor: 'end' }))
    push(text(xSum, tb, money(grand), { size: fitSize(money(grand), xSum - colS - 4, jami, 'b', 10), w: 'b', anchor: 'end' }))
    // rules last, and THROUGH the JAMI row so its two figures never abut
    for (const x of [G.COL_N, colQ, colS]) push(`<path d="M${N(x)} ${N(yTable)}V${N(yTotal + G.TOTAL)}" stroke="${C.rule}" stroke-width="0.7"/>`)
    push(`<rect x="${N(G.L)}" y="${N(yTable)}" width="${N(G.R - G.L)}" height="${N(tableH)}" fill="none" stroke="${C.ink}" stroke-width="1.1"/>`)
    push(hline(G.L, yRows, G.R, C.ink, 1))
  } else {
    // ── 3b. payment / adjustment: no table at all, one stated figure ────────
    push(`<rect x="${N(G.L)}" y="${N(yTable)}" width="${N(G.R - G.L)}" height="${G.PAY}" fill="none" stroke="${C.ink}" stroke-width="1.1"/>`)
    push(text(G.X_NAME, yTable + 17, 'JAMI', { size: 7.5, w: 'b', fill: C.faint, ls: 1.1 }))
    const fig = money(grand) + NBSP + "so'm"
    const figS = fitSize(fig, G.R - 4 - G.X_NAME - 8, 20, 'b', 12)
    push(text(G.R - 4, yTable + 38, fig, { size: figS, w: 'b', anchor: 'end' }))
    // A cancelled figure is struck, exactly as notify.js wraps it in <s>.
    if (r.kind === 'reversal' || r.correction?.all) push(hline(G.R - 4 - W(fig, figS, 'b') - 2, yTable + 38 - figS * 0.33, G.R - 2, C.ink, 1.1))
  }

  // ── 3c. the correction bar ────────────────────────────────────────────────
  // A clerk's stamp on a finished docket: full width, directly under the table
  // (or under the no-table JAMI box, identically), above the note. Putting it
  // BELOW is what keeps every table row at the y it already had.
  //
  // It says a WORD, a COUNT and a DATE. No money, no restated total, no new
  // balance: there is no expression in the corrected render that computes a
  // total, a delta or a balance differently from the original render. The
  // pointer sentence ("look at the newer receipt") lives in the caption, which
  // is the layer a reader can tap, search and have read aloud.
  //
  // The ink is C.ink, NEVER C.up. In this palette C.up means "the debt ROSE" and
  // is already the band colour of the handover being stamped; reusing it as
  // cancellation ink would collide on the exact card where it matters most.
  // When every row is cancelled the box is FILLED and both texts reverse out, so
  // a wholly void card reads void at thumbnail size — a plain filled rectangle,
  // not a rotated diagonal whose width would have to be measured and could overrun.
  if (r.correction) {
    const allVoid = r.correction.all === true
    const bTop = yCorr + 3, bH = 16
    push(`<rect x="${N(G.L)}" y="${N(bTop)}" width="${N(G.R - G.L)}" height="${bH}" fill="${allVoid ? C.ink : C.panel}" stroke="${C.ink}" stroke-width="1.1"/>`)
    const cb = capMid(bTop, bH, 9.5)
    const lab = 'BEKOR QILINDI'
    push(text(G.L + 6, cb, lab, { size: 9.5, w: 'b', fill: allVoid ? C.paper : C.ink, ls: 1.2 }))
    const cnt = `${Math.abs(Math.trunc(r.correction.count) || 0)} ta qator \u00B7 ${cleanText(r.correction.at)}`
    // Stepped down, never truncated, against what the label leaves: the date is a
    // caller's string and a long one must not collide with the stamp word.
    const cntS = fitSize(cnt, (G.R - 6) - (G.L + 6 + W(lab, 9.5, 'b', 1.2) + 10), 8.5, 'r', 6.5)
    push(tracked(G.R - 6, cb, cnt, { size: cntS, fill: allVoid ? C.paper : C.faint }))
  }

  // ── 4. the owner's note ───────────────────────────────────────────────────
  if (noteLines.length) {
    push(rect(G.L, yNote + 6, 2, noteLines.length * 12 - 2, C.rule))
    noteLines.forEach((l, i) => push(text(G.L + 8, yNote + 15 + i * 12, l, { size: 9, fill: C.faint })))
  }

  // ── 5. perforation: the tear line IS the top of the stub ──────────────────
  push(rect(G.EDGE, py, G.W - 2 * G.EDGE, H - G.EDGE - py, C.stub))
  push(`<path d="M${G.EDGE} ${N(py)}H${G.W - G.EDGE}" stroke="${C.rule}" stroke-width="1" stroke-dasharray="2 3.2"/>`)
  push(`<circle cx="${G.EDGE}" cy="${N(py)}" r="5" fill="${C.desk}"/>`)
  push(`<circle cx="${G.W - G.EDGE}" cy="${N(py)}" r="5" fill="${C.desk}"/>`)

  // ── 6. the stub: the half the client keeps ────────────────────────────────
  const credit = Math.trunc(r.balance) < 0
  const bal = money(r.balance)
  const balLab = credit ? "OLDINDAN TO'LOV" : 'JAMI QARZ'
  const yLab = py + 26, yBal = py + 57
  // Torn off, the stub still says who and when.
  push(text(G.L, yLab, fitTail(`${cleanText(r.client)} · ${r.at}`, 150, 9), { size: 9, fill: C.faint }))

  // The balance: the biggest figure on the page, with its LABEL bound to it —
  // right-aligned directly above the number, never across the stub from it.
  const somS = 11, somW = W("so'm", somS) + 4
  const movement = sign + money(delta)
  const movW = 13 + W(movement, 11, 'b')
  const avail = (G.R - somW) - (G.L + movW + 16)
  const bs = fitSize(bal, avail, 26, 'b', 17, 1)
  const xBalEnd = G.R - somW
  if (credit) {
    // CREDIT is marked by the PRESENCE OF A SHAPE, not by a hue and a small word:
    // a filled pill that the debt state does not have, plus the flipped label,
    // plus the figure in the same ink-blue-green. No minus ever touches it.
    const lw = W(balLab, 9, 'b', 1.4)
    push(`<rect x="${N(G.R - lw - 14)}" y="${N(yLab - 12)}" width="${N(lw + 14)}" height="17" rx="8.5" fill="${C.down}"/>`)
    push(tracked(G.R - 7, yLab, balLab, { size: 9, w: 'b', fill: C.paper, ls: 1.4 }))
  } else {
    push(tracked(G.R, yLab, balLab, { size: 9, w: 'b', fill: C.faint, ls: 1.4 }))
  }
  push(text(xBalEnd, yBal, bal, { size: bs, w: 'b', fill: credit ? C.down : C.ink, anchor: 'end' }))
  push(text(xBalEnd + 4, yBal, "so'm", { size: somS, fill: credit ? C.down : C.ink }))

  // The movement, demoted: a shape in the accent, the figure in ink. Nothing
  // smaller than the balance carries colour on a glyph — Telegram re-encodes to
  // JPEG 4:2:0 and a saturated 11px glyph fringes.
  if (dir !== 0) push(tri(G.L + 5, yBal - 4.5, dir > 0, accent, 5.5))
  else push(rect(G.L - 0.5, yBal - 5.8, 11, 2.4, accent))
  push(text(G.L + 13, yBal, movement, { size: 11, w: 'b', fill: C.ink }))

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${G.W * G.SCALE}" height="${N(H * G.SCALE)}" ` +
    `viewBox="0 0 ${G.W} ${N(H)}" font-family="DejaVu Sans">` + o.join('') + '</svg>'
  return { svg, width: G.W, height: H, slots, slotCap, overflow, plan, noteLines, delta, H }
}

// ── The caption ───────────────────────────────────────────────────────────────
// sendPhoto's caption is capped at 1024 UTF-16 units (sendMessage's 4096 does not
// apply), and it is the only searchable, copyable, screen-reader-readable part of
// the receipt — so it carries the detail the image compresses, and it carries the
// emoji the image cannot (Telegram renders the caption with the system emoji font).
//
// Line 1 is the chat-list line: Telegram shows the HEAD of a caption there and in
// the push, so line 1 answers "what do I owe?" on its own. The image keeps the
// old invariant — the balance is the last thing on the docket — in the picture.
const KIND_UI = {
  handover:   { icon: '📦', label: 'Berildi' },
  return:     { icon: '↩️', label: 'Qaytarildi' },
  payment:    { icon: '💵', label: "To'landi" },
  adjustment: { icon: '✏️', label: 'Tuzatish' },
  reversal:   { icon: '❌', label: 'Bekor qilindi' },
}
const CAPTION_MAX = 1024
const CAPTION_BUDGET = 1000 // 24 units of headroom: entity parsing is Telegram's, not ours
const capEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function receiptCaption(r) {
  const ui = KIND_UI[r.kind] ?? KIND_UI.adjustment
  const balLab = Math.trunc(r.balance) < 0 ? "Oldindan to'lov" : 'Jami qarz'
  const items = Array.isArray(r.items) ? r.items : []
  const grand = Math.abs(Math.trunc(r.total ?? items.reduce((a, i) => a + Math.abs(i.amount), 0)))
  const head = `${ui.icon} <b>${ui.label}</b> · ${balLab}: <b>${money(r.balance)}${NBSP}so'm</b>`
  const jami = `Jami: ${money(grand)}${NBSP}so'm`
  const lines = [head, jami]
  let used = head.length + 1 + jami.length
  let dropped = 0
  for (const it of items) {
    const line = `${capEsc(it.label)} · ${it.qty} dona × ${money(it.unit_price ?? Math.round(it.amount / (it.qty || 1)))}`
    if (used + 1 + line.length > CAPTION_BUDGET - 24) { dropped = items.length - (lines.length - 2); break }
    lines.push(line); used += 1 + line.length
  }
  if (dropped) lines.push(`+${dropped} mahsulot`)
  const text = lines.join('\n')
  // Anything the caption had to drop is still delivered in full: the EXISTING
  // text receipt (formatBatchReceipt, 4096 units, ~3 000 for 50 items) follows as
  // a separate sendMessage. Nothing a client can be charged for is image-only.
  return { text, dropped, len: text.length, needsTextFollowUp: dropped > 0 }
}

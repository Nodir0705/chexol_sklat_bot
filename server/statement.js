// Monthly client statement (oylik hisobot) — JSON, Excel and Telegram delivery.
//
// Registered from index.js as:
//   await app.register(statementRoutes, { db, requireAuth, requireRead, botToken: BOT_TOKEN })
//
// Routes owned here:
//   GET  /api/clients/:id/statement?year=YYYY&month=MM
//   GET  /api/statements.xlsx?year=YYYY&month=MM
//   POST /api/clients/:id/statement/send   { year, month }
//
// This file never creates or migrates tables — clients.js owns the schema. Every
// statement is prepared inside the handler so plugin registration order does not
// matter.

import ExcelJS from 'exceljs'

// ─── Tashkent time ────────────────────────────────────────────────────────────
// Uzbekistan is UTC+5 all year (no DST), which is why the whole codebase can get
// away with a fixed offset: '+5 hours' in SQL, +5*60*60*1000 in JS.

const TK_OFFSET_MS = 5 * 60 * 60 * 1000
const pad2 = n => String(n).padStart(2, '0')

/** Same formatter the stock export uses: 'YYYY-MM-DD HH:MM' in Tashkent time. */
function tashkentStr(utc) {
  if (!utc) return ''
  const d = new Date(String(utc).replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return String(utc)
  const t = new Date(d.getTime() + TK_OFFSET_MS)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ` +
         `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`
}

/** "Now" as a Date whose UTC fields read as Tashkent wall-clock. */
function nowTashkent() {
  return new Date(Date.now() + TK_OFFSET_MS)
}

// The whole correctness of this module rests on these two strings.
//
// `created_at` is stored in UTC. `datetime(created_at, '+5 hours')` shifts a row
// to Tashkent wall-clock and always renders as 'YYYY-MM-DD HH:MM:SS', so a plain
// string comparison against the same format is a chronological comparison. It
// also normalises whatever the writer used ('T' separator, trailing 'Z',
// fractional seconds), which raw string comparison would not.
//
//   opening : datetime(created_at,'+5h') <  start        (everything before the month)
//   month   : start <= datetime(created_at,'+5h') < next (half-open, so no row is
//                                                         counted twice or lost)
//
// For 2026-09 that makes the month exactly [2026-08-31 19:00:00Z, 2026-09-30 19:00:00Z).
// December rolls the year, not the month.
function monthBounds(year, month) {
  const start = `${year}-${pad2(month)}-01 00:00:00`
  const nextY = month === 12 ? year + 1 : year
  const nextM = month === 12 ? 1 : month + 1
  const next  = `${nextY}-${pad2(nextM)}-01 00:00:00`
  return { start, next }
}

const UZ_MONTHS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
]

const KIND_LABEL = {
  handover:   'Berildi',
  return:     'Qaytarildi',
  payment:    "To'landi",
  adjustment: 'Tuzatish',
}

// The six statement lines, spelled once. The workbook rows and the Telegram
// caption both read them from here, so the file the client opens and the
// message sitting above it can not drift into two vocabularies for one thing.
const LABEL = {
  opening:  'Oy boshiga qarz',
  given:    'Berildi',
  returned: 'Qaytarildi',
  paid:     "To'landi",
  adjusted: 'Tuzatish',
  closing:  'Oy oxiriga qarz',
  // Only the closing line has a second spelling: a negative balance is not a
  // debt of minus X, it is a prepayment of X, and printing it as a debt with a
  // minus sign reads as a broken bot.
  closingCredit: "Oy oxiriga oldindan to'lov",
}

const NBSP  = '\u00A0'  // NO-BREAK SPACE
const MINUS = '\u2212'  // MINUS SIGN, not a hyphen

/**
 * 2400000 -> "2\u00A0400\u00A0000".
 *
 * Deliberately divergent from the Mini App, which separates the digit groups
 * with an ordinary space. The caption is read on a 320px phone, where an
 * ordinary space lets "2 400 000" break after the "2" — a debt figure torn
 * across two lines is a trust defect. xlsx cells are untouched by this: they
 * carry raw numbers and a numFmt (MONEY_FMT), never this string.
 */
function fmtMoney(n) {
  const v = Math.trunc(Number(n) || 0)
  const sign = v < 0 ? MINUS : ''
  return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** The figure with its unit, NBSP-joined so "so'm" can never orphan. */
const som = n => `${fmtMoney(n)}${NBSP}so'm`

/** Tuzatish is the one line whose label states no direction, so the figure
 *  carries the sign itself: U+002B / U+2212, never a bare hyphen. */
const somSigned = n => `${n < 0 ? MINUS : '+'}${fmtMoney(Math.abs(n))}${NBSP}so'm`

/** The caption ships with parse_mode=HTML, so anything interpolated into it is
 *  escaped first. This is the only HTML surface in the file. */
const esc = v => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ─── Validation ───────────────────────────────────────────────────────────────

function parsePeriod(raw, { required }) {
  const now = nowTashkent()
  const hasYear  = raw.year  !== undefined && raw.year  !== null && raw.year  !== ''
  const hasMonth = raw.month !== undefined && raw.month !== null && raw.month !== ''

  if (!hasYear && !hasMonth && !required) {
    return { ok: true, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  }
  // A half-specified period is a caller bug, not a default.
  if (!hasYear || !hasMonth) return { ok: false, error: 'year and month required' }

  const year  = required ? raw.year  : Number(raw.year)
  const month = required ? raw.month : Number(raw.month)
  if (!Number.isInteger(year) || year < 2000 || year > 2999)
    return { ok: false, error: 'year must be an integer between 2000 and 2999' }
  if (!Number.isInteger(month) || month < 1 || month > 12)
    return { ok: false, error: 'month must be an integer between 1 and 12' }
  return { ok: true, year, month }
}

function parseId(raw) {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

// ─── Statement assembly ───────────────────────────────────────────────────────

function getClient(db, id) {
  return db.prepare(
    'SELECT id, name, phone, telegram_chat_id FROM clients WHERE id = ? AND deleted_at IS NULL'
  ).get(id) ?? null
}

/** Path of a category's ancestors — 'Nakitka › Ali cantara safir'. */
function fullPath(catId, byId) {
  const parts = []
  let cur = byId.get(catId)
  cur = cur && cur.parent_id != null ? byId.get(cur.parent_id) : null
  while (cur) {
    parts.unshift(cur.name)
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null
  }
  return parts.join(' › ')
}

function categoryIndex(db) {
  // Deleted categories included, so a statement for a discontinued product still
  // resolves its name and location.
  const all = db.prepare('SELECT id, parent_id, name FROM product_categories').all()
  return new Map(all.map(c => [c.id, c]))
}

/**
 * The one place the month is cut. Returns the raw pieces; callers shape them.
 * `opening` is every row strictly before the month; `rows` is the month itself.
 */
function monthSlice(db, clientId, year, month) {
  const { start, next } = monthBounds(year, month)

  const opening = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM client_ledger
    WHERE client_id = ?
      AND datetime(created_at, '+5 hours') < ?
  `).get(clientId, start).total

  // The reversal's own `kind` is not trusted for bucketing: a reversing row must
  // land in the same bucket as the row it cancels, whatever kind it was written
  // with, or the totals would not net to zero.
  const rows = db.prepare(`
    SELECT l.id, l.kind, l.category_id, l.qty, l.unit_price, l.amount, l.note,
           l.performed_by_name, l.reverses_id, l.created_at,
           COALESCE(o.kind, l.kind) AS bucket
    FROM client_ledger l
    LEFT JOIN client_ledger o ON o.id = l.reverses_id
    WHERE l.client_id = ?
      AND datetime(l.created_at, '+5 hours') >= ?
      AND datetime(l.created_at, '+5 hours') <  ?
    ORDER BY l.created_at, l.id
  `).all(clientId, start, next)

  // A row can be reversed in a *later* month; it must still render struck
  // through in the month it belongs to. So this lookup spans the whole ledger.
  const reversals = db.prepare(
    'SELECT id, reverses_id FROM client_ledger WHERE client_id = ? AND reverses_id IS NOT NULL'
  ).all(clientId)
  const reversedBy = new Map(reversals.map(r => [r.reverses_id, r.id]))

  return { opening, rows, reversedBy, start, next }
}

/**
 * Assembles the statement for an already-resolved client row. The only place
 * ledger rows are turned into the API shape.
 */
function assemble(db, client, year, month) {
  const byId = categoryIndex(db)
  const { opening, rows, reversedBy } = monthSlice(db, client.id, year, month)

  const handovers = [], returns = [], payments = [], adjustments = []
  let movement = 0
  let given = 0, returned = 0, paid = 0, adjusted = 0

  for (const r of rows) {
    const cat = r.category_id != null ? byId.get(r.category_id) : null
    const entry = {
      id: r.id,
      kind: r.kind,
      category_id: r.category_id ?? null,
      category_name: cat?.name ?? null,
      category_path: r.category_id != null ? fullPath(r.category_id, byId) : null,
      qty: r.qty ?? null,
      unit_price: r.unit_price ?? null,
      amount: r.amount,
      note: r.note ?? null,
      performed_by_name: r.performed_by_name ?? null,
      reverses_id: r.reverses_id ?? null,
      reversed_by: reversedBy.get(r.id) ?? null,
      // Two flags so the UI never has to reason about the ledger: `reversed`
      // means "strike this row through", `is_reversal` means "this row is the
      // cancellation of another".
      reversed: reversedBy.has(r.id),
      is_reversal: r.reverses_id != null,
      created_at: r.created_at,
      created_at_tk: tashkentStr(r.created_at),
    }

    movement += r.amount

    switch (r.bucket) {
      case 'handover':
        handovers.push(entry); given += r.amount; break
      case 'return':
        // Returns are stored negative; the statement reports them positive.
        returns.push(entry); returned += -r.amount; break
      case 'payment':
        payments.push(entry); paid += -r.amount; break
      default:
        adjustments.push(entry); adjusted += r.amount; break
    }
  }

  return {
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone ?? null,
      telegram_chat_id: client.telegram_chat_id ?? null,
    },
    period: {
      year,
      month,
      label: `${year}-yil ${UZ_MONTHS[month - 1]}`,
      from: monthBounds(year, month).start,
      to: monthBounds(year, month).next,
    },
    opening,
    handovers,
    returns,
    payments,
    adjustments,
    totals: { given, returned, paid, adjusted },
    // Never derived from the buckets: closing is opening plus every so'm that
    // moved in the month, so the two can not drift apart.
    closing: opening + movement,
  }
}

/** Full statement object for one live client, or null if there is no such client. */
export function buildStatement(db, clientId, year, month) {
  const client = getClient(db, clientId)
  return client ? assemble(db, client, year, month) : null
}

// ─── Excel ────────────────────────────────────────────────────────────────────

const MONEY_FMT = '#,##0'

/**
 * Excel forbids [ ] : * ? / \ in a sheet name, caps it at 31 characters, rejects
 * an empty name and rejects a leading or trailing apostrophe.
 */
export function sheetName(raw, taken) {
  let name = String(raw ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim()
  name = name.replace(/^'+/, '').replace(/'+$/, '').trim()
  if (!name) name = 'Mijoz'
  name = name.slice(0, 31).trim() || 'Mijoz'
  if (!taken) return name

  let candidate = name
  let n = 2
  while (taken.has(candidate)) {
    const suffix = `~${n}`
    candidate = (name.slice(0, 31 - suffix.length).trim() || 'Mijoz') + suffix
    n += 1
  }
  taken.add(candidate)
  return candidate
}

/** Safe for a Content-Disposition filename and for Telegram. */
function safeFileName(raw) {
  return String(raw ?? '').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60)
      || 'Mijoz'
}

function statementFileName(st) {
  return `Hisobot_${safeFileName(st.client.name)}_${st.period.year}-${pad2(st.period.month)}.xlsx`
}

function addClientSheet(wb, st, taken) {
  const ws = wb.addWorksheet(sheetName(st.client.name, taken))
  ws.columns = [
    { header: 'Sana (Toshkent)', key: 'date',  width: 20 },
    { header: 'Amal',            key: 'kind',  width: 14 },
    { header: 'Mahsulot',        key: 'name',  width: 28 },
    { header: 'Joylashuv',       key: 'path',  width: 34 },
    { header: 'Miqdor',          key: 'qty',   width: 10 },
    { header: "Narx (so'm)",     key: 'price', width: 16 },
    { header: "Summa (so'm)",    key: 'sum',   width: 18 },
    { header: 'Izoh',            key: 'note',  width: 26 },
    { header: 'Kim',             key: 'who',   width: 18 },
  ]
  ws.getRow(1).font = { bold: true }

  const openingRow = ws.addRow({
    kind: LABEL.opening, name: st.period.label, sum: st.opening,
  })
  openingRow.font = { bold: true }

  // Chronological, all four kinds interleaved — the audit trail as it happened.
  const entries = [...st.handovers, ...st.returns, ...st.payments, ...st.adjustments]
    .sort((a, b) => (a.created_at < b.created_at ? -1
                   : a.created_at > b.created_at ? 1
                   : a.id - b.id))

  for (const e of entries) {
    const row = ws.addRow({
      date:  e.created_at_tk,
      kind:  (e.is_reversal ? 'Bekor: ' : '') + (KIND_LABEL[e.kind] ?? e.kind),
      name:  e.category_name ?? '',
      path:  e.category_path ?? '',
      qty:   e.qty ?? '',
      price: e.unit_price ?? '',
      sum:   e.amount,
      note:  e.note ?? '',
      who:   e.performed_by_name || "Noma'lum",
    })
    // A reversed row stays in the sheet — struck through, so the correction is
    // visible rather than silently erased.
    if (e.reversed) row.font = { strike: true }
  }

  const t = st.totals
  ws.addRow({})
  // Same six strings the Telegram caption uses, from the same object.
  const summary = [
    [LABEL.given,    t.given],
    [LABEL.returned, t.returned],
    [LABEL.paid,     t.paid],
    ...(t.adjusted ? [[LABEL.adjusted, t.adjusted]] : []),
    [LABEL.closing,  st.closing],
  ]
  for (const [label, value] of summary) {
    const row = ws.addRow({ kind: label, sum: value })
    row.font = { bold: true }
  }

  for (const key of ['price', 'sum']) {
    ws.getColumn(key).numFmt = MONEY_FMT
  }
  return ws
}

/** One summary sheet plus one sheet per client. */
export async function buildStatementsWorkbook(db, year, month) {
  const { start, next } = monthBounds(year, month)

  // Active clients, plus any soft-deleted client that still moved money this
  // month — dropping those would put a hole in the month's arithmetic.
  const clients = db.prepare(`
    SELECT c.id, c.name, c.phone, c.telegram_chat_id
    FROM clients c
    WHERE c.deleted_at IS NULL
       OR EXISTS (
            SELECT 1 FROM client_ledger l
            WHERE l.client_id = c.id
              AND datetime(l.created_at, '+5 hours') >= ?
              AND datetime(l.created_at, '+5 hours') <  ?
          )
    ORDER BY c.name
  `).all(start, next)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Sklat'
  wb.created = new Date(0)

  const label = `${year}-yil ${UZ_MONTHS[month - 1]}`
  const taken = new Set()

  // Summary first, so its name is claimed before a client called 'Umumiy' can
  // take it.
  const s = wb.addWorksheet(sheetName('Umumiy', taken))
  s.columns = [
    { header: 'Mijoz',          key: 'name',     width: 28 },
    { header: LABEL.opening,    key: 'opening',  width: 20 },
    { header: LABEL.given,      key: 'given',    width: 18 },
    { header: LABEL.returned,   key: 'returned', width: 18 },
    { header: LABEL.paid,       key: 'paid',     width: 18 },
    { header: LABEL.adjusted,   key: 'adjusted', width: 16 },
    { header: LABEL.closing,    key: 'closing',  width: 20 },
  ]
  s.getRow(1).font = { bold: true }

  const statements = []
  const sum = { opening: 0, given: 0, returned: 0, paid: 0, adjusted: 0, closing: 0 }

  for (const c of clients) {
    const st = assemble(db, c, year, month)
    statements.push(st)
    s.addRow({
      name: st.client.name,
      opening: st.opening,
      given: st.totals.given,
      returned: st.totals.returned,
      paid: st.totals.paid,
      adjusted: st.totals.adjusted,
      closing: st.closing,
    })
    sum.opening  += st.opening
    sum.given    += st.totals.given
    sum.returned += st.totals.returned
    sum.paid     += st.totals.paid
    sum.adjusted += st.totals.adjusted
    sum.closing  += st.closing
  }

  const totalRow = s.addRow({ name: 'JAMI', ...sum })
  totalRow.font = { bold: true }
  for (const key of ['opening', 'given', 'returned', 'paid', 'adjusted', 'closing']) {
    s.getColumn(key).numFmt = MONEY_FMT
  }

  for (const st of statements) addClientSheet(wb, st, taken)

  return { wb, label, clientCount: statements.length }
}

/** A single client's statement as its own workbook (summary + that one sheet). */
async function buildSingleWorkbook(st) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Sklat'
  wb.created = new Date(0)
  const taken = new Set()

  const s = wb.addWorksheet(sheetName('Umumiy', taken))
  s.columns = [
    { header: 'Mijoz',        key: 'name',     width: 28 },
    { header: LABEL.opening,  key: 'opening',  width: 20 },
    { header: LABEL.given,    key: 'given',    width: 18 },
    { header: LABEL.returned, key: 'returned', width: 18 },
    { header: LABEL.paid,     key: 'paid',     width: 18 },
    { header: LABEL.adjusted, key: 'adjusted', width: 16 },
    { header: LABEL.closing,  key: 'closing',  width: 20 },
  ]
  s.getRow(1).font = { bold: true }
  s.addRow({
    name: st.client.name,
    opening: st.opening,
    given: st.totals.given,
    returned: st.totals.returned,
    paid: st.totals.paid,
    adjusted: st.totals.adjusted,
    closing: st.closing,
  })
  for (const key of ['opening', 'given', 'returned', 'paid', 'adjusted', 'closing']) {
    s.getColumn(key).numFmt = MONEY_FMT
  }

  addClientSheet(wb, st, taken)
  return wb
}

/**
 * The sendDocument caption — the whole statement in six lines, so a client can
 * check the month on a lock screen and only open the workbook to see the rows.
 *
 * The figures are the arithmetic of the bold bottom line:
 *
 *   opening + Berildi − Qaytarildi − To'landi (+ Tuzatish) = closing
 *
 * which holds by construction — `closing` is `opening` plus every amount that
 * moved in the month, and the four buckets partition exactly those amounts
 * (assemble(), :211-221). That is why the operands keep their signs: a
 * September reversal of an August handover makes `given` negative, and hiding
 * that minus would print a sum that does not add up. Only the closing line
 * refuses a sign, because a negative balance is not a debt — it is a
 * prepayment, and it says so.
 *
 * Tuzatish appears the moment it is non-zero (mirroring the workbook summary);
 * the other four print even at zero, because a statement of account states
 * every line.
 *
 * Requires parse_mode=HTML on the request, or the tags ship as literal text.
 */
export function statementCaption(st) {
  const t = st.totals

  const quote = [
    `${LABEL.opening}: ${som(st.opening)}`,
    `${LABEL.given}: ${som(t.given)}`,
    `${LABEL.returned}: ${som(t.returned)}`,
    `${LABEL.paid}: ${som(t.paid)}`,
  ]
  if (t.adjusted !== 0) quote.push(`${LABEL.adjusted}: ${somSigned(t.adjusted)}`)

  const bottom = st.closing < 0
    ? `${LABEL.closingCredit}: ${som(-st.closing)}`
    : `${LABEL.closing}: ${som(st.closing)}`

  // `st.period.label` is generated from UZ_MONTHS, never user input, but it is
  // escaped anyway: the day someone makes the label configurable, this line
  // should not be the one that starts rejecting messages.
  return `📄 <b>${esc(st.period.label)} hisoboti</b>\n` +
         `<blockquote>${quote.join('\n')}</blockquote>\n` +
         `<b>${bottom}</b>`
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export default async function statementRoutes(app, { db, requireAuth, requireRead, botToken }) {
  // GET /api/clients/:id/statement?year=YYYY&month=MM
  app.get('/api/clients/:id/statement', (req, reply) => {
    if (!requireRead(req, reply)) return

    const id = parseId(req.params.id)
    if (!id) return reply.code(400).send({ error: 'invalid id' })

    const p = parsePeriod(req.query ?? {}, { required: false })
    if (!p.ok) return reply.code(400).send({ error: p.error })

    const st = buildStatement(db, id, p.year, p.month)
    if (!st) return reply.code(404).send({ error: 'client not found' })
    return reply.send(st)
  })

  // GET /api/statements.xlsx?year=YYYY&month=MM — every client, one sheet each.
  app.get('/api/statements.xlsx', async (req, reply) => {
    if (!requireRead(req, reply)) return

    const p = parsePeriod(req.query ?? {}, { required: false })
    if (!p.ok) return reply.code(400).send({ error: p.error })

    const { wb } = await buildStatementsWorkbook(db, p.year, p.month)
    const buf = await wb.xlsx.writeBuffer()
    const name = `Hisobot_${p.year}-${pad2(p.month)}.xlsx`
    reply.header('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="${name}"`)
    return reply.send(Buffer.from(buf))
  })

  // POST /api/clients/:id/statement/send { year, month }
  // Goes to the *client's* linked group, not to the owner.
  app.post('/api/clients/:id/statement/send', async (req, reply) => {
    if (!requireAuth(req, reply)) return

    const id = parseId(req.params.id)
    if (!id) return reply.code(400).send({ error: 'invalid id' })

    const p = parsePeriod(req.body ?? {}, { required: true })
    if (!p.ok) return reply.code(400).send({ error: p.error })

    const st = buildStatement(db, id, p.year, p.month)
    if (!st) return reply.code(404).send({ error: 'client not found' })
    if (!st.client.telegram_chat_id)
      return reply.code(400).send({ error: 'mijoz guruhi ulanmagan' })
    if (!botToken) return reply.code(500).send({ error: 'no_token' })

    try {
      const wb  = await buildSingleWorkbook(st)
      const buf = await wb.xlsx.writeBuffer()

      const form = new FormData()
      form.append('chat_id', String(st.client.telegram_chat_id))
      form.append('caption', statementCaption(st))
      // Without this the caption's <b> and <blockquote> arrive as literal
      // "&lt;b&gt;" text. Telegram defaults to no parse mode.
      form.append('parse_mode', 'HTML')
      form.append('document', new Blob([buf],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        statementFileName(st))

      const tgRes  = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST', body: form,
      })
      const tgJson = await tgRes.json()
      if (!tgJson.ok)
        return reply.code(502).send({ error: 'telegram_failed', detail: tgJson.description })

      return reply.send({ sent: true, closing: st.closing })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })
}

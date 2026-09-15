// Client ledger (Mijozlar) — clients, per-client prices, and the append-only
// ledger that the running balance is derived from.
//
// Registered from index.js as:
//   await app.register(clientRoutes, { db, requireAuth, requireRead, notify })
//
// Two rules this module never bends:
//   1. Balance is ALWAYS SUM(amount) over client_ledger. There is exactly one
//      way to compute it, so a cached/derived total can never drift.
//   2. Corrections never UPDATE or DELETE a ledger row. A mistake is cancelled
//      by inserting an opposite row whose reverses_id points at the original.
//
// All money is integer so'm — no floats anywhere in the money path.

import { migrate } from './schema.js'
import { formatReceipt, formatBatchReceipt, productLabel } from './notify.js'
import { receiptSvg, receiptCaption } from './receipt-image.js'

const MAX_QTY   = 99999          // matches the Mini App's quantity input cap
const MAX_MONEY = 10_000_000_000 // so'm; qty*unit_price stays well under 2^53
const MAX_BATCH = 50             // products in one handover/return; spec §3
const KINDS     = ['handover', 'return', 'payment', 'adjustment']

// ─── Errors (user-facing text is Uzbek) ────────────────────────────────────────

const E = {
  clientNotFound: 'mijoz topilmadi',
  entryNotFound:  'yozuv topilmadi',
  badId:          "noto'g'ri id",
  nameRequired:   'ism talab qilinadi',
  noPrice:        'narx belgilanmagan',
  catNotFound:    "kategoriya topilmadi yoki o'chirilgan",
  catNotProduct:  'kategoriya mahsulot emas',
  qty:            `miqdor 1 dan ${MAX_QTY} gacha butun son bo'lishi kerak`,
  amount:         `summa 1 dan ${MAX_MONEY} gacha butun son bo'lishi kerak`,
  unitPrice:      `narx 1 dan ${MAX_MONEY} gacha butun son bo'lishi kerak`,
  balanceNotZero: "balans nolga teng emas, mijozni o'chirib bo'lmaydi",
  alreadyRev:     'bu yozuv allaqachon bekor qilingan',
  isReversal:     "bekor qilish yozuvini bekor qilib bo'lmaydi",
  itemsRequired:  'kamida bitta mahsulot tanlang',
  tooManyItems:   `bir vaqtda ko'pi bilan ${MAX_BATCH} ta mahsulot yuborish mumkin`,
}

export default async function clientRoutes(app, { db, requireAuth, requireRead, notify } = {}) {
  // ─── Schema ─────────────────────────────────────────────────────────────────
  // Owned by server/schema.js, which index.js runs before registering this
  // plugin. This file used to declare its own copy; the two disagreed on index
  // names (idx_* vs ix_*), so running both produced six indexes over the same
  // three column sets — duplicated write cost on every insert, forever.
  migrate(db)

  // ─── Prepared statements ────────────────────────────────────────────────────

  // One shape for a ledger row, used by the list and by every mutation's echo,
  // so the client never has to reconcile two different row layouts.
  //
  // parent_name is the IMMEDIATE parent, carried so productLabel() in notify.js
  // can qualify a bare leaf ("Qora" → "Cristal › Qora"). It comes from a join on
  // an integer PK — 1:1, and null for a root or a payment row — NOT from
  // splitting category_path: POST /api/categories only trims the name, so an
  // owner-entered name may itself contain " › " and a split would cut it there.
  const LEDGER_SELECT = `
    SELECT l.id, l.client_id, l.kind, l.category_id,
           pc.name AS category_name,
           pp.name AS parent_name,
           l.qty, l.unit_price, l.amount, l.note,
           l.performed_by, l.performed_by_name, l.reverses_id,
           (SELECT r.id FROM client_ledger r WHERE r.reverses_id = l.id) AS reversed_by,
           l.created_at
    FROM client_ledger l
    LEFT JOIN product_categories pc ON pc.id = l.category_id
    LEFT JOIN product_categories pp ON pp.id = pc.parent_id
  `

  const q = {
    listClients: db.prepare(`
      SELECT c.id, c.name, c.phone, c.telegram_chat_id,
             (SELECT COALESCE(SUM(amount), 0) FROM client_ledger WHERE client_id = c.id) AS balance
      FROM clients c
      WHERE c.deleted_at IS NULL
      ORDER BY c.name
    `),
    getClient: db.prepare(
      'SELECT id, name, phone, telegram_chat_id FROM clients WHERE id = ? AND deleted_at IS NULL'
    ),
    insClient:  db.prepare('INSERT INTO clients (name, phone) VALUES (?, ?)'),
    updClient:  db.prepare('UPDATE clients SET name = ?, phone = ? WHERE id = ? AND deleted_at IS NULL'),
    delClient:  db.prepare('UPDATE clients SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL'),

    // The one and only balance query.
    balance:    db.prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM client_ledger WHERE client_id = ?'),

    ledger:     db.prepare(`${LEDGER_SELECT} WHERE l.client_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`),
    entry:      db.prepare(`${LEDGER_SELECT} WHERE l.id = ?`),
    rawEntry:   db.prepare('SELECT * FROM client_ledger WHERE id = ?'),
    reversalOf: db.prepare('SELECT id FROM client_ledger WHERE reverses_id = ? LIMIT 1'),
    insLedger:  db.prepare(`
      INSERT INTO client_ledger
        (client_id, kind, category_id, qty, unit_price, amount, note,
         performed_by, performed_by_name, reverses_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Net quantity of one product a client currently holds. Reversals flip the
    // sign of amount while keeping kind and qty, so the direction must be read
    // from amount — keying off kind alone would make a reversed handover *add*
    // to what the client holds.
    heldQty: db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN qty ELSE -qty END), 0) AS held
      FROM client_ledger
      WHERE client_id = ? AND category_id = ? AND qty IS NOT NULL
        AND kind IN ('handover', 'return')
    `),

    priceOverride: db.prepare('SELECT unit_price FROM client_prices WHERE client_id = ? AND category_id = ?'),
    upsertPrice:   db.prepare(`
      INSERT INTO client_prices (client_id, category_id, unit_price) VALUES (?, ?, ?)
      ON CONFLICT(client_id, category_id) DO UPDATE SET unit_price = excluded.unit_price
    `),
    delPrice:  db.prepare('DELETE FROM client_prices WHERE client_id = ? AND category_id = ?'),
    priceList: db.prepare(`
      SELECT pc.id AS category_id, pc.name, pc.default_price, cp.unit_price AS override
      FROM product_categories pc
      LEFT JOIN client_prices cp ON cp.category_id = pc.id AND cp.client_id = ?
      WHERE pc.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM product_categories ch WHERE ch.parent_id = pc.id AND ch.deleted_at IS NULL
        )
      ORDER BY pc.name
    `),
    defaultPrice:  db.prepare('SELECT default_price FROM product_categories WHERE id = ? AND deleted_at IS NULL'),
    setDefault:    db.prepare('UPDATE product_categories SET default_price = ? WHERE id = ? AND deleted_at IS NULL'),

    // Includes soft-deleted rows on purpose: ledger history for a removed
    // product must still resolve its name and location.
    allCats: db.prepare('SELECT id, parent_id, name FROM product_categories'),
    catAlive: db.prepare('SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL'),
    catChild: db.prepare('SELECT 1 FROM product_categories WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1'),
    lastId:   db.prepare('SELECT last_insert_rowid() AS id'),
  }

  // ─── Validation ─────────────────────────────────────────────────────────────
  //
  // The stock routes once checked qty for truthiness only, which let -500, 0.5,
  // 1e15 and "10" through into the arithmetic. Every numeric below goes through
  // Number.isInteger with an explicit range, and body fields are never coerced,
  // so the string "10" is rejected rather than quietly accepted.

  const isQty   = v => Number.isInteger(v) && v >= 1 && v <= MAX_QTY
  const isMoney = v => Number.isInteger(v) && v >= 1 && v <= MAX_MONEY

  /** Route params arrive as strings; accept only a positive integer. */
  function idParam(raw) {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  /** A category that may hold stock: active, and with no children of its own. */
  function stockTarget(categoryId) {
    if (!Number.isInteger(categoryId) || categoryId < 1) return { ok: false, error: E.catNotFound }
    if (!q.catAlive.get(categoryId)) return { ok: false, error: E.catNotFound }
    if (q.catChild.get(categoryId))  return { ok: false, error: E.catNotProduct }
    return { ok: true }
  }

  /** Resolve the trimmed, non-empty name or null. */
  function cleanName(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  function cleanPhone(v) {
    if (v === undefined || v === null || v === '') return null
    return typeof v === 'string' && v.trim() ? v.trim() : undefined // undefined = invalid
  }

  function cleanNote(v) {
    if (v === undefined || v === null || v === '') return null
    return typeof v === 'string' ? v.trim().slice(0, 500) || null : null
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function balanceOf(clientId) {
    return q.balance.get(clientId).balance
  }

  /** client_prices override → product_categories.default_price → null. */
  function resolvePrice(clientId, categoryId) {
    const override = q.priceOverride.get(clientId, categoryId)
    if (override && override.unit_price != null) return override.unit_price
    const cat = q.defaultPrice.get(categoryId)
    if (cat && cat.default_price != null) return cat.default_price
    return null
  }

  /** Parent chain of a category ("Nakitka › Ali cantara safir"), as /api/history does. */
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

  function catIndex() {
    return new Map(q.allCats.all().map(c => [c.id, c]))
  }

  function withPath(row, byId = catIndex()) {
    if (!row) return null
    return { ...row, category_path: row.category_id != null ? fullPath(row.category_id, byId) : '' }
  }

  // ─── Telegram receipt ───────────────────────────────────────────────────────
  // Posting never blocks the ledger write: the row is committed first, the post
  // is fired afterwards and its failure can only reach the log, never the reply.

  // The message itself is built by formatReceipt in server/notify.js — the one
  // renderer. This file deliberately keeps no formatting helpers of its own:
  // when it carried a parallel copy, the two drifted, and only one of them
  // escaped the owner-entered text it interpolated into an HTML-parsed message.
  //
  // `orig` is passed only for a reversal: the receipt quotes the cancelled row's
  // label and stamp, and the reverse route already holds that row, so nothing
  // here re-reads it.

  /** Fire-and-forget. Swallows everything — a Telegram outage must not stop the
   *  owner recording business, and the row is already committed by now. The
   *  text is rendered INSIDE the try: a formatter fed owner-entered text is one
   *  more thing that must not reach the reply. */
  function postText(client, render) {
    if (typeof notify !== 'function') return
    if (!client || client.telegram_chat_id == null) return
    try {
      Promise.resolve(notify(client.telegram_chat_id, render())).catch(() => {})
    } catch {}
  }

  /** Shape a movement for the image renderer. Direction comes from the SIGNED
   *  sum, never the kind word — a reversal of a payment raises the debt while
   *  its header still reads "Bekor qilindi". */
  function receiptData(client, entries, balance, note, orig = null) {
    const rows = entries.filter(e => e.category_id != null)
    return {
      kind: orig ? 'reversal' : entries[0].kind,
      client: client?.name ?? '',
      at: entries[0].created_at,
      note: note ?? entries[0].note ?? null,
      balance,
      delta: entries.reduce((a, e) => a + (e.amount || 0), 0),
      total: Math.abs(entries.reduce((a, e) => a + (e.amount || 0), 0)),
      orig: orig ? { kind: orig.kind, at: orig.created_at } : null,
      items: rows.map(e => ({
        label: productLabel(e.category_name, e.parent_name),
        qty: e.qty, amount: e.amount, unit_price: e.unit_price,
      })),
    }
  }

  /** Picture first, text as the fallback inside notify.receipt. */
  function postReceipt(client, entries, balance, note, orig = null) {
    if (typeof notify !== 'function') return
    if (!client || client.telegram_chat_id == null) return
    try {
      const data = receiptData(client, entries, balance, note, orig)
      const text = entries.length === 1
        ? formatReceipt(entries[0], balance, orig)
        : formatBatchReceipt(entries, balance, { note })
      // receiptSvg returns { svg, width, height, ... } -- the markup is .svg
      const card = receiptSvg(data)
      const send = typeof notify.receipt === 'function'
        ? notify.receipt(client.telegram_chat_id,
            { svg: card.svg, caption: receiptCaption(data), text })
        : notify(client.telegram_chat_id, text)
      Promise.resolve(send).catch(() => {})
    } catch (err) {
      // Rendering blew up -- still tell the client what they received.
      try { postText(client, () => entries.length === 1
        ? formatReceipt(entries[0], balance, orig)
        : formatBatchReceipt(entries, balance, { note })) } catch {}
    }
  }

  function post(client, entry, balance, orig = null) {
    postReceipt(client, [entry], balance, null, orig)
  }

  /**
   * One message for one movement, however many rows it wrote. A lone row keeps
   * the single-item template — spec §1: "A SINGLE item must render exactly as it
   * does today ... Only two or more items use the list form" — which also covers
   * a batch that merged down to one product.
   *
   * `opts` is formatBatchReceipt's { note, at }: the note shared by every row,
   * passed explicitly because a batch's note belongs to the movement rather
   * than to any one product. `at` is left to default to the first row's stamp —
   * all the rows of a batch are written in one transaction.
   */
  function postMovement(client, entries, balance, note) {
    postReceipt(client, entries, balance, note)
  }

  /** Run fn inside a transaction; fn returns the value to hand back. */
  function tx(fn) {
    db.exec('BEGIN')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) { db.exec('ROLLBACK'); throw err }
  }

  // ─── Clients ────────────────────────────────────────────────────────────────

  app.get('/api/clients', (req, reply) => {
    if (!requireRead(req, reply)) return
    return reply.send(q.listClients.all())
  })

  app.post('/api/clients', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const { name, phone } = req.body ?? {}
    const clean = cleanName(name)
    if (!clean) return reply.code(400).send({ error: E.nameRequired })
    const tel = cleanPhone(phone)
    if (tel === undefined) return reply.code(400).send({ error: "telefon noto'g'ri" })

    try {
      const id = tx(() => {
        q.insClient.run(clean, tel)
        return q.lastId.get().id
      })
      return reply.code(201).send({ id, name: clean, phone: tel })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  app.get('/api/clients/:id', (req, reply) => {
    if (!requireRead(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    const client = q.getClient.get(id)
    if (!client) return reply.code(404).send({ error: E.clientNotFound })
    return reply.send({ ...client, balance: balanceOf(id) })
  })

  app.patch('/api/clients/:id', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    const client = q.getClient.get(id)
    if (!client) return reply.code(404).send({ error: E.clientNotFound })

    const { name, phone } = req.body ?? {}
    let nextName = client.name
    if (name !== undefined) {
      const clean = cleanName(name)
      if (!clean) return reply.code(400).send({ error: E.nameRequired })
      nextName = clean
    }
    let nextPhone = client.phone
    if (phone !== undefined) {
      const tel = cleanPhone(phone)
      if (tel === undefined) return reply.code(400).send({ error: "telefon noto'g'ri" })
      nextPhone = tel
    }

    try {
      tx(() => q.updClient.run(nextName, nextPhone, id))
      return reply.send({ id, name: nextName, phone: nextPhone })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  // Soft delete, and only while the client owes nothing — a client with a
  // non-zero balance still has money in play, and hiding them would hide it.
  app.delete('/api/clients/:id', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })

    try {
      const out = tx(() => {
        const client = q.getClient.get(id)
        if (!client) return { code: 404, body: { error: E.clientNotFound } }
        const balance = balanceOf(id)
        if (balance !== 0) return { code: 409, body: { error: E.balanceNotZero, balance } }
        q.delClient.run(id)
        return { code: 200, body: { deleted: true } }
      })
      return reply.code(out.code).send(out.body)
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  // ─── Ledger (read) ──────────────────────────────────────────────────────────

  app.get('/api/clients/:id/ledger', (req, reply) => {
    if (!requireRead(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    if (!q.getClient.get(id)) return reply.code(404).send({ error: E.clientNotFound })

    const asked = Number(req.query?.limit ?? 100)
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 500) : 100
    const byId = catIndex()
    return reply.send(q.ledger.all(id, limit).map(r => withPath(r, byId)))
  })

  // ─── Group linking (the /ulash handshake) ──────────────────────────────────
  // The bot mints a code in the client's group; this consumes it and binds the
  // chat. Mirrors redeem_code() in handlers/groups.py -- Node cannot call the
  // Python one, and the `used_at IS NULL` guard (not the SELECT) is what makes a
  // code single-use when two redeems race.

  const normaliseCode = (c) => String(c ?? '').replace(/[\s-]/g, '').toUpperCase()

  app.post('/api/clients/:id/link', (req, reply) => {
    const user = requireAuth(req, reply); if (!user) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    const client = q.getClient.get(id)
    if (!client) return reply.code(404).send({ error: E.clientNotFound })

    const code = normaliseCode(req.body?.code)
    if (!code) return reply.code(400).send({ error: 'kod kiritilmagan' })

    const row = db.prepare(
      'SELECT chat_id, title, expires_at, used_at FROM group_link_codes WHERE code = ?'
    ).get(code)
    if (!row)                return reply.code(404).send({ error: 'Bunday kod topilmadi.' })
    if (row.used_at != null) return reply.code(409).send({ error: 'Bu kod allaqachon ishlatilgan.' })

    // expires_at is written as UTC 'YYYY-MM-DD HH:MM:SS', which compares lexicographically.
    const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ')
    if (String(row.expires_at) <= nowUtc)
      return reply.code(409).send({ error: "Kod muddati tugagan. Guruhda /ulash ni qayta yuboring." })

    db.exec('BEGIN')
    try {
      const consumed = db.prepare(
        'UPDATE group_link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL'
      ).run(nowUtc, code)
      if (consumed.changes !== 1) {
        db.exec('ROLLBACK')
        return reply.code(409).send({ error: 'Bu kod allaqachon ishlatilgan.' })
      }
      // One group per client, and one client per group.
      db.prepare('UPDATE clients SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').run(row.chat_id)
      db.prepare('UPDATE clients SET telegram_chat_id = ? WHERE id = ?').run(row.chat_id, id)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      return reply.code(500).send({ error: String(err) })
    }

    return reply.send({ linked: true, telegram_chat_id: row.chat_id, title: row.title ?? null })
  })

  app.delete('/api/clients/:id/link', (req, reply) => {
    const user = requireAuth(req, reply); if (!user) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    if (!q.getClient.get(id)) return reply.code(404).send({ error: E.clientNotFound })
    db.prepare('UPDATE clients SET telegram_chat_id = NULL WHERE id = ?').run(id)
    return reply.send({ linked: false })
  })

  // ─── Prices ─────────────────────────────────────────────────────────────────

  app.get('/api/clients/:id/prices', (req, reply) => {
    if (!requireRead(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    if (!q.getClient.get(id)) return reply.code(404).send({ error: E.clientNotFound })

    const byId = catIndex()
    return reply.send(q.priceList.all(id).map(r => ({
      category_id:   r.category_id,
      name:          r.name,
      path:          fullPath(r.category_id, byId),
      unit_price:    r.override != null ? r.override : (r.default_price ?? null),
      default_price: r.default_price ?? null,
      is_override:   r.override != null,
    })))
  })

  app.put('/api/clients/:id/prices/:catId', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const id = idParam(req.params.id)
    const catId = idParam(req.params.catId)
    if (!id || !catId) return reply.code(400).send({ error: E.badId })
    if (!q.getClient.get(id)) return reply.code(404).send({ error: E.clientNotFound })

    const { unit_price } = req.body ?? {}
    if (!isMoney(unit_price)) return reply.code(400).send({ error: E.unitPrice })
    const target = stockTarget(catId)
    if (!target.ok) return reply.code(400).send({ error: target.error })

    try {
      tx(() => q.upsertPrice.run(id, catId, unit_price))
      return reply.send({ category_id: catId, unit_price })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  app.delete('/api/clients/:id/prices/:catId', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const id = idParam(req.params.id)
    const catId = idParam(req.params.catId)
    if (!id || !catId) return reply.code(400).send({ error: E.badId })
    if (!q.getClient.get(id)) return reply.code(404).send({ error: E.clientNotFound })

    try {
      tx(() => q.delPrice.run(id, catId))
      return reply.send({ removed: true })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  // The per-product fallback price. null clears it, sending price resolution
  // back to "narx belgilanmagan" for any client without an override.
  app.put('/api/categories/:id/price', (req, reply) => {
    if (!requireAuth(req, reply)) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })

    const { default_price } = req.body ?? {}
    const clearing = default_price === null
    if (!clearing && !isMoney(default_price)) return reply.code(400).send({ error: E.unitPrice })

    const target = stockTarget(id)
    if (!target.ok) return reply.code(400).send({ error: target.error })

    try {
      tx(() => q.setDefault.run(clearing ? null : default_price, id))
      return reply.send({ id, default_price: clearing ? null : default_price })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  // ─── Ledger (write) ─────────────────────────────────────────────────────────

  // Per-item guards, split at the point where the single routes look the client
  // up, so that route's check order (and therefore its status codes) is
  // unchanged while the batch routes reuse the same two halves.

  /** Shape of one { category_id, qty }. Returns the Uzbek reason, or null. */
  function itemShapeError(item) {
    const { category_id, qty } = item ?? {}
    if (!Number.isInteger(category_id) || category_id < 1) return E.catNotFound
    if (!isQty(qty)) return E.qty
    return null
  }

  /** Catalogue position and price of one item: { unit_price } or { error }. */
  function priceItem(clientId, categoryId) {
    const target = stockTarget(categoryId)
    if (!target.ok) return { error: target.error }
    const unit_price = resolvePrice(clientId, categoryId)
    if (unit_price == null) return { error: E.noPrice }
    return { unit_price }
  }

  const heldError = held => ({ error: `mijozda bu mahsulotdan ${held} dona bor`, held })

  /** The one place a movement's sign lives: a handover adds to the debt, a
   *  return subtracts. Every handover/return row — single or batch — is built
   *  here, so the two can never disagree about direction. */
  function movementRow(kind, { category_id, qty, unit_price }, note = null) {
    const total = qty * unit_price
    return { kind, category_id, qty, unit_price, amount: kind === 'return' ? -total : total, note }
  }

  /** Shared front half of handover/return: guards, price, held quantity. */
  function prepareMovement(req, reply, kind) {
    const id = idParam(req.params.id)
    if (!id) { reply.code(400).send({ error: E.badId }); return null }

    const { category_id, qty } = req.body ?? {}
    const shape = itemShapeError({ category_id, qty })
    if (shape) { reply.code(400).send({ error: shape }); return null }

    const client = q.getClient.get(id)
    if (!client) { reply.code(404).send({ error: E.clientNotFound }); return null }

    const priced = priceItem(id, category_id)
    if (priced.error) { reply.code(400).send({ error: priced.error }); return null }

    if (kind === 'return') {
      const { held } = q.heldQty.get(id, category_id)
      if (qty > held) { reply.code(409).send(heldError(held)); return null }
    }
    return {
      client,
      item: { category_id, qty, unit_price: priced.unit_price },
      note: cleanNote(req.body?.note),
    }
  }

  /** Append one ledger row, return its id. The CALLER owns the transaction —
   *  which is how a batch gets all-or-nothing out of the same insert. */
  function insertRow(user, clientId, row) {
    q.insLedger.run(
      clientId, row.kind, row.category_id ?? null, row.qty ?? null,
      row.unit_price ?? null, row.amount, row.note ?? null,
      user?.id ?? null, user?.first_name ?? user?.username ?? null,
      row.reverses_id ?? null,
    )
    return q.lastId.get().id
  }

  function insertAndReply(reply, user, client, row) {
    try {
      const entryId = tx(() => insertRow(user, client.id, row))
      const entry   = withPath(q.entry.get(entryId))
      const balance = balanceOf(client.id)
      post(client, entry, balance)   // after COMMIT, never awaited
      return reply.send({ entry, balance })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  }

  // handover → amount = +qty * unit_price
  app.post('/api/clients/:id/handover', (req, reply) => {
    const user = requireAuth(req, reply)
    if (!user) return
    const m = prepareMovement(req, reply, 'handover')
    if (!m) return
    return insertAndReply(reply, user, m.client, movementRow('handover', m.item, m.note))
  })

  // return → amount = -qty * unit_price, capped at what the client still holds
  app.post('/api/clients/:id/return', (req, reply) => {
    const user = requireAuth(req, reply)
    if (!user) return
    const m = prepareMovement(req, reply, 'return')
    if (!m) return
    return insertAndReply(reply, user, m.client, movementRow('return', m.item, m.note))
  })

  // ─── Batch handover / return (spec §3) ──────────────────────────────────────
  //
  // Same ledger, same guards, same renderer. Only two things differ from sending
  // the items one by one: every row commits or none does, and the whole movement
  // is announced in ONE Telegram message. The ledger stays per-product — a batch
  // is an atomicity and presentation concern, not a schema change.

  /** Which item, and why. `index` is 0-based, matching the payload. */
  const itemError = (index, reason, extra = {}) =>
    ({ error: `${index + 1}-mahsulot: ${reason}`, index, ...extra })

  /**
   * Validate the payload and fold it into the rows to insert.
   *
   * Merging happens BEFORE the qty cap and before the held check, so two rows
   * for the same product can neither slip past MAX_QTY nor each pass the
   * return-exceeds-held test on its own while busting it together.
   *
   * Returns { code, body } for the first bad item, or { rows }.
   */
  function prepareBatch(clientId, kind, items, note) {
    if (!Array.isArray(items) || items.length === 0)
      return { code: 400, body: { error: E.itemsRequired } }
    // The cap is on what was SENT: counting after the merge would let 51 rows of
    // one product through as a single row.
    if (items.length > MAX_BATCH)
      return { code: 400, body: { error: E.tooManyItems, count: items.length } }

    const merged = new Map()   // category_id → row, in first-seen order
    for (const [i, raw] of items.entries()) {
      const item  = raw ?? {}
      const shape = itemShapeError(item)
      if (shape) return { code: 400, body: itemError(i, shape, { category_id: item.category_id ?? null }) }

      const seen = merged.get(item.category_id)
      if (seen) {
        // The same product twice: one row carrying the summed quantity, which
        // still has to fit a ledger row's qty.
        const qty = seen.qty + item.qty
        if (!isQty(qty)) return { code: 400, body: itemError(i, E.qty, { category_id: item.category_id }) }
        seen.qty = qty
        continue
      }

      const priced = priceItem(clientId, item.category_id)
      if (priced.error) return { code: 400, body: itemError(i, priced.error, { category_id: item.category_id }) }
      merged.set(item.category_id, {
        index: i, category_id: item.category_id, qty: item.qty, unit_price: priced.unit_price,
      })
    }

    if (kind === 'return') {
      for (const row of merged.values()) {
        const { held } = q.heldQty.get(clientId, row.category_id)
        if (row.qty > held)
          return {
            code: 409,
            body: itemError(row.index, heldError(held).error, { category_id: row.category_id, held }),
          }
      }
    }

    return { rows: [...merged.values()].map(r => movementRow(kind, r, note)) }
  }

  function handleBatch(req, reply, kind) {
    const user = requireAuth(req, reply)
    if (!user) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })
    const client = q.getClient.get(id)
    if (!client) return reply.code(404).send({ error: E.clientNotFound })

    const note     = cleanNote(req.body?.note)
    const prepared = prepareBatch(id, kind, req.body?.items, note)
    if (prepared.body) return reply.code(prepared.code).send(prepared.body)

    try {
      // One transaction around every insert — a throw anywhere inside rolls the
      // whole movement back, so a batch can never land half-written.
      const ids = tx(() => prepared.rows.map(row => insertRow(user, client.id, row)))

      const byId    = catIndex()   // built once, not once per row
      const entries = ids.map(entryId => withPath(q.entry.get(entryId), byId))
      const balance = balanceOf(client.id)
      const total   = entries.reduce((sum, e) => sum + e.amount, 0)
      postMovement(client, entries, balance, note)   // after COMMIT, never awaited
      return reply.send({ entries, balance, total })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  }

  app.post('/api/clients/:id/handover/batch', (req, reply) => handleBatch(req, reply, 'handover'))
  app.post('/api/clients/:id/return/batch',   (req, reply) => handleBatch(req, reply, 'return'))

  // payment → amount = -amount
  app.post('/api/clients/:id/payment', (req, reply) => {
    const user = requireAuth(req, reply)
    if (!user) return
    const id = idParam(req.params.id)
    if (!id) return reply.code(400).send({ error: E.badId })

    const { amount } = req.body ?? {}
    if (!isMoney(amount)) return reply.code(400).send({ error: E.amount })

    const client = q.getClient.get(id)
    if (!client) return reply.code(404).send({ error: E.clientNotFound })

    return insertAndReply(reply, user, client, {
      kind: 'payment',
      amount: -amount,
      note: cleanNote(req.body?.note),
    })
  })

  // A correction is an opposite row, never an UPDATE. The reversal keeps the
  // original's kind/category/qty/unit_price so the ledger still reads as a pair,
  // and carries the opposite amount — which is what the balance sums.
  app.post('/api/ledger/:entryId/reverse', (req, reply) => {
    const user = requireAuth(req, reply)
    if (!user) return
    const entryId = idParam(req.params.entryId)
    if (!entryId) return reply.code(400).send({ error: E.badId })
    const note = cleanNote(req.body?.note)

    try {
      const out = tx(() => {
        const orig = q.rawEntry.get(entryId)
        if (!orig) return { code: 404, body: { error: E.entryNotFound } }
        if (orig.reverses_id != null) return { code: 409, body: { error: E.isReversal } }
        if (q.reversalOf.get(entryId)) return { code: 409, body: { error: E.alreadyRev } }

        const client = q.getClient.get(orig.client_id)
        if (!client) return { code: 409, body: { error: E.clientNotFound } }

        q.insLedger.run(
          orig.client_id, orig.kind, orig.category_id, orig.qty, orig.unit_price,
          -orig.amount, note ?? `Bekor qilindi #${entryId}`,
          user?.id ?? null, user?.first_name ?? user?.username ?? null,
          entryId,
        )
        // The cancelled row travels with the result: the receipt quotes its
        // label and its timestamp, and it is already in hand here.
        return { code: 200, id: q.lastId.get().id, client, orig }
      })
      if (out.code !== 200) return reply.code(out.code).send(out.body)

      const entry   = withPath(q.entry.get(out.id))
      const balance = balanceOf(out.client.id)
      post(out.client, entry, balance, out.orig)
      return reply.send({ entry, balance })
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })
}

export { MAX_QTY, MAX_MONEY, MAX_BATCH, KINDS }

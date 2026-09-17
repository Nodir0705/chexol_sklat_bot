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
import { formatReceipt, formatBatchReceipt, productLabel, tashkentStamp, KIND_UI } from './notify.js'
import { receiptSvg } from './receipt-image.js'
import { makeBoard } from './board.js'
import { boardImage } from './board-image.js'
import { buildBoard } from './board-grid.js'
import { makeReceiptLog } from './receipt-log.js'

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

  // ─── Edit (POST /api/ledger/:entryId/edit) ─────────────────────────────────
  notEditable:    "bu qatorni tuzatib bo'lmaydi",
  qtyless:        "bu qatorda dona yo'q",
  qtyZero:        "0 dona — bu yozuvni bekor qiling",
  editBody:       "faqat dona yoki summadan bittasini yuboring",
  editNoop:       "hech narsa o'zgarmadi",
}

// Receipts post as TEXT. The owner tried all three formats in the real groups
// and chose this one.
//
// The deciding constraint is not visual: Telegram never lets one account edit
// another account's message, a bot's included, so a posted receipt can only
// ever be changed by the bot itself. A picture makes that gap feel worse --
// it looks like a document, so not being able to touch it reads as broken --
// while a text receipt is at least quotable, searchable and copyable by hand.
//
// The renderer, the stamp bookkeeping and the correction flow all remain and
// all still work; RECEIPT_IMAGES=1 turns pictures back on with no other change.
const RECEIPT_IMAGES = process.env.RECEIPT_IMAGES === '1'

export default async function clientRoutes(app, { db, requireAuth, requireRead, notify } = {}) {
  // ─── Schema ─────────────────────────────────────────────────────────────────
  // Owned by server/schema.js, which index.js runs before registering this
  // plugin. This file used to declare its own copy; the two disagreed on index
  // names (idx_* vs ix_*), so running both produced six indexes over the same
  // three column sets — duplicated write cost on every insert, forever.
  migrate(db)

  // `corrects_id` — provenance for POST /api/ledger/:entryId/edit: the re-entry
  // points at the row it replaces, exactly as `reverses_id` points at the row a
  // reversal cancels. Written ONCE, at INSERT, on a row that did not exist a
  // moment earlier. It is NOT money: no route sums it, and dropping the column
  // leaves every balance bit-for-bit identical.
  //
  // server/schema.js owns the canonical DDL; this mirrors it so the route is
  // runnable against a file that has not been through that migration yet. Both
  // statements are idempotent — SQLite has no ADD COLUMN IF NOT EXISTS, and the
  // "duplicate column name" throw IS the success case on an already-migrated
  // file, which is the idiom schema.js and index.js already use.
  try { db.exec('ALTER TABLE client_ledger ADD COLUMN corrects_id INTEGER') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_client_ledger_corrects_id ON client_ledger (corrects_id)') } catch {}

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
           l.performed_by, l.performed_by_name, l.reverses_id, l.corrects_id,
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
    // The living board is REBUILT from this on every movement -- never
    // accumulated -- so its total cannot drift from SUM(amount). It must be the
    // FULL ledger ascending: q.ledger's DESC LIMIT slice would make the
    // "+N oldingi" fold row uncomputable.
    allLedger:  db.prepare(`${LEDGER_SELECT} WHERE l.client_id = ? ORDER BY l.created_at, l.id`),
    entry:      db.prepare(`${LEDGER_SELECT} WHERE l.id = ?`),
    rawEntry:   db.prepare('SELECT * FROM client_ledger WHERE id = ?'),
    reversalOf: db.prepare('SELECT id FROM client_ledger WHERE reverses_id = ? LIMIT 1'),
    // Which row (if any) already corrects this one. Read for display only --
    // the edit route's serialiser is reversalOf, because a corrected row is
    // always a reversed row and the reversal is what the write lock orders.
    correctionOf: db.prepare('SELECT id FROM client_ledger WHERE corrects_id = ? LIMIT 1'),
    insLedger:  db.prepare(`
      INSERT INTO client_ledger
        (client_id, kind, category_id, qty, unit_price, amount, note,
         performed_by, performed_by_name, reverses_id, corrects_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // ─── Receipt post bookkeeping ───────────────────────────────────────────────
  // Which Telegram message carried which ledger rows, so a later reversal can
  // STAMP that message instead of restating it. Pure display state: see
  // server/receipt-log.js. `build` is a hoisted function declaration further
  // down this closure — receipt-log.js imports NOTHING from here, so the
  // dependency runs one way only.
  const log = makeReceiptLog({ db, notify, build })

  // The living board: ONE message per client group, edited after every movement
  // rather than re-posted. It is rebuilt from the ledger each time, so it cannot
  // drift from SUM(amount), and like every other notification concern here it can
  // never throw into a request or affect a ledger write.
  const board = makeBoard({ db, notify, buildBoard, boardImage })

  /** Refresh a client's board. Fire-and-forget, after the rows are committed. */
  function refreshBoard(client) {
    if (!client || client.telegram_chat_id == null) return
    try {
      Promise.resolve(
        board.refresh(client, q.allLedger.all(client.id), balanceOf(client.id))
      ).catch(() => {})
    } catch {}
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
  function postText(client, render, { postId = null, replyTo = null, snapshot = null } = {}) {
    if (typeof notify !== 'function') return Promise.resolve()
    if (!client || client.telegram_chat_id == null) return Promise.resolve()
    try {
      const p = Promise.resolve(notify(client.telegram_chat_id, render(), { replyTo }))
        .then(res => { if (postId) log.settle(postId, res, { caption: null, snapshot }) })
        .catch(() => {})            // ← TERMINAL. See postReceipt.
      if (postId) log.track(postId, p)
      return p
    } catch {
      return Promise.resolve()
    }
  }

  const somCap = n => String(Math.abs(Math.trunc(n || 0)))
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + '\u00A0so\'m'

  /** Signed magnitude without the unit, for a "before → after" pair. */
  const numCap = n => (n < 0 ? '\u2212' : '')
    + String(Math.abs(Math.trunc(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')

  // notify.js escapes everything IT renders, but it keeps `esc` module-private
  // and the correction line below is built here. Category names and notes are
  // owner-entered and every message goes out as parse_mode HTML, so the one
  // line this file interpolates itself has to escape what it interpolates.
  const escHtml = v => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  function compactCaption(d) {
    const ui = KIND_UI[d.kind] ?? KIND_UI.adjustment
    const verb = d.orig ? 'Bekor qilindi' : ui.label
    const icon = d.orig ? '\u274C' : ui.icon
    const bal = d.balance < 0
      ? `Oldindan to'lov: <b>${somCap(d.balance)}</b>`
      : `Jami qarz: <b>${somCap(d.balance)}</b>`
    return `${icon} <b>${verb}</b> \u00B7 ${somCap(d.total)} \u00B7 ${bal}`
  }

  /** Shape a movement for the image renderer. Direction comes from the SIGNED
   *  sum, never the kind word — a reversal of a payment raises the debt while
   *  its header still reads "Bekor qilindi". */
  function receiptData(client, entries, balance, note, orig = null) {
    const rows = entries.filter(e => e.category_id != null)
    return {
      kind: orig ? 'reversal' : entries[0].kind,
      client: client?.name ?? '',
      // The card prints r.at verbatim -- formatting is the caller's job, and a
      // raw SQL stamp shipped "2026-09-15 10:04:00" onto a client's receipt.
      at: tashkentStamp(entries[0].created_at),
      note: note ?? entries[0].note ?? null,
      balance,
      delta: entries.reduce((a, e) => a + (e.amount || 0), 0),
      total: Math.abs(entries.reduce((a, e) => a + (e.amount || 0), 0)),
      // The reversal reference names what was cancelled: its label AND its stamp.
      orig: orig
        ? { label: (KIND_UI[orig.kind] ?? KIND_UI.adjustment).label,
            at: tashkentStamp(orig.created_at) }
        : null,
      items: rows.map(e => ({
        // `id` is carried for build(): the renderer ignores it, but `rows` is
        // entries FILTERED to category rows, so the items index is NOT the
        // entries index once a payment row is in play. The id is the only way
        // to map a cancelled ledger row onto the right item.
        id: e.id,
        label: productLabel(e.category_name, e.parent_name),
        qty: e.qty, amount: e.amount, unit_price: e.unit_price,
      })),
    }
  }

  /**
   * The RENDER INPUTS of a card, frozen as JSON at post time.
   *
   * Inputs, not receiptData's output: the text stamp path calls
   * formatBatchReceipt, which takes entry-shaped rows and calls productLabel
   * itself. This is what makes the additive invariant real — receiptData reads
   * category_name/parent_name from a live JOIN on product_categories and the
   * name from a mutable clients row, so without the snapshot a category rename
   * would silently change what an ALREADY-ISSUED card prints. It also means a
   * 50-row stamp costs zero joins.
   */
  function snapshotOf(client, entries, balance, note, orig) {
    return JSON.stringify({
      client: { name: client?.name ?? '' },
      entries,
      note: note ?? null,
      balance,
      orig: orig ? { kind: orig.kind, created_at: orig.created_at } : null,
    })
  }

  /**
   * Re-render a posted card with cancellation ink added and NOTHING else moved.
   * Injected into receipt-log.js, which therefore imports nothing from here.
   *
   * @param {object} post          the receipt_posts row
   * @param {number[]} cancelledIds ledger ids struck by this edit
   * @param {{count:number, all:boolean, at:string}} correction
   */
  function build(post, cancelledIds, correction) {
    const snap = JSON.parse(post.snapshot)
    const set  = new Set(cancelledIds)
    const isPhoto = post.is_photo === 1

    const text = snap.entries.length === 1
      ? formatReceipt(snap.entries[0], snap.balance, snap.orig, { cancelled: set, correction })
      : formatBatchReceipt(snap.entries, snap.balance, { note: snap.note, cancelled: set, correction })

    // The picture is built ONLY for a card that is a picture. A text card is
    // very often a card whose render already failed once; re-rendering it here
    // would make that card the one card that can never be stamped.
    let svg = null
    if (isPhoto) {
      const data = receiptData(snap.client, snap.entries, snap.balance, snap.note, snap.orig)
      data.items.forEach(it => { if (set.has(it.id)) it.cancelled = true })
      data.correction = correction
      svg = receiptSvg(data).svg
    }

    const head = `❌ <b>BEKOR QILINDI</b> · ${correction.count} qator · ${correction.at}`
               + ` — yangi kvitansiyaga qarang`
    const full = `${head}\n<s>${post.caption ?? ''}</s>`
    // Never slice the stored caption: it already contains HTML entities and a
    // cut entity is a message Telegram refuses. compactCaption is ~80 chars, so
    // this fallback is unreachable in practice — it exists so it can never be hit.
    const caption = full.length <= 1024 ? full : head

    return { svg, caption, text, isPhoto }
  }

  /** Picture first, text as the fallback inside notify.receipt.
   *
   *  Returns the send promise so a correction can wait for the message id, and
   *  settles the reserved receipt_posts row from the RESULT. Both are optional:
   *  with no postId this behaves exactly as it did before. */
  function postReceipt(client, entries, balance, note, orig = null,
                       { postId = null, replyTo = null } = {}) {
    if (typeof notify !== 'function') return Promise.resolve()
    if (!client || client.telegram_chat_id == null) return Promise.resolve()
    // Every path that posts a receipt also refreshes the board -- movements,
    // single entries and reversals alike -- so a correction can never leave the
    // board asserting a total the ledger has moved past.
    refreshBoard(client)
    // Declared outside the try so the outer catch's postText fallback can still
    // settle from it, but BUILT INSIDE it: a throw out here would land in
    // insertAndReply's catch AFTER COMMIT and answer 500 for a delivery that is
    // already on disk — the one thing this design exists to make impossible.
    let snapshot = null
    try {
      snapshot = postId ? snapshotOf(client, entries, balance, note, orig) : null
      // With a living board in the group, the board already lists every movement
      // -- so a full receipt beside it is the same information posted twice, which
      // is what the owner saw as "it sends text". The message shrinks to ONE line.
      //
      // It does not disappear: editing a message notifies nobody, so without this
      // a client would never learn a delivery happened. This line is their push
      // notification and their searchable record; the board carries the detail.
      const boardLive = board.isLive?.(client.id) ?? false
      const text = boardLive
        ? compactCaption(receiptData(client, entries, balance, note, orig))
        : entries.length === 1
          ? formatReceipt(entries[0], balance, orig)
          : formatBatchReceipt(entries, balance, { note })

      let send
      let caption = null
      if (RECEIPT_IMAGES && typeof notify.receipt === 'function') {
        // Built only when pictures are on: receiptSvg walks the whole layout,
        // which is real work to throw away on every text receipt.
        // receiptSvg returns { svg, width, height, ... } -- the markup is .svg.
        const data = receiptData(client, entries, balance, note, orig)
        // One line, not the item list: the picture already carries that, and
        // repeating it underneath reads as the message sent twice. What a
        // caption still buys is what a picture cannot do -- appear in a push
        // notification, be found by search, be read aloud.
        caption = compactCaption(data)
        send = notify.receipt(client.telegram_chat_id, {
          svg: receiptSvg(data).svg,
          caption,
          text,
          replyTo,
        })
      } else {
        send = notify(client.telegram_chat_id, text, { replyTo })
      }

      // THE TERMINAL .catch IS A CORRECTNESS REQUIREMENT, NOT STYLE. `send`
      // never rejects — notify and notify.receipt catch everything — so the
      // only way into a rejection is a throw out of settle(), a synchronous
      // DatabaseSync write that throws if the Python bot holds the file past
      // PRAGMA busy_timeout. Without this catch that rejection reaches the
      // unhandled-rejection handler and takes the SERVER down: a
      // notification-bookkeeping failure killing the process, in a design whose
      // whole thesis is that notification failures never propagate. settle() is
      // ALSO internally try/catch'd — belt and braces.
      const p = Promise.resolve(send)
        .then(res => { if (postId) log.settle(postId, res, { caption, snapshot }) })
        .catch(() => {})
      if (postId) log.track(postId, p)
      return p
    } catch (err) {
      // Rendering blew up -- still tell the client what they received, and
      // settle the reserved row from THAT send, so a render-throw post is never
      // left 'pending' (which would make it permanently unstampable).
      try {
        return postText(client, () => entries.length === 1
          ? formatReceipt(entries[0], balance, orig)
          : formatBatchReceipt(entries, balance, { note }), { postId, replyTo, snapshot })
      } catch { return Promise.resolve() }
    }
  }

  function post(client, entry, balance, orig = null, opts = {}) {
    return postReceipt(client, [entry], balance, null, orig, opts)
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
  function postMovement(client, entries, balance, note, postId = null) {
    return postReceipt(client, entries, balance, note, null, { postId })
  }

  /** Run fn inside a transaction; fn returns the value to hand back.
   *
   *  NO ROUTE IN THIS PROCESS MAY OPEN A TRANSACTION AND THEN AWAIT. Every
   *  BEGIN…COMMIT in this server is synchronous, and Node is single-threaded,
   *  so a promise callback cannot interleave into synchronous code — which is
   *  what makes receipt-log.js's fire-and-forget settle() UPDATE safe. If
   *  someone later writes an async handler that opens a transaction, that
   *  UPDATE could join it and vanish on its ROLLBACK. */
  /**
   * A refusal raised from INSIDE a transaction.
   *
   * tx() rolls back on a THROW and commits on a return, so a guard that can
   * fire after the first insert must throw or it commits the very row it was
   * refusing. Every guard in the edit route therefore throws this, and the
   * route's catch maps it back to the status code and Uzbek message it carries;
   * anything untagged is still a 500, as it is everywhere else in this file.
   */
  class Refusal extends Error {
    constructor(code, body) {
      super(body?.error ?? 'refused')
      this.name = 'Refusal'
      this.code = code
      this.body = body
    }
  }

  /** @returns {never} */
  function refuse(code, error, extra = {}) {
    throw new Refusal(code, { error, ...extra })
  }

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
      row.reverses_id ?? null, row.corrects_id ?? null,
    )
    return q.lastId.get().id
  }

  function insertAndReply(reply, user, client, row) {
    try {
      // The post row is reserved INSIDE the transaction — it is the only place
      // the new ledger id is known and committed together with the reservation.
      // log.record is internally try/catch'd, so its failure degrades to
      // "not stampable" and can never roll this delivery back.
      const { entryId, postId } = tx(() => {
        const entryId = insertRow(user, client.id, row)   // reads lastId itself
        const postId  = log.record(client, 'movement', [entryId])
        return { entryId, postId }
      })
      const entry   = withPath(q.entry.get(entryId))
      const balance = balanceOf(client.id)
      post(client, entry, balance, null, { postId })   // after COMMIT, never awaited
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
      // 50 rows costs 51 extra statements inside a transaction already doing 50
      // inserts, and the reservation commits with the rows it describes.
      const { ids, postId } = tx(() => {
        const ids    = prepared.rows.map(row => insertRow(user, client.id, row))
        const postId = log.record(client, 'movement', ids)
        return { ids, postId }
      })

      const byId    = catIndex()   // built once, not once per row
      const entries = ids.map(entryId => withPath(q.entry.get(entryId), byId))
      const balance = balanceOf(client.id)
      const total   = entries.reduce((sum, e) => sum + e.amount, 0)
      postMovement(client, entries, balance, note, postId)   // after COMMIT, never awaited
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
          entryId, null,
        )
        // `q.lastId` is SELECT last_insert_rowid(), so it must be read BEFORE
        // log.record runs its own inserts. Reading it after would return a
        // receipt_posts id where the reversal's LEDGER id belongs, and that
        // wrong id would flow straight into q.entry.get() and into
        // receipt_post_rows. FIRST. ALWAYS.
        const revId  = q.lastId.get().id
        const postId = log.record(client, 'reversal', [revId])   // clobbers lastId; harmless now
        // The cancelled row travels with the result: the receipt quotes its
        // label and its timestamp, and it is already in hand here.
        return { code: 200, id: revId, postId, client, orig }
      })
      if (out.code !== 200) return reply.code(out.code).send(out.body)

      const entry   = withPath(q.entry.get(out.id))
      const balance = balanceOf(out.client.id)
      reply.send({ entry, balance })          // the API answers FIRST, as it does today
      void correctionTail(out, entry, balance)
      return reply
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })


  // ─── Edit (a wrong NUMBER, corrected without touching a committed row) ──────
  //
  // THE DIFFERENCE FROM /reverse, STATED ONCE: a reversal says "this did not
  // happen". An edit says "this happened, with a different number". So an edit
  // is a reversal AND a re-entry, written in ONE transaction — two appended
  // rows, never an UPDATE, so balance is still SUM(amount) and the original is
  // still readable, byte-for-byte, with the operator and stamp that wrote it.
  //
  // BODY IS `{ qty }` OR `{ unit_price }` — EXACTLY ONE, AND NEVER `amount`.
  // The money is DERIVED here, which is what makes `qty × unit_price = amount`
  // an invariant by construction rather than by validation. Three renderers
  // (_goods(), formatReceipt, receiptSvg) print that as a literal equation; a
  // freely-typed total would make all three print a lie.
  //
  // WHAT EACH FIELD MEANS, decided:
  //   qty         — the COUNT was wrong. The row's SNAPSHOTTED unit_price is
  //                 PRESERVED and the money recomputes from it. Never
  //                 resolvePrice(): re-resolving would silently re-price a past
  //                 delivery every time the owner moves the price list.
  //   unit_price  — on a priced row, the UNIT PRICE was wrong (the sheet takes
  //                 a total and back-solves); on a qty-less row (a payment) it
  //                 is the MAGNITUDE of the whole row.
  //   category_id — IMMUTABLE. Changing the product is a different act: reverse
  //                 and re-enter.
  // The SIGN always comes from Math.sign(orig.amount), never from a kind table:
  // movementRow signs only 'return' and a payment gets its minus in the payment
  // route, so the original's own sign is the one honest, kind-independent rule.
  // A row whose edit would flip its sign is not an edit.
  //
  // client_prices is NEVER touched. The client's standing price is unchanged
  // and the next handover uses it; the sheet says so.
  app.post('/api/ledger/:entryId/edit', (req, reply) => {
    const user = requireAuth(req, reply)
    if (!user) return
    const entryId = idParam(req.params.entryId)
    if (!entryId) return reply.code(400).send({ error: E.badId })

    // ── Body shape, before the transaction ────────────────────────────────────
    const body = req.body ?? {}
    // Refused rather than ignored: an operator who sent `amount` expects it to
    // take effect, and silently dropping it would write a different number than
    // the one they were shown.
    if (body.amount !== undefined) return reply.code(400).send({ error: E.editBody })

    const hasQty   = body.qty !== undefined && body.qty !== null
    const hasPrice = body.unit_price !== undefined && body.unit_price !== null
    // Both or neither — there is no edit that means two things at once.
    if (hasQty === hasPrice) return reply.code(400).send({ error: E.editBody })

    if (hasQty) {
      // 0 is refused with its own message: "this did not happen" is a plain
      // reverse, and that route exists. Anything else falls to the range rule,
      // uncoerced — the string "10" is rejected, as everywhere else here.
      if (body.qty === 0) return reply.code(400).send({ error: E.qtyZero })
      if (!isQty(body.qty)) return reply.code(400).send({ error: E.qty })
    }
    if (hasPrice && !isMoney(body.unit_price)) {
      return reply.code(400).send({ error: E.unitPrice })
    }

    let out
    try {
      // ONE synchronous transaction, no await inside it (this file's standing
      // rule). Every refusal below THROWS rather than returns: the held check
      // fires after the reversal is already inserted, and only a throw gives it
      // the ROLLBACK that keeps an orphan reversal off the disk.
      out = tx(() => {
        const orig = q.rawEntry.get(entryId)
        if (!orig) refuse(404, E.entryNotFound)
        // A cancellation is not a business event with a wrong number in it; it
        // is the record that one was undone.
        if (orig.reverses_id != null) refuse(409, E.isReversal)
        // THE SERIALISER. Inside the transaction, on SQLite's write lock, so
        // two operators editing the same row at once is real serialisation and
        // not check-then-act. An already-corrected row is already reversed, so
        // this one guard covers both.
        if (q.reversalOf.get(entryId)) refuse(409, E.alreadyRev)
        // Math.sign(0) is 0, which would write an amount of 0 and call it a
        // correction. Nothing this server writes has amount 0.
        if (orig.amount === 0) refuse(409, E.notEditable)

        const priced = orig.qty != null
        if (hasQty && !priced) refuse(400, E.qtyless)

        const client = q.getClient.get(orig.client_id)
        if (!client) refuse(409, E.clientNotFound)

        // ── The corrected numbers, DERIVED ───────────────────────────────────
        const newQty   = priced ? (hasQty ? body.qty : orig.qty) : null
        const newPrice = priced ? (hasQty ? orig.unit_price : body.unit_price) : null
        const magnitude = priced ? newQty * newPrice : body.unit_price
        if (!isMoney(magnitude)) refuse(400, E.amount)
        const newAmount = Math.sign(orig.amount) * magnitude

        // A zero-delta pair is two rows of noise, one Telegram message and a
        // board refresh for a number that did not move.
        if (newQty === orig.qty && newPrice === orig.unit_price && newAmount === orig.amount) {
          refuse(400, E.editNoop)
        }

        // ── 1. THE REVERSAL. FIRST, ALWAYS ───────────────────────────────────
        // kind / category_id / qty / unit_price copied verbatim so the ledger
        // still reads as a pair; only the amount is opposite.
        const revId = insertRow(user, orig.client_id, {
          kind: orig.kind, category_id: orig.category_id,
          qty: orig.qty, unit_price: orig.unit_price,
          amount: -orig.amount,
          note: `Tuzatildi #${entryId}`,
          reverses_id: entryId,
        })

        // ── 2. HELD QUANTITY, BOTH DIRECTIONS ────────────────────────────────
        // Run only NOW: the reversal is already in this transaction, so this
        // reads the world WITHOUT the original and the delta is the re-entry's
        // alone. Both directions, not just a return — a handover edited DOWN
        // underneath an existing return drives held negative just as surely.
        // The kind filter mirrors q.heldQty's own WHERE clause: a delta counted
        // under a different predicate than the total is not a comparison.
        if (newQty !== null && orig.category_id != null
            && (orig.kind === 'handover' || orig.kind === 'return')) {
          const { held } = q.heldQty.get(orig.client_id, orig.category_id)
          const dir = newAmount > 0 ? newQty : -newQty
          if (held + dir < 0) {
            // `held` here EXCLUDES the original — its reversal is already in
            // this transaction — so it is not a figure to show anyone: in the
            // handover direction it is negative, and "the client has −8 of this"
            // is not a sentence. What the operator needs is the BOUND on the
            // new count; `held` in the payload is their REAL current holding,
            // which is the number every other screen shows them.
            const current = held + (orig.amount > 0 ? orig.qty : -orig.qty)
            if (newAmount > 0) {
              const min = -held
              refuse(409,
                `mijoz bu mahsulotdan ${min} dona qaytargan — kamida ${min} dona bo'lishi kerak`,
                { held: current, min })
            }
            // Return direction: `held` is what is left once this return is
            // taken out, which IS the cap, and the existing message says it.
            refuse(409, heldError(held).error, { held, max: held })
          }
        }

        // ── 3. THE RE-ENTRY ──────────────────────────────────────────────────
        // corrects_id is the provenance link; the note is the ORIGINAL's, since
        // what the operator wrote about the delivery is still true.
        const newId = insertRow(user, orig.client_id, {
          kind: orig.kind, category_id: orig.category_id,
          qty: newQty, unit_price: newPrice,
          amount: newAmount,
          note: orig.note,
          corrects_id: entryId,
        })

        // Both rows under ONE receipt_posts row, mirroring the reverse route,
        // so a later reversal of the re-entry has something to stamp.
        // insertRow reads q.lastId itself, immediately, so both ids are already
        // in hand before log.record runs its own inserts and clobbers it.
        const postId = log.record(client, 'movement', [revId, newId])
        return { id: newId, revId, postId, client, orig }
      })
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.code).send(err.body)
      return reply.code(500).send({ error: String(err) })
    }

    try {
      const entry   = withPath(q.entry.get(out.id))
      const balance = balanceOf(out.client.id)
      reply.send({ entry, balance })          // the API answers FIRST, as every route here does
      void editTail(out, entry, balance)
      return reply
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  /**
   * Tell the group, stamp the card that now asserts the old number, redraw the
   * board — a DETACHED async function with a terminal catch, started after
   * reply.send(), shaped exactly like correctionTail.
   *
   * THE ORDERING PRINCIPLE, same as correctionTail's: the correction LINE goes
   * first and is AWAITED. Editing a message notifies nobody, so this line is
   * the client's notification AND their searchable record — and a silent change
   * to a debt is precisely what a client must be told about. If everything
   * after it fails, the group UNDER-informs (a stale grid beside a correct
   * line) rather than MISINFORMS.
   */
  async function editTail(out, entry, balance) {
    try {
      // FIRST, and deliberately not last: refreshBoard never throws (it is
      // internally try/catch'd) and never awaits, so redrawing here costs the
      // line below nothing and guarantees the grid matches SUM(amount) even if
      // the group post fails. postReceipt takes the same position for the same
      // reason.
      refreshBoard(out.client)

      const orig = out.orig
      const label = entry.category_id != null
        ? productLabel(entry.category_name, entry.parent_name)
        : (KIND_UI[entry.kind] ?? KIND_UI.adjustment).label
      const parts = [`✎ <b>Tuzatildi</b>`, escHtml(label)]
      if (orig.qty != null && entry.qty != null && orig.qty !== entry.qty) {
        parts.push(`${numCap(orig.qty)} → ${numCap(entry.qty)} dona`)
      }
      if (orig.unit_price != null && entry.unit_price != null
          && orig.unit_price !== entry.unit_price) {
        parts.push(`${numCap(orig.unit_price)} → ${somCap(entry.unit_price)} / dona`)
      }
      // BOTH SIDES SIGNED, or the pair lies. somCap drops the sign, so
      // "−360 000 → 650 000 so'm" would read as a payment turning into a debt —
      // and a product label carries no kind word to correct the impression.
      parts.push(`${numCap(orig.amount)} → ${numCap(entry.amount)}\u00A0so'm`)
      parts.push(balance < 0
        ? `Oldindan to'lov: <b>${somCap(balance)}</b>`
        : `Jami qarz: <b>${somCap(balance)}</b>`)
      const line = parts.join(' · ')

      // Posted through postText with the reserved postId so the row SETTLES.
      // A receipt_posts row left 'pending' is permanently unstampable, which
      // would make the re-entry the one row whose own later correction could
      // never strike the message that carries it.
      let post = log.forEntry(orig.id)
      if (post && post.state === 'pending') {
        await log.settled(post.id)      // close the in-flight window
        post = log.get(post.id)
      }
      const live = out.client.telegram_chat_id
      const replyTo = log.stampable(post) && String(post.chat_id) === String(live)
        ? post.message_id
        : null

      // The snapshot is what makes the claim "a later reversal of the re-entry
      // has something to stamp" TRUE: stampable() requires snapshot != null, so
      // without one this card would be permanently un-inkable. It freezes the
      // RE-ENTRY's render inputs, which is the row a later reversal cancels.
      const snapshot = snapshotOf(out.client, [entry], balance, null, null)
      await postText(out.client, () => line, { postId: out.postId, replyTo, snapshot })

      // STAMP THE ORIGINAL'S CARD. Without this a receipt still sitting in the
      // group asserts "5 dona" while the board and the balance say 6.
      if (log.stampable(post)) await log.stamp(post.id)
    } catch (err) {
      console.warn('[receipt] edit:', err?.message ?? err)
    }
  }

  /**
   * Post the correction and stamp the card it corrects — a DETACHED async
   * function with a terminal catch, started after reply.send(). tx() stays
   * fully synchronous: the tail runs entirely outside it, so the
   * no-await-around-a-transaction rule is preserved by the very change that
   * introduces the first async work in this file.
   *
   * THE ORDERING PRINCIPLE: card B goes FIRST and is AWAITED. The correction
   * record must exist in the group even if every edit in the system fails —
   * that is what makes a failed edit UNDER-inform (today's shipped state: an
   * intact original plus a correct reversal card) rather than MISINFORM. A
   * stamp failure must never affect the correction post, and neither may touch
   * the API response.
   */
  async function correctionTail(out, entry, balance) {
    try {
      let post = log.forEntry(out.orig.id)
      if (post && post.state === 'pending') {
        await log.settled(post.id)      // close the in-flight window
        post = log.get(post.id)
      }
      // Thread card B under the original ONLY when that message lives in the
      // chat card B is going to. POST /api/clients/:id/link nulls
      // telegram_chat_id off whatever client held it and rebinds it, so after a
      // re-link the stored chat and the live chat are different groups and this
      // message_id would point at an unrelated message.
      const live = out.client.telegram_chat_id
      const replyTo = log.stampable(post) && String(post.chat_id) === String(live)
        ? post.message_id
        : null

      // Card B posts to the LIVE telegram_chat_id — postReceipt's own guard
      // drops it if the client has since been unlinked. The stamp below goes to
      // the STORED post.chat_id, where the message physically lives.
      await postReceipt(out.client, [entry], balance, null, out.orig,
                        { postId: out.postId, replyTo })
      if (log.stampable(post)) await log.stamp(post.id)
    } catch (err) {
      console.warn('[receipt] correction:', err?.message ?? err)
    }
  }
}

export { MAX_QTY, MAX_MONEY, MAX_BATCH, KINDS }

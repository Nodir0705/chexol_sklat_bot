import { createHmac } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import staticFiles from '@fastify/static'
import cors from '@fastify/cors'
import ExcelJS from 'exceljs'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: join(__dirname, '..', '.env') })
const DB_PATH  = join(__dirname, '..', 'sklat.db')
const FRONTEND = join(__dirname, '..', 'frontend', 'dist')
const PORT     = Number(process.env.PORT ?? 3001)
const BOT_TOKEN = process.env.BOT_TOKEN

// ─── SQLite ────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA busy_timeout=5000')
db.exec('PRAGMA foreign_keys=ON')

// Migrations — safe to run every startup
try { db.exec("ALTER TABLE stock_transactions ADD COLUMN performed_by_name TEXT") } catch {}
try { db.exec("ALTER TABLE stock_transactions ADD COLUMN action_type TEXT DEFAULT 'stock'") } catch {}
try { db.exec("ALTER TABLE product_categories  ADD COLUMN deleted_at DATETIME NULL") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN username TEXT") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'approved'") } catch {}

// ─── Prepared statements ───────────────────────────────────────────────────────

const q = {
  allCats:   db.prepare('SELECT id, parent_id, name FROM product_categories WHERE deleted_at IS NULL ORDER BY name'),
  allStock:  db.prepare('SELECT category_id, quantity FROM stock_items'),
  getStock:  db.prepare('SELECT quantity FROM stock_items WHERE category_id = ?'),
  insCat:    db.prepare('INSERT INTO product_categories (name, parent_id) VALUES (?, ?)'),
  lastId:    db.prepare('SELECT last_insert_rowid() AS id'),
  upsertStk: db.prepare(`
    INSERT INTO stock_items (category_id, quantity) VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE
    SET quantity = excluded.quantity, updated_at = CURRENT_TIMESTAMP
  `),
  logTxn: db.prepare(`
    INSERT INTO stock_transactions (category_id, delta, performed_by, performed_by_name, action_type)
    VALUES (?, ?, ?, ?, ?)
  `),
  history: db.prepare(`
    SELECT st.id, pc.name AS category_name, st.delta,
           COALESCE(st.performed_by_name, 'Noma''lum') AS performed_by_name,
           COALESCE(st.action_type, 'stock') AS action_type,
           st.created_at
    FROM stock_transactions st
    JOIN product_categories pc ON pc.id = st.category_id
    ORDER BY st.created_at DESC
    LIMIT ?
  `),
  report: db.prepare(`
    SELECT pc.name,
      SUM(CASE WHEN st.delta > 0 THEN  st.delta ELSE 0 END) AS total_in,
      SUM(CASE WHEN st.delta < 0 THEN -st.delta ELSE 0 END) AS total_out
    FROM stock_transactions st
    JOIN product_categories pc ON pc.id = st.category_id
    WHERE strftime('%Y', datetime(st.created_at, '+5 hours')) = ?
      AND strftime('%m', datetime(st.created_at, '+5 hours')) = ?
    GROUP BY pc.id, pc.name ORDER BY pc.name
  `),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyStockChange(categoryId, delta, userId, userName) {
  db.exec('BEGIN')
  try {
    const row = q.getStock.get(categoryId)
    const newQty = Math.max(0, (row ? row.quantity : 0) + delta)
    q.upsertStk.run(categoryId, newQty)
    q.logTxn.run(categoryId, delta, userId ?? null, userName ?? null, 'stock')
    db.exec('COMMIT')
    return newQty
  } catch (err) { db.exec('ROLLBACK'); throw err }
}

// Returns all descendant IDs (including self) using a recursive CTE
function allDescendantIds(rootId) {
  return db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT id FROM product_categories WHERE id = ?
      UNION ALL
      SELECT pc.id FROM product_categories pc
      JOIN tree t ON pc.parent_id = t.id
      WHERE pc.deleted_at IS NULL
    )
    SELECT id FROM tree
  `).all(rootId).map(r => r.id)
}

// Returns leaf descendants (no children among active categories) with their stock
function leafDescendants(ids) {
  if (!ids.length) return []
  const parentIds = new Set(
    db.prepare(`
      SELECT DISTINCT parent_id FROM product_categories
      WHERE parent_id IS NOT NULL AND deleted_at IS NULL
    `).all().map(r => r.parent_id)
  )
  return ids
    .filter(id => !parentIds.has(id))
    .map(id => {
      const cat = db.prepare('SELECT name FROM product_categories WHERE id = ?').get(id)
      const stk = db.prepare('SELECT quantity FROM stock_items WHERE category_id = ?').get(id)
      return { id, name: cat?.name ?? '?', qty: stk?.quantity ?? 0 }
    })
}

function parseInitData(initData) {
  if (!BOT_TOKEN || !initData) return null
  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return null
    params.delete('hash')
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n')
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const expected = createHmac('sha256', secret).update(checkStr).digest('hex')
    if (expected !== hash) return null
    const u = params.get('user')
    return u ? JSON.parse(u) : {}
  } catch { return null }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
// Set DEV_OPEN_ACCESS=1 ONLY for local browser testing; must be unset in production.
const ADMIN_ID = Number(process.env.ADMIN_ID ?? 0)
const DEV_OPEN_ACCESS = process.env.DEV_OPEN_ACCESS === '1'

// Returns the verified, approved Telegram user, or null. The user object only
// comes from cryptographically-validated initData, so names/ids can't be spoofed.
function verifiedUser(req) {
  const user = parseInitData(req.headers['x-init-data'])
  if (!user?.id) return null
  if (ADMIN_ID && user.id === ADMIN_ID) return user
  const row = db.prepare('SELECT status FROM users WHERE telegram_id = ?').get(user.id)
  return row && row.status === 'approved' ? user : null
}

// Guard for mutating routes. Returns the user on success; on failure it sends a
// 403 and returns null (the caller must `return` immediately). DEV_OPEN_ACCESS
// yields an anonymous user so local browser testing still works.
function requireAuth(req, reply) {
  const user = verifiedUser(req)
  if (user) return user
  if (DEV_OPEN_ACCESS) return { id: null, first_name: null, username: null }
  reply.code(403).send({ error: 'forbidden' })
  return null
}

// ─── Excel export ─────────────────────────────────────────────────────────────

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

function tashkentStr(utc) {
  if (!utc) return ''
  const d = new Date(String(utc).replace(' ', 'T') + 'Z')
  const t = new Date(d.getTime() + 5 * 60 * 60 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

// period: 'all' | 'week' | 'month'
function inPeriod(createdAt, period) {
  if (period === 'all' || !period) return true
  const d = new Date(String(createdAt).replace(' ', 'T') + 'Z')
  const nowTk = new Date(Date.now() + 5 * 60 * 60 * 1000)
  const tk = new Date(d.getTime() + 5 * 60 * 60 * 1000)
  if (period === 'week') {
    return d.getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000
  }
  if (period === 'month') {
    return tk.getUTCFullYear() === nowTk.getUTCFullYear() && tk.getUTCMonth() === nowTk.getUTCMonth()
  }
  return true
}

async function buildWorkbook(period = 'all') {
  // All categories (incl. deleted, so history names still resolve)
  const allCats = db.prepare('SELECT id, parent_id, name FROM product_categories').all()
  const byId = new Map(allCats.map(c => [c.id, c]))
  const parentIds = new Set(allCats.map(c => c.parent_id).filter(x => x != null))

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Sklat'
  wb.created = new Date(0)

  // Sheet 1: current stock (active leaves)
  const s1 = wb.addWorksheet('Zaxira')
  s1.columns = [
    { header: 'Mahsulot', key: 'name', width: 28 },
    { header: 'Joylashuv', key: 'path', width: 34 },
    { header: 'Miqdor (dona)', key: 'qty', width: 16 },
  ]
  s1.getRow(1).font = { bold: true }
  const activeLeaves = db.prepare(
    'SELECT id, name FROM product_categories WHERE deleted_at IS NULL'
  ).all().filter(c => !parentIds.has(c.id))
  for (const leaf of activeLeaves.sort((a, b) => a.name.localeCompare(b.name))) {
    const stk = db.prepare('SELECT quantity FROM stock_items WHERE category_id = ?').get(leaf.id)
    s1.addRow({ name: leaf.name, path: fullPath(leaf.id, byId), qty: stk?.quantity ?? 0 })
  }

  // Sheet 2: full transaction history
  const s2 = wb.addWorksheet('Hisobot')
  s2.columns = [
    { header: 'Sana (Toshkent)', key: 'date', width: 20 },
    { header: "Yo'nalish", key: 'dir', width: 12 },
    { header: 'Mahsulot', key: 'name', width: 28 },
    { header: 'Joylashuv', key: 'path', width: 34 },
    { header: 'Miqdor', key: 'qty', width: 10 },
    { header: 'Kim', key: 'who', width: 20 },
  ]
  s2.getRow(1).font = { bold: true }
  const txns = db.prepare(`
    SELECT st.delta, st.performed_by_name, st.action_type, st.created_at, st.category_id, pc.name
    FROM stock_transactions st
    JOIN product_categories pc ON pc.id = st.category_id
    ORDER BY st.created_at DESC
  `).all().filter(t => inPeriod(t.created_at, period))
  for (const t of txns) {
    const dir = t.action_type === 'delete' ? "O'chirildi" : (t.delta > 0 ? 'Kirish' : 'Chiqish')
    s2.addRow({
      date: tashkentStr(t.created_at),
      dir,
      name: t.name,
      path: fullPath(t.category_id, byId),
      qty: Math.abs(t.delta),
      who: t.performed_by_name || "Noma'lum",
    })
  }

  return wb
}

// ─── Fastify ──────────────────────────────────────────────────────────────────

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })
await app.register(compress, { global: true })
await app.register(staticFiles, { root: FRONTEND })

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/tree', (_req, reply) => {
  const categories = q.allCats.all()
  const stock = Object.fromEntries(q.allStock.all().map(r => [r.category_id, r.quantity]))
  return reply.send({ categories, stock })
})

app.post('/api/categories', (req, reply) => {
  if (!requireAuth(req, reply)) return
  const { name, parent_id = null } = req.body ?? {}
  if (!name?.trim()) return reply.code(400).send({ error: 'name required' })
  const trimmed = name.trim()
  db.exec('BEGIN')
  try {
    q.insCat.run(trimmed, parent_id)
    const { id } = q.lastId.get()
    db.exec('COMMIT')
    return reply.code(201).send({ id, name: trimmed, parent_id })
  } catch (err) {
    db.exec('ROLLBACK')
    return reply.code(500).send({ error: String(err) })
  }
})

// GET /api/categories/:id/impact — what will be deleted (for confirmation UI)
app.get('/api/categories/:id/impact', (req, reply) => {
  const rootId = Number(req.params.id)
  if (!rootId) return reply.code(400).send({ error: 'invalid id' })

  const cat = db.prepare('SELECT name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(rootId)
  if (!cat) return reply.code(404).send({ error: 'not found' })

  const descIds = allDescendantIds(rootId)
  const leaves  = leafDescendants(descIds)
  const totalStock = leaves.reduce((s, l) => s + l.qty, 0)

  return reply.send({ name: cat.name, descCount: descIds.length, leaves, totalStock })
})

// DELETE /api/categories/:id
app.delete('/api/categories/:id', (req, reply) => {
  const user = requireAuth(req, reply)
  if (!user) return
  const rootId = Number(req.params.id)
  if (!rootId) return reply.code(400).send({ error: 'invalid id' })

  const userName = user.first_name ?? user.username ?? (req.body ?? {}).user_name ?? null

  db.exec('BEGIN')
  try {
    const cat = db.prepare('SELECT name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(rootId)
    if (!cat) { db.exec('ROLLBACK'); return reply.code(404).send({ error: 'not found' }) }

    const descIds = allDescendantIds(rootId)
    const leaves  = leafDescendants(descIds)

    // Log every leaf deletion (even qty=0, for audit trail)
    for (const leaf of leaves) {
      q.logTxn.run(leaf.id, -leaf.qty, user?.id ?? null, userName, 'delete')
      // Zero out the stock item
      if (leaf.qty > 0) q.upsertStk.run(leaf.id, 0)
    }

    // Soft-delete all descendants
    const ph = descIds.map(() => '?').join(',')
    db.prepare(`UPDATE product_categories SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`)
      .run(...descIds)

    db.exec('COMMIT')
    return reply.send({ deleted: descIds.length, logsCreated: leaves.length })
  } catch (err) { db.exec('ROLLBACK'); return reply.code(500).send({ error: String(err) }) }
})

app.post('/api/transaction', (req, reply) => {
  const user = requireAuth(req, reply)
  if (!user) return
  const { category_id, qty, direction, user_name: bodyName } = req.body ?? {}
  if (!category_id || !qty || !['in', 'out'].includes(direction))
    return reply.code(400).send({ error: 'category_id, qty, direction required' })
  const userName = user.first_name ?? user.username ?? bodyName ?? null
  const delta    = direction === 'in' ? qty : -qty
  const newQty   = applyStockChange(category_id, delta, user?.id, userName)
  return reply.send({ category_id, new_qty: newQty, delta })
})

// GET /api/access — check if Telegram user is approved
app.get('/api/access', (req, reply) => {
  const user = parseInitData(req.headers['x-init-data'])
  if (!user?.id) {
    // No valid initData: deny by default (fail closed), unless explicitly in dev.
    return reply.send({ allowed: DEV_OPEN_ACCESS, reason: DEV_OPEN_ACCESS ? undefined : 'no_telegram' })
  }
  if (ADMIN_ID && user.id === ADMIN_ID) return reply.send({ allowed: true })
  const row = db.prepare('SELECT status FROM users WHERE telegram_id = ?').get(user.id)
  if (!row) return reply.send({ allowed: false, reason: 'pending' })
  if (row.status === 'approved') return reply.send({ allowed: true })
  return reply.send({ allowed: false, reason: row.status })
})

app.get('/api/history', (req, reply) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500)
  return reply.send(q.history.all(limit))
})

app.get('/api/report', (req, reply) => {
  const tashkent = new Date(Date.now() + 5 * 60 * 60 * 1000)
  const year  = String(req.query.year  ?? tashkent.getUTCFullYear())
  const month = String(req.query.month ?? tashkent.getUTCMonth() + 1).padStart(2, '0')
  return reply.send({ year, month, rows: q.report.all(year, month) })
})

const PERIOD_LABEL = { all: 'Hammasi', week: 'Hafta', month: 'Oy' }

function normPeriod(p) {
  return ['all', 'week', 'month'].includes(p) ? p : 'all'
}

function exportFileName(period) {
  const t = new Date(Date.now() + 5 * 60 * 60 * 1000)
  const p = n => String(n).padStart(2, '0')
  const suffix = period && period !== 'all' ? `_${PERIOD_LABEL[period]}` : ''
  return `Sklat${suffix}_${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}.xlsx`
}

// Direct download (browser fallback) — ?period=all|week|month
app.get('/api/export.xlsx', async (req, reply) => {
  const period = normPeriod(req.query.period)
  const wb = await buildWorkbook(period)
  const buf = await wb.xlsx.writeBuffer()
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  reply.header('Content-Disposition', `attachment; filename="${exportFileName(period)}"`)
  return reply.send(Buffer.from(buf))
})

// Send the Excel file to the user's Telegram chat (works inside the Mini App)
app.post('/api/export', async (req, reply) => {
  const user = verifiedUser(req)
  const period = normPeriod(req.body?.period)
  if (!user?.id) {
    // Not an approved Telegram user — fall back to the browser download.
    return reply.code(400).send({ error: 'no_telegram', url: `/api/export.xlsx?period=${period}` })
  }
  if (!BOT_TOKEN) return reply.code(500).send({ error: 'no_token' })

  try {
    const wb = await buildWorkbook(period)
    const buf = await wb.xlsx.writeBuffer()
    const form = new FormData()
    form.append('chat_id', String(user.id))
    form.append('caption', `📊 Sklat hisoboti — ${PERIOD_LABEL[period]}`)
    form.append('document', new Blob([buf],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      exportFileName(period))

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST', body: form,
    })
    const tgJson = await tgRes.json()
    if (!tgJson.ok) return reply.code(502).send({ error: 'telegram_failed', detail: tgJson.description })
    return reply.send({ sent: true })
  } catch (err) {
    return reply.code(500).send({ error: String(err) })
  }
})

app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' })
  return reply.sendFile('index.html')
})

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`✅ Sklat server → http://0.0.0.0:${PORT}`)

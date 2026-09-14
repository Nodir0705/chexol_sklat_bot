// Posting ledger receipts into a client's Telegram group (spec §4).
//
// The ledger row is committed before a receipt is attempted, and nothing here
// ever throws: a Telegram outage must not stop the owner recording business.
// Every failure is one log line and a { ok: false, error } return value.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000
const TELEGRAM_TIMEOUT_MS = 10_000

const KIND = {
  handover:   { icon: '📦', label: 'Berildi' },
  return:     { icon: '↩️', label: 'Qaytarildi' },
  payment:    { icon: '💵', label: "To'lov" },
  adjustment: { icon: '✏️', label: 'Tuzatish' },
}

// ─── Formatting ────────────────────────────────────────────────────────────────

/** Integer so'm with thousands separators: 2400000 → "2 400 000". */
export function formatSom(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const sign = n < 0 ? '-' : ''
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

// Category names are owner-entered and the message goes out as parse_mode HTML.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

/**
 * The receipt body, exactly as spec §4 shows it:
 *
 *   📦 Berildi: Ali cantara safir Qora — 5 dona × 120 000 = 600 000 so'm
 *   📅 14.09.2026 15:04
 *   💰 Umumiy qarz: 2 400 000 so'm
 *
 * `amount` is the signed ledger amount; the kind line carries the direction, so
 * the figure is shown as a magnitude. `balance` is printed signed.
 */
export function formatReceipt({ kind, categoryPath, qty, unitPrice, amount, balance, at } = {}) {
  const { icon, label } = KIND[kind] ?? KIND.adjustment
  const money = formatSom(Math.abs(Number(amount) || 0))
  const hasGoods = categoryPath != null && categoryPath !== '' &&
                   qty != null && Number.isFinite(Number(qty))

  const head = hasGoods
    ? `${icon} ${label}: ${esc(categoryPath)} — ${formatSom(qty)} dona × ${formatSom(unitPrice)} = ${money} so'm`
    : `${icon} ${label}: ${money} so'm`

  return [
    head,
    `📅 ${tashkentStamp(at)}`,
    `💰 Umumiy qarz: ${formatSom(balance)} so'm`,
  ].join('\n')
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

// Typed client for the Mijozlar (client ledger) routes.
// Every request carries the Telegram initData signature — the server rejects
// anything without it.

const BASE = '/api'

// api.ts keeps its own copy of this helper module-private, so it is repeated
// here rather than exported from there.
function initDataHeader(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData
  return initData ? { 'x-init-data': initData } : {}
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type LedgerKind = 'handover' | 'return' | 'payment' | 'adjustment'

export interface Client {
  id: number
  name: string
  phone: string | null
  telegram_chat_id: number | null
  /** Signed so'm. Positive = the client owes us. */
  balance: number
}

export interface ClientRef {
  id: number
  name: string
  phone: string | null
}

export interface LedgerEntry {
  id: number
  kind: LedgerKind
  category_id: number | null
  category_name: string | null
  category_path: string | null
  qty: number | null
  unit_price: number | null
  /** Signed so'm — the only field the balance reads. */
  amount: number
  note: string | null
  performed_by_name: string | null
  /** Set when this row cancels another. */
  reverses_id: number | null
  /** Set when this row is the corrected re-entry replacing another. */
  corrects_id: number | null
  /** Set when another row cancels this one. */
  reversed_by: number | null
  created_at: string
}

export interface ClientPrice {
  category_id: number
  name: string
  path: string
  /** null when neither an override nor a product default is set. */
  unit_price: number | null
  is_override: boolean
}

export interface LedgerResult {
  entry: LedgerEntry
  balance: number
}

export interface Statement {
  client: ClientRef
  period: { year: number; month: number }
  opening: number
  handovers: LedgerEntry[]
  returns: LedgerEntry[]
  payments: LedgerEntry[]
  totals: { given: number; returned: number; paid: number }
  closing: number
}

// ─── Money ────────────────────────────────────────────────────────────────────

const MINUS = '−'

/** Thousands separators without the currency word — for input previews. */
export function groupDigits(value: number): string {
  return Math.abs(Math.trunc(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** The one money formatter. 2400000 → "2 400 000 so'm". */
export function formatMoney(amount: number): string {
  const n = Math.trunc(amount)
  return `${n < 0 ? MINUS : ''}${groupDigits(n)} so'm`
}

/** Same figure with an explicit sign, for ledger rows where direction matters. */
export function formatSignedMoney(amount: number): string {
  const n = Math.trunc(amount)
  return n > 0 ? `+${formatMoney(n)}` : formatMoney(n)
}

// ─── Transport ────────────────────────────────────────────────────────────────

type JsonBody = Record<string, unknown>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const GENERIC_ERROR = "Server bilan bog'lanib bo'lmadi"

// The server answers failures with { error: "<message>" }. Surfacing that
// message beats a generic failure — the owner needs to know *why*.
function errorMessage(parsed: unknown): string {
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>
    if (typeof rec.error === 'string' && rec.error.trim()) return rec.error
    if (typeof rec.detail === 'string' && rec.detail.trim()) return rec.detail
  }
  return GENERIC_ERROR
}

async function req<T>(path: string, method: Method = 'GET', body?: JsonBody): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined
      ? initDataHeader()
      : { 'Content-Type': 'application/json', ...initDataHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(errorMessage(parsed))
  return parsed as T
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export function fetchClients(): Promise<Client[]> {
  return req<Client[]>('/clients')
}

export function fetchClient(id: number): Promise<Client> {
  return req<Client>(`/clients/${id}`)
}

export function createClient(name: string, phone: string | null): Promise<ClientRef> {
  return req<ClientRef>('/clients', 'POST', phone ? { name, phone } : { name })
}

export function updateClient(
  id: number, patch: { name?: string; phone?: string | null }
): Promise<ClientRef> {
  return req<ClientRef>(`/clients/${id}`, 'PATCH', patch)
}

export function deleteClient(id: number): Promise<{ deleted: boolean }> {
  return req<{ deleted: boolean }>(`/clients/${id}`, 'DELETE')
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

export function fetchLedger(id: number, limit = 100): Promise<LedgerEntry[]> {
  return req<LedgerEntry[]>(`/clients/${id}/ledger?limit=${limit}`)
}

export function postHandover(
  id: number, category_id: number, qty: number, note?: string
): Promise<LedgerResult> {
  return req<LedgerResult>(`/clients/${id}/handover`, 'POST',
    note ? { category_id, qty, note } : { category_id, qty })
}

export function postReturn(
  id: number, category_id: number, qty: number, note?: string
): Promise<LedgerResult> {
  return req<LedgerResult>(`/clients/${id}/return`, 'POST',
    note ? { category_id, qty, note } : { category_id, qty })
}

/** One line of a batch. The server merges repeats of the same category_id. */
export interface BatchItem {
  category_id: number
  qty: number
}

/**
 * A batch writes one ledger row per item inside a single transaction — all of
 * them commit or none do — and posts ONE Telegram receipt afterwards.
 */
export interface BatchResult {
  entries: LedgerEntry[]
  balance: number
  /** Sum of the line totals, unsigned so'm. */
  total: number
}

/** The server rejects a longer batch; the picker enforces the same cap. */
export const MAX_BATCH_ITEMS = 50

export function postHandoverBatch(
  id: number, items: BatchItem[], note?: string
): Promise<BatchResult> {
  return req<BatchResult>(`/clients/${id}/handover/batch`, 'POST',
    note ? { items, note } : { items })
}

export function postReturnBatch(
  id: number, items: BatchItem[], note?: string
): Promise<BatchResult> {
  return req<BatchResult>(`/clients/${id}/return/batch`, 'POST',
    note ? { items, note } : { items })
}

export function postPayment(
  id: number, amount: number, note?: string
): Promise<LedgerResult> {
  return req<LedgerResult>(`/clients/${id}/payment`, 'POST',
    note ? { amount, note } : { amount })
}

export function reverseEntry(entryId: number, note?: string): Promise<LedgerResult> {
  return req<LedgerResult>(`/ledger/${entryId}/reverse`, 'POST', note ? { note } : {})
}

/**
 * Correct a WRONG NUMBER on a committed row.
 *
 * EXACTLY ONE FIELD, AND NEVER `amount`. The server derives the money, which is
 * what keeps `qty × unit_price = amount` true by construction — a freely typed
 * total would make the receipt, the board and the statement print an equation
 * that does not hold. The union type is what stops a caller sending both.
 *
 *   { qty }        the COUNT was wrong; the row's snapshotted unit_price is
 *                  preserved and the money recomputes from it.
 *   { unit_price } on a priced row the UNIT PRICE was wrong (the sheet takes a
 *                  total and back-solves); on a payment it is the MAGNITUDE of
 *                  the whole row, and the sign is kept from the original.
 *
 * Nothing is updated in place: the server appends a reversal plus a corrected
 * re-entry in one transaction, and `client_prices` is never touched.
 */
export type EditEntryBody = { qty: number } | { unit_price: number }

export function editEntry(entryId: number, body: EditEntryBody): Promise<LedgerResult> {
  return req<LedgerResult>(`/ledger/${entryId}/edit`, 'POST', { ...body })
}

export interface LinkResult {
  linked: boolean
  telegram_chat_id?: number | null
  title?: string | null
}

/** Redeem a /ulash code, binding that Telegram group to this client. */
export function linkGroup(id: number, code: string): Promise<LinkResult> {
  return req<LinkResult>(`/clients/${id}/link`, 'POST', { code })
}

export function unlinkGroup(id: number): Promise<LinkResult> {
  return req<LinkResult>(`/clients/${id}/link`, 'DELETE')
}

// ─── Prices ───────────────────────────────────────────────────────────────────

export function fetchClientPrices(id: number): Promise<ClientPrice[]> {
  return req<ClientPrice[]>(`/clients/${id}/prices`)
}

export function setClientPrice(
  id: number, categoryId: number, unit_price: number
): Promise<{ category_id: number; unit_price: number }> {
  return req<{ category_id: number; unit_price: number }>(
    `/clients/${id}/prices/${categoryId}`, 'PUT', { unit_price })
}

export function removeClientPrice(
  id: number, categoryId: number
): Promise<{ removed: boolean }> {
  return req<{ removed: boolean }>(`/clients/${id}/prices/${categoryId}`, 'DELETE')
}

// ─── Statement ────────────────────────────────────────────────────────────────

export function fetchStatement(id: number, year: number, month: number): Promise<Statement> {
  return req<Statement>(`/clients/${id}/statement?year=${year}&month=${month}`)
}

export function sendStatement(
  id: number, year: number, month: number
): Promise<{ sent: boolean }> {
  return req<{ sent: boolean }>(`/clients/${id}/statement/send`, 'POST', { year, month })
}

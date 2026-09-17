import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTree } from '../hooks/useWarehouse'
import { haptic, useBackButton } from '../hooks/useTelegram'
import {
  useClient, useLedger, useClientPrices, useStatement,
  useHandoverBatch, useReturnBatch, usePayment, useReverseEntry, useEditEntry,
  useSetClientPrice, useRemoveClientPrice, useSendStatement,
  useLinkGroup,
  useUnlinkGroup,
} from '../hooks/useClients'
import { formatMoney, formatSignedMoney, groupDigits, MAX_BATCH_ITEMS } from '../api/clients'
import type { ClientPrice, LedgerEntry, LedgerKind, Statement } from '../api/clients'
import type { TreeNode } from '../types'

const ACCENT = 'var(--tg-theme-button-color)'
const RED    = '#ef4444'
const GREEN  = '#22c55e'
const MAX_QTY = 99999
const MAX_MONEY = 10_000_000_000

// ─── Shared state blocks ──────────────────────────────────────────────────────
// These live here rather than in ClientsPage because the list imports the detail
// page (to open a client); putting them the other way round would cycle.

/** Pull a human message out of whatever a mutation/query threw. */
export function errText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message
  return "Nimadir xato ketdi"
}

export function ErrorState({ error, onRetry, isRetrying = false }: {
  error: unknown
  onRetry: () => void
  isRetrying?: boolean
}) {
  return (
    <div className="mx-3 rounded-2xl p-8 text-center"
         style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
      <p className="text-4xl mb-3">⚠️</p>
      <p className="font-semibold mb-1">Ma'lumot yuklanmadi</p>
      <p className="text-xs mb-5 break-words" style={{ color: 'var(--tg-theme-hint-color)' }}>
        {errText(error)}
      </p>
      <button onClick={() => { haptic('light'); onRetry() }} disabled={isRetrying}
              className="px-5 py-2.5 rounded-xl font-semibold text-sm active:scale-95 transition-all disabled:opacity-50"
              style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
        {isRetrying ? 'Yuklanmoqda...' : '🔄 Qayta urinish'}
      </button>
    </div>
  )
}

export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="mx-3 rounded-2xl p-4 space-y-2 animate-pulse"
         style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 rounded-xl" style={{ background: 'var(--tg-theme-bg-color)' }} />
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="mx-3 rounded-2xl p-10 text-center"
         style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
      <p className="text-4xl mb-3">{icon}</p>
      <p className="font-medium mb-1" style={{ color: 'var(--tg-theme-text-color)' }}>{title}</p>
      {hint && <p className="text-sm">{hint}</p>}
    </div>
  )
}

/** Red banner used inside sheets when a mutation comes back with a server message. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5 text-sm break-words"
         style={{ background: 'rgba(239,68,68,.1)', color: RED }}>
      ⚠️ {message}
    </div>
  )
}

// ─── Tashkent time (mirrors HistoryPage; those helpers are module-private) ─────

const TZ_OFFSET_MS = 5 * 60 * 60 * 1000

function toTashkent(date: Date) {
  return new Date(date.getTime() + TZ_OFFSET_MS)
}

function parseUtc(utcStr: string) {
  return new Date(utcStr.replace(' ', 'T') + 'Z')
}

function tashkentDayStr(date: Date) {
  return toTashkent(date).toISOString().slice(0, 10)
}

function formatTashkent(utcStr: string): { dateLabel: string; time: string } {
  const t = toTashkent(parseUtc(utcStr))
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    dateLabel: `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  }
}

const MONTHS = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
]

// ─── Ledger presentation ──────────────────────────────────────────────────────

const KIND_META: Record<LedgerKind, { label: string; icon: string }> = {
  handover:   { label: 'Berildi',    icon: '📦' },
  return:     { label: 'Qaytarildi', icon: '↩️' },
  payment:    { label: "To'lov",     icon: '💵' },
  adjustment: { label: 'Tuzatish',   icon: '✏️' },
}

function LedgerRow({ entry, onReverse, onEdit }: {
  entry: LedgerEntry
  onReverse: (entry: LedgerEntry) => void
  onEdit: (entry: LedgerEntry, field: EditField) => void
}) {
  const { dateLabel, time } = formatTashkent(entry.created_at)
  const isReversed = entry.reversed_by !== null
  const isReversal = entry.reverses_id !== null
  const isCorrection = entry.corrects_id !== null
  const meta = KIND_META[entry.kind]
  // A reversal can never itself be reversed, and a cancelled row cannot be
  // cancelled twice — the server refuses both. An EDIT is a reversal plus a
  // re-entry, so it is offered under exactly the same condition: the two
  // controls can never disagree about which rows are still live.
  const canReverse = !isReversed && !isReversal

  const amountColor = isReversed
    ? 'var(--tg-theme-hint-color)'
    : entry.amount > 0 ? RED : GREEN

  return (
    <div className={`flex items-start gap-3 px-4 py-3.5 ${isReversed ? 'line-through opacity-60' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
          <span className="shrink-0">{meta.icon}</span>
          <span className="font-bold text-base shrink-0">
            {entry.category_name ?? meta.label}
          </span>
          {entry.category_path && (
            <span className="text-xs min-w-0 truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
              → {entry.category_path}
            </span>
          )}
          {isReversed && (
            /* inline-block keeps the row's line-through off the badge */
            <span className="inline-block text-xs px-1.5 py-0.5 rounded shrink-0 no-underline"
                  style={{ background: 'rgba(239,68,68,.1)', color: RED }}>
              Bekor qilindi
            </span>
          )}
          {isReversal && (
            <span className="text-xs px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'rgba(128,128,128,.15)', color: 'var(--tg-theme-hint-color)' }}>
              ↩ Bekor qilish
            </span>
          )}
          {/* ✎ marks a row that REPLACES an earlier one. Only the name, never
              the figures: these figures are the live ones and do belong in the
              total — marking them would read as "these numbers are suspect". */}
          {isCorrection && !isReversed && (
            <span className="text-xs px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'rgba(128,128,128,.15)', color: 'var(--tg-theme-hint-color)' }}>
              ✎ Tuzatilgan
            </span>
          )}
        </div>

        {entry.qty !== null && entry.unit_price !== null && (
          <p className="text-sm mt-0.5 whitespace-nowrap">
            {entry.qty} dona × {formatMoney(entry.unit_price)}
          </p>
        )}

        {entry.note && (
          <p className="text-xs mt-0.5 break-words" style={{ color: 'var(--tg-theme-hint-color)' }}>
            💬 {entry.note}
          </p>
        )}

        <p className="text-xs mt-0.5" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {entry.performed_by_name ?? 'Noma\'lum'}  •  {dateLabel}, {time}
        </p>
      </div>

      <div className="shrink-0 flex flex-col items-end gap-1.5">
        <span className="font-bold text-base whitespace-nowrap" style={{ color: amountColor }}>
          {formatSignedMoney(entry.amount)}
        </span>
        {canReverse && (
          <div className="flex gap-1.5">
            {/* Tapping the money opens SUMMA, tapping the count opens DONA —
                the sheet still shows both, so a mis-tap costs one tap. */}
            <button onClick={() => { haptic('light'); onEdit(entry, entry.qty !== null ? 'qty' : 'sum') }}
                    className="text-xs px-2 py-1 rounded-lg active:scale-90 transition-transform no-underline"
                    style={{ background: 'rgba(128,128,128,.15)', color: 'var(--tg-theme-text-color)' }}>
              ✏️ Tuzatish
            </button>
            <button onClick={() => { haptic('light'); onReverse(entry) }}
                    className="text-xs px-2 py-1 rounded-lg active:scale-90 transition-transform no-underline"
                    style={{ background: 'rgba(239,68,68,.1)', color: RED }}>
              ↩ Bekor
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

interface DayGroup {
  label: string
  headerLabel: string
  items: LedgerEntry[]
  debit: number
  credit: number
}

function groupByDay(entries: LedgerEntry[]): DayGroup[] {
  const result: { label: string; items: LedgerEntry[] }[] = []
  for (const entry of entries) {
    const { dateLabel } = formatTashkent(entry.created_at)
    const last = result[result.length - 1]
    if (last?.label === dateLabel) last.items.push(entry)
    else result.push({ label: dateLabel, items: [entry] })
  }

  const todayIso = tashkentDayStr(new Date())
  const yestIso  = tashkentDayStr(new Date(Date.now() - 86_400_000))

  // Cancelled rows and the rows that cancel them net to zero, so both are left
  // out of the day totals — the same way HistoryPage leaves out deletions.
  return result.map(g => {
    let debit = 0
    let credit = 0
    for (const e of g.items) {
      if (e.reversed_by !== null || e.reverses_id !== null) continue
      if (e.amount > 0) debit += e.amount
      else credit += -e.amount
    }
    const dayIso = tashkentDayStr(parseUtc(g.items[0].created_at))
    const headerLabel = dayIso === todayIso ? 'Bugun' : dayIso === yestIso ? 'Kecha' : g.label
    return { ...g, headerLabel, debit, credit }
  })
}

// ─── Reverse confirm ──────────────────────────────────────────────────────────

function ReverseConfirm({ clientId, entry, onClose }: {
  clientId: number
  entry: LedgerEntry
  onClose: () => void
}) {
  const reverse = useReverseEntry(clientId)
  const [err, setErr] = useState<string | null>(null)
  const meta = KIND_META[entry.kind]

  const submit = () => {
    if (reverse.isPending) return
    haptic('heavy')
    setErr(null)
    reverse.mutate({ entryId: entry.id }, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
         style={{ background: 'rgba(0,0,0,.5)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl p-5 shadow-2xl"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>
        <p className="text-4xl text-center mb-3">↩️</p>
        <p className="font-bold text-base text-center mb-2">Yozuvni bekor qilamizmi?</p>
        <div className="rounded-2xl p-4 mb-4 text-center space-y-1"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          <p className="font-semibold text-sm">
            {meta.icon} {entry.category_name ?? meta.label}
          </p>
          {entry.qty !== null && entry.unit_price !== null && (
            <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {entry.qty} dona × {formatMoney(entry.unit_price)}
            </p>
          )}
          <p className="font-bold whitespace-nowrap"
             style={{ color: entry.amount > 0 ? RED : GREEN }}>
            {formatSignedMoney(entry.amount)}
          </p>
        </div>
        <p className="text-xs text-center mb-4" style={{ color: 'var(--tg-theme-hint-color)' }}>
          Yozuv o'chmaydi — teskari yozuv qo'shiladi va qarz tiklanadi.
        </p>

        {err && <div className="mb-4"><ErrorNote message={err} /></div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={reverse.isPending}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm text-white disabled:opacity-50 active:scale-95 transition-all"
                  style={{ background: RED }}>
            {reverse.isPending ? '...' : 'Ha, bekor qilish'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Tuzatish (edit) sheet ────────────────────────────────────────────────────
//
// A committed row with a WRONG NUMBER in it. Not a reversal — a reversal says
// "this did not happen"; this says "this happened, with a different number".
//
// The server appends a reversal plus a corrected re-entry in one transaction,
// so nothing is updated in place and the balance is still SUM(amount). The body
// carries EXACTLY ONE field and never `amount`: the money is derived on the
// server, which is what keeps `qty × unit_price = amount` true by construction.
//
// WHAT EACH FIELD MEANS — the same two readings the route implements:
//   DONA  the COUNT was wrong. The row's snapshotted unit price is PRESERVED
//         and the money recomputes from it, so a past delivery is never
//         re-priced because the owner has since moved the price list.
//   SUMMA on a priced row the UNIT PRICE was wrong: this field takes a TOTAL
//         (what the owner means by "Summa") and back-solves the unit price. On
//         a payment there is no count, so SUMMA is the whole row and only its
//         magnitude moves — the sign stays the original's.

export type EditField = 'qty' | 'sum'

function EditSheet({ clientId, entry, balance, field, onClose }: {
  clientId: number
  entry: LedgerEntry
  balance: number
  field: EditField
  onClose: () => void
}) {
  const edit = useEditEntry(clientId)
  const meta = KIND_META[entry.kind]
  const { dateLabel, time } = formatTashkent(entry.created_at)

  // A row with no count (a payment) has only one editable number, so the DONA
  // half of this sheet does not exist for it.
  const priced = entry.qty !== null && entry.unit_price !== null
  const origQty  = entry.qty ?? 0
  const origUnit = entry.unit_price ?? 0
  const origTotal = Math.abs(entry.amount)

  const [mode, setMode] = useState<EditField>(priced ? field : 'sum')
  const [qty, setQty] = useState(origQty || 1)
  const [total, setTotal] = useState(origTotal)
  const [err, setErr] = useState<string | null>(null)

  // THE SIGN COMES FROM THE ORIGINAL, never from the kind — exactly as the
  // server does it. A payment that changes sign is not an edit.
  const sign = entry.amount < 0 ? -1 : 1

  // ── What will actually be written ──────────────────────────────────────────
  // SUMMA never touches the count and DONA never touches the price: the two
  // modes are the two readings, and each moves exactly one number.
  const solvedUnit   = priced && origQty > 0 ? Math.round(total / origQty) : 0
  const newQty       = mode === 'qty' ? qty : (priced ? origQty : null)
  const newUnitPrice = mode === 'qty' ? (priced ? origUnit : null) : (priced ? solvedUnit : null)
  const magnitude    = priced
    ? (mode === 'qty' ? qty * origUnit : solvedUnit * origQty)
    : total
  const newAmount    = sign * magnitude
  const newBalance   = balance - entry.amount + newAmount

  // The snap, shown BEFORE saving and never refused: an indivisible total is
  // the commonest real SUMMA edit (a round discount), so the operator is shown
  // the figure they will actually get and confirms it.
  const snapped = mode === 'sum' && priced && total > 0 && solvedUnit > 0 && magnitude !== total

  const tooSmall = mode === 'sum' && priced && total > 0 && solvedUnit < 1
  const noop =
    mode === 'qty' ? qty === origQty
    : priced       ? solvedUnit === origUnit
    :                total === origTotal
  const inRange =
    mode === 'qty' ? qty >= 1 && qty <= MAX_QTY && magnitude >= 1 && magnitude <= MAX_MONEY
    :                total >= 1 && magnitude >= 1 && magnitude <= MAX_MONEY

  const canSave = inRange && !tooSmall && !noop && !edit.isPending

  const submit = () => {
    if (!canSave) return
    haptic('medium')
    setErr(null)
    // EXACTLY ONE FIELD. `amount` is never sent — the server derives it.
    const body = mode === 'qty'
      ? { qty }
      : { unit_price: priced ? solvedUnit : total }
    edit.mutate({ entryId: entry.id, body }, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  const Figure = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>{label}</span>
      <span className="text-sm font-semibold whitespace-nowrap"
            style={{ color: tone ?? 'var(--tg-theme-text-color)' }}>{value}</span>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5 py-6 overflow-y-auto"
         style={{ background: 'rgba(0,0,0,.5)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl p-5 shadow-2xl my-auto"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>

        <p className="font-bold text-base mb-0.5">✏️ Tuzatish</p>
        {/* The FULL product name, untruncated — the board clips it, this must not. */}
        <p className="font-semibold text-sm break-words">
          {meta.icon} {entry.category_name ?? meta.label}
        </p>
        {entry.category_path && (
          <p className="text-xs break-words" style={{ color: 'var(--tg-theme-hint-color)' }}>
            📍 {entry.category_path}
          </p>
        )}
        <p className="text-xs mt-0.5 mb-3" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {dateLabel}, {time}
        </p>

        {/* Hozir — what the row says today */}
        <div className="rounded-2xl p-3.5 mb-3 space-y-1"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Hozir
          </p>
          {priced
            ? <Figure label="Dona × narx" value={`${origQty} × ${formatMoney(origUnit)}`} />
            : <Figure label="Summa" value={formatMoney(origTotal)} />}
          <Figure label="Yozuv" value={formatSignedMoney(entry.amount)}
                  tone={entry.amount > 0 ? RED : GREEN} />
        </div>

        {/* Which number was wrong. Only a priced row has two answers. */}
        {priced && (
          <div className="flex gap-1.5 p-1 rounded-2xl mb-3"
               style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
            {([['qty', 'DONA'], ['sum', 'SUMMA']] as const).map(([id, label]) => (
              <button key={id} onClick={() => { haptic('light'); setErr(null); setMode(id) }}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
                      style={mode === id
                        ? { background: ACCENT, color: 'var(--tg-theme-button-text-color)' }
                        : { color: 'var(--tg-theme-hint-color)' }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── DONA: the count was wrong; the price is kept ── */}
        {mode === 'qty' && priced && (
          <>
            <QtyStepper qty={qty} tone={ACCENT} large
                        onChange={(next) => { setErr(null); setQty(next) }} />
            <div className="flex flex-wrap gap-2 justify-center mt-3">
              {[1, 2, 5, 10, 20, 50].map(n => (
                <button key={n} onClick={() => { haptic('light'); setErr(null); setQty(n) }}
                        className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95"
                        style={qty === n
                          ? { background: ACCENT, color: 'var(--tg-theme-button-text-color)' }
                          : { background: 'var(--tg-theme-secondary-bg-color)' }}>
                  {n}
                </button>
              ))}
            </div>
            <p className="text-xs text-center mt-3" style={{ color: 'var(--tg-theme-hint-color)' }}>
              Narx o'zgarmaydi: {formatMoney(origUnit)} / dona
            </p>
            {qty < 1 && (
              <p className="text-xs text-center mt-1" style={{ color: RED }}>
                0 dona — bu yozuvni "↩ Bekor" bilan bekor qiling
              </p>
            )}
          </>
        )}

        {/* ── SUMMA: a total, back-solved into a unit price (or, on a payment,
              the whole row's magnitude) ── */}
        {mode === 'sum' && (
          <>
            <input type="text" inputMode="numeric" autoFocus
                   value={total === 0 ? '' : groupDigits(total)}
                   onChange={e => {
                     const digits = e.target.value.replace(/[^0-9]/g, '')
                     setErr(null)
                     setTotal(digits === '' ? 0 : Math.min(MAX_MONEY, Number(digits)))
                   }}
                   placeholder="0"
                   className="w-full text-center text-3xl font-bold outline-none border-b-2 py-2 bg-transparent"
                   style={{ borderColor: ACCENT, color: 'var(--tg-theme-text-color)' }} />
            <p className="text-center text-sm mt-2" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {priced ? `${origQty} dona uchun jami` : 'Yozuv summasi'}
            </p>

            {tooSmall && (
              <p className="text-xs text-center mt-2" style={{ color: RED }}>
                Juda kichik — {origQty} dona uchun kamida {formatMoney(origQty)} bo'lishi kerak
              </p>
            )}

            {/* SNAP, SHOW, CONFIRM — never refuse an indivisible total, and
                never print a number the ledger will not hold. */}
            {snapped && (
              <div className="rounded-2xl px-3 py-2.5 mt-3 text-center"
                   style={{ background: 'rgba(245,158,11,.12)' }}>
                <p className="text-sm font-semibold whitespace-nowrap">
                  {groupDigits(total)} → {groupDigits(magnitude)}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  ({groupDigits(solvedUnit)} × {origQty} dona)
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  Yaxlitlandi — saqlansa shu summa yoziladi.
                </p>
              </div>
            )}
          </>
        )}

        {/* Endi — what will be written, live */}
        <div className="rounded-2xl p-3.5 mt-3 space-y-1"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Endi
          </p>
          {priced && newQty !== null && newUnitPrice !== null
            ? <Figure label="Dona × narx" value={`${newQty} × ${formatMoney(newUnitPrice)}`} />
            : <Figure label="Summa" value={formatMoney(magnitude)} />}
          <Figure label="Yozuv" value={formatSignedMoney(newAmount)}
                  tone={newAmount > 0 ? RED : GREEN} />
          <Figure label="Yangi qarz" value={formatMoney(newBalance)}
                  tone={newBalance > 0 ? RED : GREEN} />
        </div>

        <p className="text-xs mt-3" style={{ color: 'var(--tg-theme-hint-color)' }}>
          Yozuv o'chmaydi — teskari yozuv va tuzatilgan yozuv qo'shiladi.
          {mode === 'sum' && priced && ' Narx faqat shu qatorda o\'zgardi.'}
        </p>

        {noop && inRange && !tooSmall && (
          <p className="text-xs mt-2" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Hech narsa o'zgarmadi.
          </p>
        )}

        {err && <div className="mt-3"><ErrorNote message={err} /></div>}

        <div className="flex gap-3 mt-4">
          <button onClick={onClose} disabled={edit.isPending}
                  className="flex-1 py-3 rounded-2xl font-semibold text-sm disabled:opacity-50"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={!canSave}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm disabled:opacity-40 active:scale-95 transition-all"
                  style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
            {edit.isPending ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Ledger tab ───────────────────────────────────────────────────────────────

function LedgerTab({ clientId, balance, openEdit, onEditConsumed }: {
  clientId: number
  balance: number
  /** A deep link asking for one row's edit sheet. One-shot. */
  openEdit: OpenEdit | null
  onEditConsumed: () => void
}) {
  const ledger = useLedger(clientId, 200)
  const [reversing, setReversing] = useState<LedgerEntry | null>(null)
  const [editing, setEditing] = useState<{ entry: LedgerEntry; field: EditField } | null>(null)
  const [linkMiss, setLinkMiss] = useState<string | null>(null)

  const groups = useMemo(() => groupByDay(ledger.data ?? []), [ledger.data])

  const startEdit = useCallback((entry: LedgerEntry, field: EditField) => {
    setLinkMiss(null)
    setEditing({ entry, field })
  }, [])

  // ── The deep link ─────────────────────────────────────────────────────────
  // Resolved against the ledger page already loaded — NOT through a new
  // GET /api/ledger/:id. An entry route unscoped by client would become a
  // whole-business dump by sequential rowid the moment DEV_OPEN_ACCESS=1, so
  // the concern is removed rather than documented. If the row is off the end of
  // the page, the page says so instead of opening a sheet on nothing.
  useEffect(() => {
    if (!openEdit) return
    if (ledger.isLoading || ledger.isError) return   // decide only on real data
    const row = (ledger.data ?? []).find(e => e.id === openEdit.entryId)
    if (!row) setLinkMiss("Qator ro'yxatda topilmadi")
    else if (row.reversed_by !== null || row.reverses_id !== null)
      setLinkMiss("Bu qatorni tuzatib bo'lmaydi")
    else startEdit(row, openEdit.field)
    onEditConsumed()
  }, [openEdit, ledger.isLoading, ledger.isError, ledger.data, startEdit, onEditConsumed])

  if (ledger.isLoading) return <CardSkeleton rows={4} />
  if (ledger.isError) {
    return <ErrorState error={ledger.error} onRetry={() => { void ledger.refetch() }}
                       isRetrying={ledger.isFetching} />
  }
  if (groups.length === 0) {
    return <EmptyState icon="🧾" title="Hali yozuv yo'q"
                       hint="Yuqoridagi Berish yoki To'lov tugmasini bosing" />
  }

  return (
    <>
      {linkMiss && (
        <div className="mx-3 mb-3">
          <ErrorNote message={linkMiss} />
        </div>
      )}

      <div className="mx-3 space-y-3">
        {groups.map(group => (
          <div key={group.label} className="rounded-2xl overflow-hidden"
               style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
            <div className="px-4 py-2 flex items-center justify-between gap-2"
                 style={{ borderBottom: '1px solid rgba(128,128,128,.1)' }}>
              <span className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--tg-theme-hint-color)' }}>
                {group.headerLabel}
              </span>
              <span className="flex items-center gap-3 text-xs font-bold shrink-0">
                {group.debit > 0 && (
                  <span className="whitespace-nowrap" style={{ color: RED }}>➕ {formatMoney(group.debit)}</span>
                )}
                {group.credit > 0 && (
                  <span className="whitespace-nowrap" style={{ color: GREEN }}>➖ {formatMoney(group.credit)}</span>
                )}
              </span>
            </div>
            {group.items.map((entry, i) => (
              <div key={entry.id}>
                <LedgerRow entry={entry} onReverse={setReversing} onEdit={startEdit} />
                {i < group.items.length - 1 && (
                  <div className="mx-4 h-px" style={{ background: 'rgba(128,128,128,.08)' }} />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {reversing && (
        <ReverseConfirm clientId={clientId} entry={reversing} onClose={() => setReversing(null)} />
      )}

      {editing && (
        <EditSheet clientId={clientId} entry={editing.entry} balance={balance}
                   field={editing.field} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

// ─── Product picker (the ActionPage tree, priced per client, multi-select) ─────

function CheckBox({ checked, tone }: { checked: boolean; tone: string }) {
  return (
    <span className="w-5 h-5 rounded-md shrink-0 flex items-center justify-center text-xs font-bold leading-none"
          style={checked
            ? { background: tone, color: '#fff' }
            : { border: '2px solid rgba(128,128,128,.35)' }}>
      {checked ? '✓' : ''}
    </span>
  )
}

function PickerRow({ node, price, tone, checked, atLimit, onToggle }: {
  node: TreeNode
  price: ClientPrice | undefined
  tone: string
  checked: boolean
  /** The batch is full — tapping an unchecked row explains instead of selecting. */
  atLimit: boolean
  onToggle: (id: number) => void
}) {
  const unitPrice = price?.unit_price ?? null
  const dimmed = atLimit && !checked
  return (
    <button onClick={() => onToggle(node.id)}
            className={`w-full flex items-center justify-between py-3 pl-4 pr-3 active:opacity-60 transition-opacity text-left ${dimmed ? 'opacity-40' : ''}`}
            style={{ background: checked ? 'rgba(128,128,128,.10)' : 'transparent' }}>
      <div className="flex items-center gap-2.5 min-w-0">
        <CheckBox checked={checked} tone={tone} />
        <span className={`text-sm truncate ${checked ? 'font-semibold' : ''}`}>{node.name}</span>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        <span className="text-sm px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap"
              style={unitPrice !== null
                ? { background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-text-color)' }
                : { background: 'rgba(239,68,68,.1)', color: RED }}>
          {unitPrice !== null ? formatMoney(unitPrice) : 'Narx yo\'q'}
        </span>
      </div>
    </button>
  )
}

interface PickerShared {
  priceById: Map<number, ClientPrice>
  tone: string
  checkedIds: ReadonlySet<number>
  atLimit: boolean
  onToggle: (id: number) => void
}

function PickerGroup({ models, ...shared }: { models: TreeNode[] } & PickerShared) {
  return (
    <div className="ml-4 mb-2 rounded-xl overflow-hidden"
         style={{ borderLeft: `2px solid ${ACCENT}`, background: 'rgba(128,128,128,.04)' }}>
      {models.map((m, i) => (
        <div key={m.id}>
          {i > 0 && <div className="h-px ml-4" style={{ background: 'rgba(128,128,128,.12)' }} />}
          <PickerRow node={m} price={shared.priceById.get(m.id)} tone={shared.tone}
                     checked={shared.checkedIds.has(m.id)} atLimit={shared.atLimit}
                     onToggle={shared.onToggle} />
        </div>
      ))}
    </div>
  )
}

function PickerCard({ root, ...shared }: { root: TreeNode } & PickerShared) {
  const directLeaves = root.children.filter(c => c.children.length === 0)
  const subTurs      = root.children.filter(c => c.children.length > 0)

  // How many of this card's leaves are already ticked — so a collapsed glance
  // down the page still shows where the selection lives.
  const pickedHere = useMemo(() => {
    let n = 0
    const walk = (node: TreeNode) => {
      if (node.children.length === 0) { if (shared.checkedIds.has(node.id)) n++; return }
      for (const c of node.children) walk(c)
    }
    walk(root)
    return n
  }, [root, shared.checkedIds])

  return (
    <div className="mx-3 mb-3 rounded-2xl overflow-hidden shadow-sm"
         style={{ border: '1px solid rgba(128,128,128,.12)' }}>
      <div className="px-4 py-3 flex items-center justify-between"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <div className="flex items-center gap-2 font-bold text-sm tracking-wide min-w-0">
          <span>📁</span><span className="truncate">{root.name.toUpperCase()}</span>
        </div>
        {pickedHere > 0 && (
          <span className="text-xs font-bold px-2.5 py-0.5 rounded-full ml-3 shrink-0"
                style={{ background: shared.tone, color: '#fff' }}>
            {pickedHere} ta
          </span>
        )}
      </div>

      <div className="py-1" style={{ background: 'var(--tg-theme-bg-color)' }}>
        {root.children.length === 0 && (
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Bo'sh — "Mahsulotlar" bo'limidan model qo'shing
          </p>
        )}

        {directLeaves.length > 0 && (
          <div className="py-1"><PickerGroup models={directLeaves} {...shared} /></div>
        )}

        {subTurs.map(sub => (
          <div key={sub.id} className="pt-1.5 pb-1">
            <div className="flex items-center gap-2 px-4 pb-1.5 min-w-0">
              <span className="text-sm">🗂</span>
              <span className="font-semibold text-sm truncate">{sub.name}</span>
              <span className="text-xs shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>
                ({sub.children.length})
              </span>
            </div>
            <PickerGroup models={sub.children} {...shared} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Quantity stepper (same input rules as ActionPage) ────────────────────────

function QtyStepper({ qty, tone, large, onChange }: {
  qty: number
  tone: string
  /** A single picked product gets the full-size control the old sheet had. */
  large: boolean
  onChange: (next: number) => void
}) {
  const size   = large ? 'w-14 h-14 text-3xl' : 'w-11 h-11 text-2xl'
  const field  = large ? 'w-24 text-3xl' : 'w-16 text-2xl'
  return (
    <div className={`flex items-center justify-center ${large ? 'gap-5' : 'gap-3'}`}>
      <button onClick={() => { haptic('light'); onChange(Math.max(1, qty - 1)) }}
              className={`${size} rounded-full font-bold active:scale-90 transition-transform`}
              style={{ background: 'var(--tg-theme-bg-color)' }}>−</button>
      <input type="text" inputMode="numeric"
             value={qty === 0 ? '' : String(qty)}
             onChange={e => {
               const digits = e.target.value.replace(/[^0-9]/g, '')
               onChange(digits === '' ? 0 : Math.min(MAX_QTY, Number(digits)))
             }}
             onBlur={() => { if (qty === 0) onChange(1) }}
             className={`${field} text-center font-bold bg-transparent border-b-2 outline-none`}
             style={{ borderColor: tone, color: 'var(--tg-theme-text-color)' }} />
      <button onClick={() => { haptic('light'); onChange(Math.min(MAX_QTY, qty + 1)) }}
              className={`${size} rounded-full font-bold active:scale-90 transition-transform`}
              style={{ background: 'var(--tg-theme-bg-color)' }}>+</button>
    </div>
  )
}

// ─── Berish / Qaytarish sheet ─────────────────────────────────────────────────
// Two steps: tick the products, then set every quantity and send once. The
// whole basket goes to the batch endpoint in a single request — including a
// basket of one, so the server owns the one-item-vs-list receipt shape.

/** One line of the basket, resolved against the client's price list. */
interface BasketLine {
  categoryId: number
  name: string
  path: string | null
  unitPrice: number | null
  isOverride: boolean
  qty: number
  /** null when the price does not resolve — such a line blocks the send. */
  total: number | null
}

/** BottomNav is z-50 and later in the DOM, so it paints over this sheet. */
const NAV_GAP = 'calc(env(safe-area-inset-bottom, 0px) + 64px)'

function BasketRow({ line, tone, solo, onQty, onRemove }: {
  line: BasketLine
  tone: string
  solo: boolean
  onQty: (id: number, next: number) => void
  onRemove: (id: number) => void
}) {
  const blocked = line.unitPrice === null
  return (
    <div className="rounded-2xl p-4 space-y-3"
         style={{ background: 'var(--tg-theme-secondary-bg-color)',
                  border: blocked ? `1px solid ${RED}` : '1px solid transparent' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {line.path && (
            <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
              📍 {line.path}
            </p>
          )}
          <p className="font-semibold truncate">{line.name}</p>
          <p className="text-sm mt-0.5 whitespace-nowrap"
             style={{ color: blocked ? RED : 'var(--tg-theme-hint-color)' }}>
            {blocked
              ? 'narx belgilanmagan'
              : `Narx: ${formatMoney(line.unitPrice ?? 0)}${line.isOverride ? ' (shaxsiy)' : ''}`}
          </p>
        </div>
        <button onClick={() => onRemove(line.categoryId)}
                className="text-2xl shrink-0 leading-none"
                style={{ color: 'var(--tg-theme-hint-color)' }}>✕</button>
      </div>

      {blocked ? (
        <p className="text-xs" style={{ color: RED }}>
          Avval "Narxlar" bo'limidan narx belgilang yoki bu mahsulotni ro'yxatdan olib tashlang
        </p>
      ) : (
        <>
          <QtyStepper qty={line.qty} tone={tone} large={solo}
                      onChange={(next) => onQty(line.categoryId, next)} />
          {solo && (
            <div className="flex flex-wrap gap-2 justify-center">
              {[1, 2, 5, 10, 20, 50].map(n => (
                <button key={n} onClick={() => { haptic('light'); onQty(line.categoryId, n) }}
                        className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95"
                        style={line.qty === n
                          ? { background: tone, color: '#fff' }
                          : { background: 'var(--tg-theme-bg-color)', color: 'var(--tg-theme-text-color)' }}>
                  {n}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {line.qty} dona
            </span>
            <span className="font-bold text-sm whitespace-nowrap" style={{ color: tone }}>
              {line.total === null ? '—' : formatMoney(line.total)}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function GoodsSheet({ clientId, clientName, kind, onClose }: {
  clientId: number
  clientName: string
  kind: 'handover' | 'return'
  onClose: () => void
}) {
  const isHandover = kind === 'handover'
  const tone = isHandover ? RED : GREEN

  const tree   = useTree()
  const prices = useClientPrices(clientId)
  const handoverBatch = useHandoverBatch(clientId)
  const returnBatch   = useReturnBatch(clientId)
  const mut = isHandover ? handoverBatch : returnBatch

  const [step, setStep] = useState<'pick' | 'qty'>('pick')
  /** Pick order, so the basket reads in the order the owner tapped. */
  const [pickedIds, setPickedIds] = useState<number[]>([])
  const [qtyById, setQtyById] = useState<Record<number, number | undefined>>({})
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [limitHit, setLimitHit] = useState(false)

  const priceById = useMemo(() => {
    const map = new Map<number, ClientPrice>()
    for (const p of prices.data ?? []) map.set(p.category_id, p)
    return map
  }, [prices.data])

  // The price list is the naming authority; the tree covers any leaf it misses.
  const leafNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const l of tree.data?.leaves ?? []) map.set(l.id, l.name)
    return map
  }, [tree.data])

  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds])

  const lines = useMemo<BasketLine[]>(() => pickedIds.map(id => {
    const price = priceById.get(id)
    const qty = qtyById[id] ?? 1
    const unitPrice = price?.unit_price ?? null
    return {
      categoryId: id,
      name: price?.name ?? leafNameById.get(id) ?? '—',
      path: price?.path ?? null,
      unitPrice,
      isOverride: price?.is_override ?? false,
      qty,
      total: unitPrice === null ? null : unitPrice * qty,
    }
  }), [pickedIds, qtyById, priceById, leafNameById])

  const blockedCount = lines.filter(l => l.unitPrice === null).length
  const emptyQty     = lines.some(l => l.qty < 1)
  const grandTotal   = lines.reduce((sum, l) => sum + (l.total ?? 0), 0)
  const totalPieces  = lines.reduce((sum, l) => sum + l.qty, 0)
  const canSend      = lines.length > 0 && blockedCount === 0 && !emptyQty && !mut.isPending

  const toggle = useCallback((id: number) => {
    setErr(null)
    if (pickedSet.has(id)) {
      haptic('light')
      setLimitHit(false)
      setPickedIds(ids => ids.filter(x => x !== id))
      setQtyById(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }
    if (pickedIds.length >= MAX_BATCH_ITEMS) {
      haptic('error')
      setLimitHit(true)
      return
    }
    haptic('light')
    setLimitHit(false)
    setPickedIds(ids => [...ids, id])
    setQtyById(prev => ({ ...prev, [id]: prev[id] ?? 1 }))
  }, [pickedIds, pickedSet])

  const setQty = useCallback((id: number, next: number) => {
    setQtyById(prev => ({ ...prev, [id]: next }))
  }, [])

  // Dropping the last line has nowhere to stand, so it walks back to the tree.
  const removeLine = useCallback((id: number) => {
    toggle(id)
    if (pickedIds.length <= 1) setStep('pick')
  }, [toggle, pickedIds])

  const retry = () => {
    if (tree.isError) void tree.refetch()
    if (prices.isError) void prices.refetch()
  }

  const goToQty = () => {
    if (pickedIds.length === 0) return
    haptic('medium')
    setErr(null)
    setStep('qty')
  }

  const submit = () => {
    if (!canSend) return
    haptic('medium')
    setErr(null)
    const trimmed = note.trim()
    mut.mutate(
      {
        items: lines.map(l => ({ category_id: l.categoryId, qty: l.qty })),
        note: trimmed === '' ? undefined : trimmed,
      },
      {
        onSuccess: () => { haptic('success'); onClose() },
        onError: (e) => { haptic('error'); setErr(errText(e)) },
      },
    )
  }

  const roots  = tree.data?.tree ?? []
  const busy   = tree.isLoading || prices.isLoading
  const failed = tree.isError || prices.isError
  const showPickBar = step === 'pick' && !busy && !failed && roots.length > 0

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto"
         style={{ background: 'var(--tg-theme-bg-color)' }}>
      {/* Sheet header */}
      <div className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
           style={{ background: 'var(--tg-theme-secondary-bg-color)',
                    borderBottom: '1px solid rgba(128,128,128,.12)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {step === 'qty' && (
            /* Back to the tree with the ticks and the quantities still set. */
            <button onClick={() => { haptic('light'); setStep('pick') }}
                    className="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center text-lg active:scale-90 transition-transform"
                    style={{ background: 'var(--tg-theme-bg-color)' }}>‹</button>
          )}
          <div className="min-w-0">
            <p className="font-bold text-base" style={{ color: tone }}>
              {isHandover ? '📦 Berish' : '↩️ Qaytarish'}
            </p>
            <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {clientName} • {step === 'pick' ? '1/2 Tanlash' : '2/2 Miqdor'}
            </p>
          </div>
        </div>
        <button onClick={onClose} className="text-2xl ml-3 shrink-0"
                style={{ color: 'var(--tg-theme-hint-color)' }}>✕</button>
      </div>

      {/* BottomNav shares this z-index and sits later in the DOM, so leave room
          for it — and for the selection bar — rather than letting either cover
          the content. */}
      <div className="pt-3"
           style={{ paddingBottom: showPickBar
             ? 'calc(env(safe-area-inset-bottom, 0px) + 190px)'
             : 'calc(env(safe-area-inset-bottom, 0px) + 110px)' }}>

        {/* ── Step 1: tick the products ── */}
        {step === 'pick' && (
          <>
            {busy && <CardSkeleton rows={4} />}
            {!busy && failed && (
              <ErrorState error={tree.error ?? prices.error} onRetry={retry}
                          isRetrying={tree.isFetching || prices.isFetching} />
            )}
            {!busy && !failed && roots.length === 0 && (
              <EmptyState icon="📭" title="Mahsulot yo'q"
                          hint={'"Mahsulotlar" bo\'limidan mahsulot qo\'shing'} />
            )}
            {!busy && !failed && roots.map(root => (
              <PickerCard key={root.id} root={root} priceById={priceById} tone={tone}
                          checkedIds={pickedSet}
                          atLimit={pickedIds.length >= MAX_BATCH_ITEMS}
                          onToggle={toggle} />
            ))}
          </>
        )}

        {/* ── Step 2: a quantity per product, then one send ── */}
        {step === 'qty' && (
          <div className="mx-3 space-y-3">
            {lines.map(line => (
              <BasketRow key={line.categoryId} line={line} tone={tone}
                         solo={lines.length === 1}
                         onQty={setQty} onRemove={removeLine} />
            ))}

            <button onClick={() => { haptic('light'); setStep('pick') }}
                    className="w-full py-3 rounded-2xl font-semibold text-sm active:scale-95 transition-all"
                    style={{ background: 'var(--tg-theme-secondary-bg-color)', color: ACCENT }}>
              ＋ Yana mahsulot tanlash
            </button>

            {/* Optional note */}
            <input value={note} onChange={e => setNote(e.target.value)}
                   placeholder="Izoh (ixtiyoriy)"
                   className="w-full text-sm outline-none rounded-2xl px-4 py-3"
                   style={{ background: 'var(--tg-theme-secondary-bg-color)',
                            color: 'var(--tg-theme-text-color)' }} />

            {/* Grand total */}
            <div className="rounded-2xl px-4 py-3.5 flex items-center justify-between"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <div className="min-w-0">
                <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  Jami {isHandover ? 'qarzga' : 'qarzdan'}
                </p>
                <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  {lines.length} ta mahsulot • {totalPieces} dona
                </p>
              </div>
              <span className="font-bold text-lg whitespace-nowrap ml-3 shrink-0" style={{ color: tone }}>
                {blockedCount > 0 ? '—' : `${isHandover ? '+' : '−'}${formatMoney(grandTotal)}`}
              </span>
            </div>

            {blockedCount > 0 && (
              <ErrorNote message={`${blockedCount} ta mahsulotda narx belgilanmagan — narx belgilang yoki ro'yxatdan olib tashlang`} />
            )}

            {err && <ErrorNote message={err} />}

            <div className="flex gap-3">
              <button onClick={onClose} disabled={mut.isPending}
                      className="flex-1 py-4 rounded-2xl font-semibold text-sm disabled:opacity-50"
                      style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
                Bekor
              </button>
              <button onClick={submit} disabled={!canSend}
                      className="flex-[2] py-4 rounded-2xl font-bold text-white text-base active:scale-95 transition-all disabled:opacity-50"
                      style={{ background: tone }}>
                {mut.isPending ? 'Yuborilmoqda...' : `✅ Yuborish (${totalPieces} dona)`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Running count + Davom etish, parked above BottomNav */}
      {showPickBar && (
        <div className="fixed left-0 right-0 px-3" style={{ bottom: NAV_GAP, zIndex: 20 }}>
          <div className="rounded-2xl p-3 shadow-2xl"
               style={{ background: 'var(--tg-theme-secondary-bg-color)',
                        border: '1px solid rgba(128,128,128,.14)' }}>
            <p className="text-xs text-center mb-2" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {pickedIds.length === 0
                ? 'Mahsulotlarni belgilang'
                : `${pickedIds.length} ta mahsulot tanlandi`}
            </p>
            {limitHit && (
              <p className="text-xs text-center mb-2" style={{ color: RED }}>
                Bir martada ko'pi bilan {MAX_BATCH_ITEMS} ta mahsulot yuboriladi
              </p>
            )}
            <button onClick={goToQty} disabled={pickedIds.length === 0}
                    className="w-full py-3.5 rounded-2xl font-bold text-white text-base active:scale-95 transition-all disabled:opacity-40"
                    style={{ background: tone }}>
              Davom etish ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── To'lov sheet ─────────────────────────────────────────────────────────────

function PaymentSheet({ clientId, clientName, balance, onClose }: {
  clientId: number
  clientName: string
  balance: number
  onClose: () => void
}) {
  const pay = usePayment(clientId)
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    if (amount < 1 || pay.isPending) return
    haptic('medium')
    setErr(null)
    const trimmed = note.trim()
    pay.mutate({ amount, note: trimmed === '' ? undefined : trimmed }, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
         style={{ background: 'rgba(0,0,0,.45)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl p-5 shadow-2xl"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>
        <p className="font-bold text-base mb-1">💵 To'lov</p>
        <p className="text-xs mb-4 truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {clientName} • Qarz: {formatMoney(balance)}
        </p>

        <input type="text" inputMode="numeric" autoFocus
               value={amount === 0 ? '' : groupDigits(amount)}
               onChange={e => {
                 const digits = e.target.value.replace(/[^0-9]/g, '')
                 setAmount(digits === '' ? 0 : Math.min(MAX_MONEY, Number(digits)))
               }}
               placeholder="0"
               className="w-full text-center text-3xl font-bold outline-none border-b-2 py-2 bg-transparent"
               style={{ borderColor: GREEN, color: 'var(--tg-theme-text-color)' }} />
        <p className="text-center text-sm mt-2 mb-4 whitespace-nowrap"
           style={{ color: 'var(--tg-theme-hint-color)' }}>
          {formatMoney(amount)}
        </p>

        {balance > 0 && (
          <div className="flex flex-wrap gap-2 justify-center mb-4">
            <button onClick={() => { setAmount(Math.min(MAX_MONEY, balance)); haptic('light') }}
                    className="px-4 py-2 rounded-full text-sm font-semibold active:scale-95 transition-all"
                    style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              Hammasi
            </button>
            <button onClick={() => { setAmount(Math.floor(balance / 2)); haptic('light') }}
                    className="px-4 py-2 rounded-full text-sm font-semibold active:scale-95 transition-all"
                    style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              Yarmi
            </button>
          </div>
        )}

        <input value={note} onChange={e => setNote(e.target.value)}
               placeholder="Izoh (ixtiyoriy)"
               className="w-full text-sm outline-none rounded-2xl px-4 py-3 mb-4"
               style={{ background: 'var(--tg-theme-secondary-bg-color)',
                        color: 'var(--tg-theme-text-color)' }} />

        {err && <div className="mb-4"><ErrorNote message={err} /></div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={pay.isPending || amount < 1}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm text-white disabled:opacity-40 active:scale-95 transition-all"
                  style={{ background: GREEN }}>
            {pay.isPending ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Narxlar tab ──────────────────────────────────────────────────────────────

function PriceSheet({ clientId, price, onClose }: {
  clientId: number
  price: ClientPrice
  onClose: () => void
}) {
  const save   = useSetClientPrice(clientId)
  const remove = useRemoveClientPrice(clientId)
  const [value, setValue] = useState(price.unit_price ?? 0)
  const [err, setErr] = useState<string | null>(null)
  const busy = save.isPending || remove.isPending

  const submit = () => {
    if (value < 1 || busy) return
    haptic('medium')
    setErr(null)
    save.mutate({ categoryId: price.category_id, unit_price: value }, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  const reset = () => {
    if (busy) return
    haptic('medium')
    setErr(null)
    remove.mutate(price.category_id, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
         style={{ background: 'rgba(0,0,0,.45)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl p-5 shadow-2xl"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>
        {price.path && (
          <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
            📍 {price.path}
          </p>
        )}
        <p className="font-bold text-base mb-4 truncate">{price.name}</p>

        <input type="text" inputMode="numeric" autoFocus
               value={value === 0 ? '' : groupDigits(value)}
               onChange={e => {
                 const digits = e.target.value.replace(/[^0-9]/g, '')
                 setValue(digits === '' ? 0 : Math.min(MAX_MONEY, Number(digits)))
               }}
               placeholder="0"
               className="w-full text-center text-3xl font-bold outline-none border-b-2 py-2 bg-transparent"
               style={{ borderColor: ACCENT, color: 'var(--tg-theme-text-color)' }} />
        <p className="text-center text-sm mt-2 mb-4 whitespace-nowrap"
           style={{ color: 'var(--tg-theme-hint-color)' }}>
          {formatMoney(value)} / dona
        </p>

        {err && <div className="mb-4"><ErrorNote message={err} /></div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={busy || value < 1}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm disabled:opacity-40 active:scale-95 transition-all"
                  style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
            {save.isPending ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>

        {price.is_override && (
          <button onClick={reset} disabled={busy}
                  className="w-full mt-3 py-2.5 rounded-2xl font-semibold text-sm disabled:opacity-40"
                  style={{ color: RED }}>
            {remove.isPending ? '...' : 'Standart narxga qaytarish'}
          </button>
        )}
      </div>
    </div>
  )
}

function PricesTab({ clientId }: { clientId: number }) {
  const prices = useClientPrices(clientId)
  const [editing, setEditing] = useState<ClientPrice | null>(null)

  if (prices.isLoading) return <CardSkeleton rows={5} />
  if (prices.isError) {
    return <ErrorState error={prices.error} onRetry={() => { void prices.refetch() }}
                       isRetrying={prices.isFetching} />
  }
  const rows = prices.data ?? []
  if (rows.length === 0) {
    return <EmptyState icon="🏷" title="Mahsulot yo'q"
                       hint={'"Mahsulotlar" bo\'limidan mahsulot qo\'shing'} />
  }

  return (
    <>
      <div className="mx-3 rounded-2xl overflow-hidden"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        {rows.map((p, i) => (
          <div key={p.category_id}>
            {i > 0 && <div className="mx-4 h-px" style={{ background: 'rgba(128,128,128,.08)' }} />}
            <button onClick={() => { haptic('light'); setEditing(p) }}
                    className="w-full flex items-center justify-between px-4 py-3 text-left active:opacity-60 transition-opacity">
              <div className="min-w-0">
                {p.path && (
                  <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
                    {p.path}
                  </p>
                )}
                <p className="font-semibold text-sm truncate">{p.name}</p>
              </div>
              <div className="ml-3 shrink-0 text-right">
                <p className="font-bold text-sm whitespace-nowrap"
                   style={{ color: p.unit_price == null ? RED : 'var(--tg-theme-text-color)' }}>
                  {p.unit_price == null ? "Narx yo'q" : formatMoney(p.unit_price)}
                </p>
                <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  {p.is_override ? 'shaxsiy narx' : 'standart'}
                </p>
              </div>
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <PriceSheet clientId={clientId} price={editing} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

// ─── Hisobot (statement) tab ──────────────────────────────────────────────────

function StatementLines({ title, entries, tone }: {
  title: string
  entries: LedgerEntry[]
  tone: string
}) {
  if (entries.length === 0) return null
  return (
    <div className="rounded-2xl overflow-hidden"
         style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
      <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide"
           style={{ color: 'var(--tg-theme-hint-color)', borderBottom: '1px solid rgba(128,128,128,.1)' }}>
        {title}
      </div>
      {entries.map((e, i) => {
        const { dateLabel } = formatTashkent(e.created_at)
        return (
          <div key={e.id}>
            {i > 0 && <div className="mx-4 h-px" style={{ background: 'rgba(128,128,128,.08)' }} />}
            <div className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {e.category_name ?? KIND_META[e.kind].label}
                </p>
                <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  {e.qty !== null && e.unit_price !== null
                    ? `${e.qty} dona × ${formatMoney(e.unit_price)} • ${dateLabel}`
                    : dateLabel}
                </p>
              </div>
              <span className="font-bold text-sm shrink-0 whitespace-nowrap" style={{ color: tone }}>
                {formatMoney(Math.abs(e.amount))}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatementBody({ statement }: { statement: Statement }) {
  const { opening, closing, totals } = statement
  return (
    <div className="space-y-3">
      <div className="rounded-2xl p-4 space-y-2.5"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--tg-theme-hint-color)' }}>Oy boshidagi qarz</span>
          <span className="font-semibold whitespace-nowrap">{formatMoney(opening)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--tg-theme-hint-color)' }}>📦 Berilgan</span>
          <span className="font-semibold whitespace-nowrap" style={{ color: RED }}>
            +{formatMoney(totals.given)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--tg-theme-hint-color)' }}>↩️ Qaytarilgan</span>
          <span className="font-semibold whitespace-nowrap" style={{ color: GREEN }}>
            −{formatMoney(totals.returned)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--tg-theme-hint-color)' }}>💵 To'langan</span>
          <span className="font-semibold whitespace-nowrap" style={{ color: GREEN }}>
            −{formatMoney(totals.paid)}
          </span>
        </div>
        <div className="pt-2.5 flex items-center justify-between"
             style={{ borderTop: '1px solid rgba(128,128,128,.15)' }}>
          <span className="font-semibold text-sm">Oy oxiridagi qarz</span>
          <span className="font-bold text-lg whitespace-nowrap"
                style={{ color: closing > 0 ? RED : GREEN }}>
            {formatMoney(closing)}
          </span>
        </div>
      </div>

      <StatementLines title="Berilgan" entries={statement.handovers} tone={RED} />
      <StatementLines title="Qaytarilgan" entries={statement.returns} tone={GREEN} />
      <StatementLines title="To'lovlar" entries={statement.payments} tone={GREEN} />
    </div>
  )
}

function StatementTab({ clientId, hasGroup }: { clientId: number; hasGroup: boolean }) {
  const now = toTashkent(new Date())
  const [year, setYear]   = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth() + 1)

  const statement = useStatement(clientId, year, month)
  const send = useSendStatement(clientId)
  const [msg, setMsg] = useState<string | null>(null)

  const shift = (delta: number) => {
    haptic('light')
    setMsg(null)
    const m = month + delta
    if (m < 1) { setMonth(12); setYear(y => y - 1) }
    else if (m > 12) { setMonth(1); setYear(y => y + 1) }
    else setMonth(m)
  }

  const doSend = () => {
    if (send.isPending) return
    haptic('medium')
    setMsg(null)
    send.mutate({ year, month }, {
      onSuccess: () => { haptic('success'); setMsg('✅ Hisobot guruhga yuborildi') },
      onError: (e) => { haptic('error'); setMsg(`❌ ${errText(e)}`) },
    })
  }

  const isEmpty = statement.data
    && statement.data.handovers.length === 0
    && statement.data.returns.length === 0
    && statement.data.payments.length === 0

  return (
    <div className="mx-3 space-y-3">
      {/* Month picker */}
      <div className="flex items-center justify-between rounded-2xl px-2 py-2"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <button onClick={() => shift(-1)}
                className="w-10 h-10 rounded-xl text-xl font-bold active:scale-90 transition-transform"
                style={{ background: 'var(--tg-theme-bg-color)' }}>‹</button>
        <span className="font-bold text-sm">{MONTHS[month - 1]} {year}</span>
        <button onClick={() => shift(1)}
                className="w-10 h-10 rounded-xl text-xl font-bold active:scale-90 transition-transform"
                style={{ background: 'var(--tg-theme-bg-color)' }}>›</button>
      </div>

      {statement.isLoading && (
        <div className="rounded-2xl p-4 space-y-2 animate-pulse"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12 rounded-xl" style={{ background: 'var(--tg-theme-bg-color)' }} />
          ))}
        </div>
      )}

      {statement.isError && (
        <ErrorState error={statement.error} onRetry={() => { void statement.refetch() }}
                    isRetrying={statement.isFetching} />
      )}

      {statement.data && (
        <>
          {isEmpty && (
            <EmptyState icon="📄" title="Bu oyda harakat yo'q"
                        hint="Boshqa oyni tanlang" />
          )}
          <StatementBody statement={statement.data} />

          <button onClick={doSend} disabled={send.isPending || !hasGroup}
                  className="w-full py-3.5 rounded-2xl font-bold text-sm active:scale-95 transition-all disabled:opacity-40"
                  style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
            {send.isPending ? 'Yuborilmoqda...' : '📤 Telegramga yuborish'}
          </button>
          {!hasGroup && (
            <p className="text-xs text-center" style={{ color: 'var(--tg-theme-hint-color)' }}>
              Guruh ulanmagan — mijoz guruhida /ulash buyrug'ini bering
            </p>
          )}
          {msg && (
            <p className="text-xs text-center break-words" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {msg}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'ledger' | 'prices' | 'statement'

const TABS: { id: Tab; label: string }[] = [
  { id: 'ledger',    label: 'Hisob'   },
  { id: 'prices',    label: 'Narxlar' },
  { id: 'statement', label: 'Hisobot' },
]

type Sheet = null | 'handover' | 'return' | 'payment'

export interface ClientDetailPageProps {
  clientId: number
  onBack: () => void
  /**
   * A row to open the edit sheet on, when the caller already knows one.
   * OPTIONAL: today the deep link is read from the query string by this page
   * itself (see readEditParam), so ClientsPage needs no change; the prop is the
   * seam for App.tsx to thread the parameter down once it routes on it.
   */
  openEdit?: OpenEdit | null
}

/**
 * The Mini App's deep-link payload: `?edit=<clientId>.<entryId>&f=q|s`.
 *
 * THE QUERY STRING, NOT THE HASH. Telegram owns the hash and appends
 * `#tgWebAppData=…` to it; a payload parked there would be fighting the client
 * for the same space.
 */
export interface OpenEdit {
  entryId: number
  field: EditField
}

function readEditParam(clientId: number): OpenEdit | null {
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('edit')
    if (!raw) return null
    const m = /^(\d+)\.(\d+)$/.exec(raw)
    if (!m) return null
    // The link names a client. Opening it on a DIFFERENT client's page would
    // point the sheet at a row this page never loaded.
    if (Number(m[1]) !== clientId) return null
    const entryId = Number(m[2])
    if (!Number.isInteger(entryId) || entryId < 1) return null
    return { entryId, field: params.get('f') === 'q' ? 'qty' : 'sum' }
  } catch {
    return null
  }
}


// ─── Group link ───────────────────────────────────────────────────────────────
// The bot mints a code with /ulash in the client's group; this is where it is
// redeemed. Without this the receipts feature is unreachable -- the app could
// only ever tell you a group was missing.

function GroupLinkCard({ clientId, chatId }: { clientId: number; chatId: number | null }) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const link = useLinkGroup(clientId)
  const unlink = useUnlinkGroup(clientId)

  const submit = () => {
    const c = code.trim()
    if (!c) return
    haptic('medium')
    setMsg(null)
    link.mutate({ code: c }, {
      onSuccess: (r) => {
        haptic('success')
        setCode('')
        setMsg(`✅ Guruh ulandi${r.title ? `: ${r.title}` : ''}`)
      },
      onError: (e) => { haptic('error'); setMsg(`❌ ${errText(e)}`) },
    })
  }

  if (chatId !== null) {
    return (
      <div className="mx-3 mb-3 p-3 rounded-2xl"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Guruh ulangan — har bir amal avtomatik yuboriladi
          </p>
          <button onClick={() => { haptic('medium'); unlink.mutate() }}
                  disabled={unlink.isPending}
                  className="text-xs px-2 py-1 rounded-lg shrink-0 disabled:opacity-40"
                  style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>
            {unlink.isPending ? '...' : 'Uzish'}
          </button>
        </div>
        {unlink.isError && (
          <p className="text-xs mt-2" style={{ color: '#ef4444' }}>{errText(unlink.error)}</p>
        )}
      </div>
    )
  }

  return (
    <div className="mx-3 mb-3 p-3 rounded-2xl space-y-2"
         style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
      <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
        Mijoz guruhida <b>/ulash</b> yuboring, so'ng koddni shu yerga kiriting:
      </p>
      <div className="flex gap-2">
        <input value={code}
               onChange={e => setCode(
                 // Codes get pasted with the stray spaces and dashes people add
                 // when reading them aloud off another phone.
                 e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6)
               )}
               onKeyDown={e => { if (e.key === 'Enter') submit() }}
               placeholder="ABC123"
               autoCapitalize="characters"
               autoCorrect="off"
               spellCheck={false}
               className="flex-1 min-w-0 px-3 py-2.5 rounded-xl text-sm tracking-widest text-center outline-none"
               style={{ background: 'var(--tg-theme-bg-color)', color: 'var(--tg-theme-text-color)' }} />
        <button onClick={submit} disabled={link.isPending || code.trim().length < 6}
                className="px-4 py-2.5 rounded-xl text-sm font-bold shrink-0 active:scale-95 transition-all disabled:opacity-40"
                style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
          {link.isPending ? '...' : 'Ulash'}
        </button>
      </div>
      {msg && <p className="text-xs break-words" style={{ color: 'var(--tg-theme-hint-color)' }}>{msg}</p>}
    </div>
  )
}

export default function ClientDetailPage({ clientId, onBack, openEdit: openEditProp = null }: ClientDetailPageProps) {
  const client = useClient(clientId)
  const [tab, setTab] = useState<Tab>('ledger')
  const [sheet, setSheet] = useState<Sheet>(null)
  const [openEdit, setOpenEdit] = useState<OpenEdit | null>(openEditProp)

  // ONE SHOT. The query string outlives every render, so without this ref a
  // re-render would reopen a sheet the operator has just closed.
  const linkUsed = useRef(false)
  useEffect(() => {
    if (linkUsed.current) return
    const parsed = readEditParam(clientId)
    if (!parsed) return
    linkUsed.current = true
    setOpenEdit(parsed)
    setTab('ledger')
  }, [clientId])

  useEffect(() => { if (openEditProp) setOpenEdit(openEditProp) }, [openEditProp])

  const consumeEdit = useCallback(() => { setOpenEdit(null) }, [])

  const back = useCallback(() => { haptic('light'); onBack() }, [onBack])
  useBackButton(back)

  const balance = client.data?.balance ?? 0
  const name    = client.data?.name ?? ''

  const openSheet = (s: Exclude<Sheet, null>) => { haptic('light'); setSheet(s) }

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
      {/* Header */}
      <div className="px-3 pt-4 pb-3 flex items-center gap-2">
        <button onClick={back}
                className="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center text-lg active:scale-90 transition-transform"
                style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>‹</button>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-base truncate">{name || 'Mijoz'}</p>
          {client.data?.phone && (
            <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
              📞 {client.data.phone}
            </p>
          )}
        </div>
        {client.data && (
          <span className="text-xs px-2 py-1 rounded-lg shrink-0"
                style={client.data.telegram_chat_id !== null
                  ? { background: 'rgba(34,197,94,.12)', color: GREEN }
                  : { background: 'rgba(128,128,128,.15)', color: 'var(--tg-theme-hint-color)' }}>
            {client.data.telegram_chat_id !== null ? 'Guruh ulangan' : 'Guruh yo\'q'}
          </span>
        )}
      </div>

      {client.data && (
        <GroupLinkCard clientId={clientId} chatId={client.data.telegram_chat_id} />
      )}

      {/* Balance */}
      {client.isLoading && (
        <div className="mx-3 h-28 rounded-2xl animate-pulse"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }} />
      )}

      {client.isError && (
        <ErrorState error={client.error} onRetry={() => { void client.refetch() }}
                    isRetrying={client.isFetching} />
      )}

      {client.data && (
        <>
          <div className="mx-3 rounded-2xl p-5 text-center"
               style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
            <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {balance > 0 ? 'Qarz' : balance < 0 ? 'Oldindan to\'lov' : 'Qarz yo\'q'}
            </p>
            <p className="text-3xl font-bold mt-1 whitespace-nowrap"
               style={{ color: balance > 0 ? RED : GREEN }}>
              {formatMoney(Math.abs(balance))}
            </p>
          </div>

          {/* Actions */}
          <div className="mx-3 mt-3 flex gap-2">
            <button onClick={() => openSheet('handover')}
                    className="flex-1 py-3.5 rounded-2xl font-bold text-sm text-white active:scale-95 transition-all"
                    style={{ background: RED }}>
              📦 Berish
            </button>
            <button onClick={() => openSheet('return')}
                    className="flex-1 py-3.5 rounded-2xl font-bold text-sm text-white active:scale-95 transition-all"
                    style={{ background: '#f59e0b' }}>
              ↩️ Qaytarish
            </button>
            <button onClick={() => openSheet('payment')}
                    className="flex-1 py-3.5 rounded-2xl font-bold text-sm text-white active:scale-95 transition-all"
                    style={{ background: GREEN }}>
              💵 To'lov
            </button>
          </div>

          {/* Tabs */}
          <div className="px-3 pt-3 pb-3">
            <div className="flex gap-1.5 p-1 rounded-2xl"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => { haptic('light'); setTab(t.id) }}
                        className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
                        style={tab === t.id
                          ? { background: ACCENT, color: 'var(--tg-theme-button-text-color)' }
                          : { color: 'var(--tg-theme-hint-color)' }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {tab === 'ledger'    && (
            <LedgerTab clientId={clientId} balance={balance}
                       openEdit={openEdit} onEditConsumed={consumeEdit} />
          )}
          {tab === 'prices'    && <PricesTab clientId={clientId} />}
          {tab === 'statement' && (
            <StatementTab clientId={clientId} hasGroup={client.data.telegram_chat_id !== null} />
          )}

          {(sheet === 'handover' || sheet === 'return') && (
            <GoodsSheet clientId={clientId} clientName={name} kind={sheet}
                        onClose={() => setSheet(null)} />
          )}
          {sheet === 'payment' && (
            <PaymentSheet clientId={clientId} clientName={name} balance={balance}
                          onClose={() => setSheet(null)} />
          )}
        </>
      )}
    </div>
  )
}

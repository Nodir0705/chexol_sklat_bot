import { useState, useMemo, useCallback } from 'react'
import { useTree } from '../hooks/useWarehouse'
import { haptic, useBackButton } from '../hooks/useTelegram'
import {
  useClient, useLedger, useClientPrices, useStatement,
  useHandover, useReturnGoods, usePayment, useReverseEntry,
  useSetClientPrice, useRemoveClientPrice, useSendStatement,
} from '../hooks/useClients'
import { formatMoney, formatSignedMoney, groupDigits } from '../api/clients'
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

function LedgerRow({ entry, onReverse }: {
  entry: LedgerEntry
  onReverse: (entry: LedgerEntry) => void
}) {
  const { dateLabel, time } = formatTashkent(entry.created_at)
  const isReversed = entry.reversed_by !== null
  const isReversal = entry.reverses_id !== null
  const meta = KIND_META[entry.kind]
  // A reversal can never itself be reversed, and a cancelled row cannot be
  // cancelled twice — the server refuses both.
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
          <button onClick={() => { haptic('light'); onReverse(entry) }}
                  className="text-xs px-2 py-1 rounded-lg active:scale-90 transition-transform no-underline"
                  style={{ background: 'rgba(239,68,68,.1)', color: RED }}>
            ↩ Bekor
          </button>
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

// ─── Ledger tab ───────────────────────────────────────────────────────────────

function LedgerTab({ clientId }: { clientId: number }) {
  const ledger = useLedger(clientId, 200)
  const [reversing, setReversing] = useState<LedgerEntry | null>(null)

  const groups = useMemo(() => groupByDay(ledger.data ?? []), [ledger.data])

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
                <LedgerRow entry={entry} onReverse={setReversing} />
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
    </>
  )
}

// ─── Product picker (the ActionPage tree, priced per client) ───────────────────

function PickerRow({ node, price, onPick }: {
  node: TreeNode
  price: ClientPrice | undefined
  onPick: (id: number) => void
}) {
  const unitPrice = price?.unit_price ?? null
  return (
    <button onClick={() => { haptic('light'); onPick(node.id) }}
            className="w-full flex items-center justify-between py-3 pl-4 pr-3 active:opacity-60 transition-opacity text-left">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ACCENT, opacity: .5 }} />
        <span className="text-sm truncate">{node.name}</span>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        <span className="text-sm px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap"
              style={unitPrice !== null
                ? { background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-text-color)' }
                : { background: 'rgba(239,68,68,.1)', color: RED }}>
          {unitPrice !== null ? formatMoney(unitPrice) : 'Narx yo\'q'}
        </span>
        <span style={{ color: 'var(--tg-theme-hint-color)' }}>›</span>
      </div>
    </button>
  )
}

function PickerGroup({ models, priceById, onPick }: {
  models: TreeNode[]
  priceById: Map<number, ClientPrice>
  onPick: (id: number) => void
}) {
  return (
    <div className="ml-4 mb-2 rounded-xl overflow-hidden"
         style={{ borderLeft: `2px solid ${ACCENT}`, background: 'rgba(128,128,128,.04)' }}>
      {models.map((m, i) => (
        <div key={m.id}>
          {i > 0 && <div className="h-px ml-4" style={{ background: 'rgba(128,128,128,.12)' }} />}
          <PickerRow node={m} price={priceById.get(m.id)} onPick={onPick} />
        </div>
      ))}
    </div>
  )
}

function PickerCard({ root, priceById, onPick }: {
  root: TreeNode
  priceById: Map<number, ClientPrice>
  onPick: (id: number) => void
}) {
  const directLeaves = root.children.filter(c => c.children.length === 0)
  const subTurs      = root.children.filter(c => c.children.length > 0)

  return (
    <div className="mx-3 mb-3 rounded-2xl overflow-hidden shadow-sm"
         style={{ border: '1px solid rgba(128,128,128,.12)' }}>
      <div className="px-4 py-3 flex items-center justify-between"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <div className="flex items-center gap-2 font-bold text-sm tracking-wide min-w-0">
          <span>📁</span><span className="truncate">{root.name.toUpperCase()}</span>
        </div>
      </div>

      <div className="py-1" style={{ background: 'var(--tg-theme-bg-color)' }}>
        {root.children.length === 0 && (
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Bo'sh — "Mahsulotlar" bo'limidan model qo'shing
          </p>
        )}

        {directLeaves.length > 0 && (
          <div className="py-1"><PickerGroup models={directLeaves} priceById={priceById} onPick={onPick} /></div>
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
            <PickerGroup models={sub.children} priceById={priceById} onPick={onPick} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Berish / Qaytarish sheet ─────────────────────────────────────────────────

function GoodsSheet({ clientId, clientName, kind, onClose }: {
  clientId: number
  clientName: string
  kind: 'handover' | 'return'
  onClose: () => void
}) {
  const isHandover = kind === 'handover'
  const tone = isHandover ? RED : GREEN
  const title = isHandover ? 'Berish' : 'Qaytarish'

  const tree   = useTree()
  const prices = useClientPrices(clientId)
  const handover = useHandover(clientId)
  const returns  = useReturnGoods(clientId)
  const mut = isHandover ? handover : returns

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const priceById = useMemo(() => {
    const map = new Map<number, ClientPrice>()
    for (const p of prices.data ?? []) map.set(p.category_id, p)
    return map
  }, [prices.data])

  const picked    = selectedId === null ? undefined : priceById.get(selectedId)
  const pickedLeaf = selectedId === null
    ? undefined
    : tree.data?.leaves.find(l => l.id === selectedId)
  const pickedName = picked?.name ?? pickedLeaf?.name ?? ''
  const unitPrice  = picked?.unit_price ?? null
  const total      = unitPrice === null ? null : unitPrice * qty

  const retry = () => {
    if (tree.isError) void tree.refetch()
    if (prices.isError) void prices.refetch()
  }

  const submit = () => {
    if (selectedId === null || qty < 1 || unitPrice === null || mut.isPending) return
    haptic('medium')
    setErr(null)
    const trimmed = note.trim()
    mut.mutate(
      { category_id: selectedId, qty, note: trimmed === '' ? undefined : trimmed },
      {
        onSuccess: () => { haptic('success'); onClose() },
        onError: (e) => { haptic('error'); setErr(errText(e)) },
      },
    )
  }

  const roots = tree.data?.tree ?? []
  const busy  = tree.isLoading || prices.isLoading
  const failed = tree.isError || prices.isError

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto"
         style={{ background: 'var(--tg-theme-bg-color)' }}>
      {/* Sheet header */}
      <div className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
           style={{ background: 'var(--tg-theme-secondary-bg-color)',
                    borderBottom: '1px solid rgba(128,128,128,.12)' }}>
        <div className="min-w-0">
          <p className="font-bold text-base" style={{ color: tone }}>
            {isHandover ? '📦 Berish' : '↩️ Qaytarish'}
          </p>
          <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
            {clientName}
          </p>
        </div>
        <button onClick={onClose} className="text-2xl ml-3 shrink-0"
                style={{ color: 'var(--tg-theme-hint-color)' }}>✕</button>
      </div>

      {/* BottomNav shares this z-index and sits later in the DOM, so leave room
          for it rather than letting it cover the confirm button. */}
      <div className="pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 110px)' }}>
        {/* ── Step 1: pick a product ── */}
        {selectedId === null && (
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
              <PickerCard key={root.id} root={root} priceById={priceById}
                          onPick={(id) => { setSelectedId(id); setQty(1) }} />
            ))}
          </>
        )}

        {/* ── Step 2: quantity + total ── */}
        {selectedId !== null && (
          <div className="mx-3 space-y-3">
            <div className="rounded-2xl px-4 py-3 flex items-center justify-between"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <div className="min-w-0">
                {picked?.path && (
                  <p className="text-xs truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
                    📍 {picked.path}
                  </p>
                )}
                <p className="font-semibold truncate">{pickedName}</p>
                <p className="text-sm mt-0.5 whitespace-nowrap"
                   style={{ color: unitPrice === null ? RED : 'var(--tg-theme-hint-color)' }}>
                  {unitPrice === null
                    ? 'Narx belgilanmagan'
                    : `Narx: ${formatMoney(unitPrice)}${picked?.is_override ? ' (shaxsiy)' : ''}`}
                </p>
              </div>
              <button onClick={() => setSelectedId(null)}
                      className="text-2xl ml-3 shrink-0"
                      style={{ color: 'var(--tg-theme-hint-color)' }}>✕</button>
            </div>

            {/* Quantity stepper — same input rules as the warehouse page */}
            <div className="rounded-2xl p-4 space-y-4"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <div className="flex items-center justify-center gap-5">
                <button onClick={() => setQty(q => Math.max(1, q - 1))}
                        className="w-14 h-14 rounded-full text-3xl font-bold active:scale-90 transition-transform"
                        style={{ background: 'var(--tg-theme-bg-color)' }}>−</button>
                <input type="text" inputMode="numeric"
                       value={qty === 0 ? '' : String(qty)}
                       onChange={e => {
                         const digits = e.target.value.replace(/[^0-9]/g, '')
                         setQty(digits === '' ? 0 : Math.min(MAX_QTY, Number(digits)))
                       }}
                       onBlur={() => { if (qty === 0) setQty(1) }}
                       className="w-24 text-center text-3xl font-bold bg-transparent border-b-2 outline-none"
                       style={{ borderColor: tone }} />
                <button onClick={() => setQty(q => Math.min(MAX_QTY, q + 1))}
                        className="w-14 h-14 rounded-full text-3xl font-bold active:scale-90 transition-transform"
                        style={{ background: 'var(--tg-theme-bg-color)' }}>+</button>
              </div>

              <div className="flex flex-wrap gap-2 justify-center">
                {[1, 2, 5, 10, 20, 50].map(n => (
                  <button key={n} onClick={() => { setQty(n); haptic('light') }}
                          className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95"
                          style={qty === n
                            ? { background: tone, color: '#fff' }
                            : { background: 'var(--tg-theme-bg-color)', color: 'var(--tg-theme-text-color)' }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Optional note */}
            <input value={note} onChange={e => setNote(e.target.value)}
                   placeholder="Izoh (ixtiyoriy)"
                   className="w-full text-sm outline-none rounded-2xl px-4 py-3"
                   style={{ background: 'var(--tg-theme-secondary-bg-color)',
                            color: 'var(--tg-theme-text-color)' }} />

            {/* Live total */}
            <div className="rounded-2xl px-4 py-3.5 flex items-center justify-between"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <span className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
                Jami {isHandover ? 'qarzga' : 'qarzdan'}
              </span>
              <span className="font-bold text-lg whitespace-nowrap" style={{ color: tone }}>
                {total === null ? '—' : `${isHandover ? '+' : '−'}${formatMoney(total)}`}
              </span>
            </div>

            {err && <ErrorNote message={err} />}

            <button onClick={submit}
                    disabled={mut.isPending || qty < 1 || unitPrice === null}
                    className="w-full py-4 rounded-2xl font-bold text-white text-base active:scale-95 transition-all disabled:opacity-50"
                    style={{ background: tone }}>
              {mut.isPending ? '...' : `✅ ${title} (${qty} dona)`}
            </button>

            {unitPrice === null && (
              <p className="text-xs text-center" style={{ color: RED }}>
                Avval "Narxlar" bo'limidan narx belgilang
              </p>
            )}
          </div>
        )}
      </div>
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
}

export default function ClientDetailPage({ clientId, onBack }: ClientDetailPageProps) {
  const client = useClient(clientId)
  const [tab, setTab] = useState<Tab>('ledger')
  const [sheet, setSheet] = useState<Sheet>(null)

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

          {tab === 'ledger'    && <LedgerTab clientId={clientId} />}
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

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { haptic } from '../hooks/useTelegram'
import { useClients, useAddClient } from '../hooks/useClients'
import { formatMoney } from '../api/clients'
import type { Client } from '../api/clients'
import ClientDetailPage, {
  ErrorState, CardSkeleton, EmptyState, ErrorNote, errText,
} from './ClientDetailPage'

const ACCENT = 'var(--tg-theme-button-color)'
const RED    = '#ef4444'
const GREEN  = '#22c55e'

// ─── Add client sheet ─────────────────────────────────────────────────────────

function AddClientSheet({ onClose }: { onClose: () => void }) {
  const add = useAddClient()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80) }, [])

  const submit = () => {
    const n = name.trim()
    const p = phone.trim()
    if (!n || add.isPending) return
    haptic('medium')
    setErr(null)
    add.mutate({ name: n, phone: p === '' ? null : p }, {
      onSuccess: () => { haptic('success'); onClose() },
      onError: (e) => { haptic('error'); setErr(errText(e)) },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
         style={{ background: 'rgba(0,0,0,.45)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl px-5 pt-5 pb-5 shadow-2xl"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>
        <p className="font-bold text-base mb-4">Yangi mijoz</p>

        <input ref={inputRef} autoFocus value={name} onChange={e => setName(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Ismi"
               className="w-full text-base outline-none border-b-2 py-2 mb-4 bg-transparent"
               style={{ borderColor: ACCENT, color: 'var(--tg-theme-text-color)' }} />

        <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" inputMode="tel"
               onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Telefon (ixtiyoriy)"
               className="w-full text-base outline-none border-b-2 py-2 mb-5 bg-transparent"
               style={{ borderColor: 'rgba(128,128,128,.3)', color: 'var(--tg-theme-text-color)' }} />

        {err && <div className="mb-4"><ErrorNote message={err} /></div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={add.isPending || !name.trim()}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm disabled:opacity-40 active:scale-95 transition-all"
                  style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
            {add.isPending ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Client row ───────────────────────────────────────────────────────────────

function ClientRow({ client, onOpen }: { client: Client; onOpen: (id: number) => void }) {
  const owes = client.balance > 0
  const initial = client.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <button onClick={() => { haptic('light'); onOpen(client.id) }}
            className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:opacity-60 transition-opacity">
      <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold text-sm"
           style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
        {initial}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-sm truncate">{client.name}</span>
          {client.telegram_chat_id !== null && (
            <span className="text-xs shrink-0" title="Guruh ulangan">🔗</span>
          )}
        </div>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {client.phone ? `📞 ${client.phone}` : 'Telefon yo\'q'}
        </p>
      </div>

      <div className="ml-2 shrink-0 text-right">
        <p className="font-bold text-sm whitespace-nowrap" style={{ color: owes ? RED : GREEN }}>
          {formatMoney(Math.abs(client.balance))}
        </p>
        <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {owes ? 'qarz' : client.balance < 0 ? 'oldindan' : 'qarz yo\'q'}
        </p>
      </div>
    </button>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const clients = useClients()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const closeDetail = useCallback(() => setSelectedId(null), [])

  const rows = clients.data ?? []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q === ''
      ? rows
      : rows.filter(c =>
          c.name.toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q))
    return [...list].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name))
  }, [rows, query])

  const totalDebt = useMemo(
    () => rows.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0),
    [rows],
  )

  if (selectedId !== null) {
    return <ClientDetailPage clientId={selectedId} onBack={closeDetail} />
  }

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
      {/* Header */}
      <div className="px-4 pt-5 pb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
            {clients.data ? `${rows.length} ta mijoz` : 'Mijozlar'}
          </p>
          {clients.data && totalDebt > 0 && (
            <p className="text-sm font-bold whitespace-nowrap" style={{ color: RED }}>
              Jami qarz: {formatMoney(totalDebt)}
            </p>
          )}
        </div>
        <button onClick={() => { haptic('light'); setAdding(true) }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl font-semibold text-sm shrink-0 active:scale-95 transition-all"
                style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
          <span className="text-base leading-none">+</span>
          Yangi mijoz
        </button>
      </div>

      {/* Search — only useful once there is something to search */}
      {rows.length > 0 && (
        <div className="px-3 pb-3">
          <input value={query} onChange={e => setQuery(e.target.value)}
                 placeholder="🔍 Qidirish..."
                 className="w-full text-sm outline-none rounded-2xl px-4 py-3"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)',
                          color: 'var(--tg-theme-text-color)' }} />
        </div>
      )}

      {clients.isLoading && <CardSkeleton rows={4} />}

      {clients.isError && (
        <ErrorState error={clients.error} onRetry={() => { void clients.refetch() }}
                    isRetrying={clients.isFetching} />
      )}

      {clients.data && rows.length === 0 && (
        <EmptyState icon="👥" title="Mijozlar ro'yxati bo'sh"
                    hint={'Yuqoridagi "+ Yangi mijoz" tugmasini bosing'} />
      )}

      {clients.data && rows.length > 0 && filtered.length === 0 && (
        <EmptyState icon="🔍" title="Hech narsa topilmadi"
                    hint="Boshqa ism yoki raqam kiriting" />
      )}

      {filtered.length > 0 && (
        <div className="mx-3 rounded-2xl overflow-hidden"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          {filtered.map((client, i) => (
            <div key={client.id}>
              {i > 0 && <div className="mx-4 h-px" style={{ background: 'rgba(128,128,128,.08)' }} />}
              <ClientRow client={client} onOpen={setSelectedId} />
            </div>
          ))}
        </div>
      )}

      {adding && <AddClientSheet onClose={() => setAdding(false)} />}
    </div>
  )
}

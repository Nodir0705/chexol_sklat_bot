import { useState, useMemo } from 'react'
import { useHistory } from '../hooks/useWarehouse'
import { exportExcel, type ExportPeriod } from '../api'
import type { HistoryEntry } from '../types'

type Filter = 'week' | 'month' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',   label: 'Hammasi' },
  { id: 'week',  label: 'Hafta'   },
  { id: 'month', label: 'Oy'      },
]

// Tashkent = UTC+5
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000

function toTashkent(date: Date) {
  return new Date(date.getTime() + TZ_OFFSET_MS)
}

function tashkentDayStr(date: Date) {
  return toTashkent(date).toISOString().slice(0, 10)
}

function formatTashkent(utcStr: string): { dateLabel: string; time: string } {
  const utc = new Date(utcStr.replace(' ', 'T') + 'Z')
  const t   = toTashkent(utc)
  const now = toTashkent(new Date())

  const today = now.toISOString().slice(0, 10)
  const yest  = toTashkent(new Date(Date.now() - 86_400_000)).toISOString().slice(0, 10)
  const day   = t.toISOString().slice(0, 10)

  const hh = String(t.getUTCHours()).padStart(2, '0')
  const mm = String(t.getUTCMinutes()).padStart(2, '0')

  const MONTHS = ['','Yan','Fev','Mar','Apr','May','Iyun','Iyul','Avg','Sen','Okt','Noy','Dek']
  const dateLabel =
    day === today ? 'Bugun' :
    day === yest  ? 'Kecha' :
    `${t.getUTCDate()} ${MONTHS[t.getUTCMonth() + 1]}`

  return { dateLabel, time: `${hh}:${mm}` }
}

function filterEntries(entries: HistoryEntry[], filter: Filter): HistoryEntry[] {
  const now = new Date()

  if (filter === 'week') {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
    return entries.filter(e => {
      const d = new Date(e.created_at.replace(' ', 'T') + 'Z')
      return d >= weekAgo
    })
  }
  if (filter === 'month') {
    const t = toTashkent(now)
    const curYear  = t.getUTCFullYear()
    const curMonth = t.getUTCMonth()
    return entries.filter(e => {
      const d = toTashkent(new Date(e.created_at.replace(' ', 'T') + 'Z'))
      return d.getUTCFullYear() === curYear && d.getUTCMonth() === curMonth
    })
  }
  return entries // 'all'
}

// ─── Entry row ────────────────────────────────────────────────────────────────

function Entry({ entry }: { entry: HistoryEntry }) {
  const { dateLabel, time } = formatTashkent(entry.created_at)
  const isDel = entry.action_type === 'delete'
  const isIn  = entry.delta > 0

  const iconBg    = isDel ? 'rgba(239,68,68,.1)'   : isIn ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)'
  const iconColor = isDel ? '#9ca3af'               : isIn ? '#22c55e'             : '#ef4444'
  const icon      = isDel ? '🗑'                    : isIn ? '+'                   : '−'
  const valColor  = isDel ? 'var(--tg-theme-hint-color)' : isIn ? '#22c55e'       : '#ef4444'
  const valText   = isDel
    ? (Math.abs(entry.delta) > 0 ? `−${Math.abs(entry.delta)}` : '—')
    : `${isIn ? '+' : '−'}${Math.abs(entry.delta)}`

  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${isDel ? 'opacity-60' : ''}`}>
      <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
           style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="font-medium truncate text-sm">{entry.category_name}</p>
          {isDel && (
            <span className="text-xs px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'rgba(239,68,68,.1)', color: '#ef4444' }}>
              O'chirildi
            </span>
          )}
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--tg-theme-hint-color)' }}>
          {entry.performed_by_name}  •  {dateLabel}, {time}
        </p>
      </div>
      <span className="font-bold text-sm shrink-0" style={{ color: valColor }}>{valText}</span>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [askPeriod, setAskPeriod] = useState(false)
  const limit = filter === 'all' ? 500 : 200
  const { data: entries, isLoading } = useHistory(limit)

  const handleExport = async (period: ExportPeriod) => {
    setAskPeriod(false)
    setExporting(true)
    setExportMsg(null)
    try {
      const { mode } = await exportExcel(period)
      setExportMsg(mode === 'telegram'
        ? '✅ Excel fayl Telegram chatingizga yuborildi'
        : '✅ Excel fayl yuklab olindi')
    } catch {
      setExportMsg('❌ Xatolik. Qaytadan urinib ko\'ring.')
    } finally {
      setExporting(false)
      setTimeout(() => setExportMsg(null), 4000)
    }
  }

  const filtered = useMemo(
    () => filterEntries(entries ?? [], filter),
    [entries, filter]
  )

  const groups = useMemo(() => {
    const result: { label: string; items: HistoryEntry[] }[] = []
    for (const entry of filtered) {
      const { dateLabel } = formatTashkent(entry.created_at)
      const last = result[result.length - 1]
      if (last?.label === dateLabel) last.items.push(entry)
      else result.push({ label: dateLabel, items: [entry] })
    }
    return result
  }, [filtered])

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
      {/* Excel export */}
      <div className="px-3 pt-5 pb-1">
        <button onClick={() => setAskPeriod(true)} disabled={exporting}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm active:scale-95 transition-all disabled:opacity-50"
                style={{ background: '#1d7d4d', color: '#fff' }}>
          {exporting ? 'Tayyorlanmoqda...' : '⬇️ Excelga yuklash'}
        </button>
        {exportMsg && (
          <p className="text-xs text-center mt-2" style={{ color: 'var(--tg-theme-hint-color)' }}>
            {exportMsg}
          </p>
        )}
      </div>

      {/* Period picker dialog */}
      {askPeriod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6"
             style={{ background: 'rgba(0,0,0,.5)' }} onClick={() => setAskPeriod(false)}>
          <div className="w-full max-w-xs rounded-3xl p-5 shadow-2xl"
               style={{ background: 'var(--tg-theme-bg-color)' }}
               onClick={e => e.stopPropagation()}>
            <p className="font-bold text-base mb-1 text-center">Qaysi davr?</p>
            <p className="text-xs text-center mb-4" style={{ color: 'var(--tg-theme-hint-color)' }}>
              Excelga qaysi davrni yuklaymiz?
            </p>
            <div className="space-y-2">
              {([
                { id: 'all',   label: 'Hammasi', desc: "Barcha harakatlar" },
                { id: 'month', label: 'Shu oy',  desc: 'Joriy oy' },
                { id: 'week',  label: 'Shu hafta', desc: "So'nggi 7 kun" },
              ] as { id: ExportPeriod; label: string; desc: string }[]).map(opt => (
                <button key={opt.id} onClick={() => handleExport(opt.id)}
                        className="w-full flex items-center justify-between px-4 py-3 rounded-2xl active:scale-95 transition-all"
                        style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
                  <span className="font-semibold text-sm">{opt.label}</span>
                  <span className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>{opt.desc}</span>
                </button>
              ))}
            </div>
            <button onClick={() => setAskPeriod(false)}
                    className="w-full mt-3 py-2.5 rounded-2xl font-semibold text-sm"
                    style={{ color: 'var(--tg-theme-hint-color)' }}>
              Bekor
            </button>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="px-3 pt-2 pb-3">
        <div className="flex gap-1.5 p-1 rounded-2xl"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all active:scale-95"
                    style={filter === f.id
                      ? { background: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-button-text-color)' }
                      : { color: 'var(--tg-theme-hint-color)' }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="mx-3 rounded-2xl p-4 space-y-2 animate-pulse"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          {[1,2,3,4].map(i => (
            <div key={i} className="h-14 rounded-xl" style={{ background: 'var(--tg-theme-bg-color)' }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && (
        <div className="mx-3 p-10 text-center rounded-2xl"
             style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
          <p className="text-4xl mb-3">📋</p>
          <p>
            {filter === 'week'  ? 'Bu haftada hech qanday harakat yo\'q' :
             filter === 'month' ? 'Bu oyda hech qanday harakat yo\'q' :
             'Hali hech qanday harakat yo\'q'}
          </p>
        </div>
      )}

      {/* Grouped list */}
      {!isLoading && groups.length > 0 && (
        <div className="mx-3 space-y-3">
          {groups.map(group => (
            <div key={group.label} className="rounded-2xl overflow-hidden"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide"
                   style={{ color: 'var(--tg-theme-hint-color)',
                            borderBottom: '1px solid rgba(128,128,128,.1)' }}>
                {group.label} · {group.items.length} ta
              </div>
              {group.items.map((entry, i) => (
                <div key={entry.id}>
                  <Entry entry={entry} />
                  {i < group.items.length - 1 && (
                    <div className="mx-4 h-px" style={{ background: 'rgba(128,128,128,.08)' }} />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

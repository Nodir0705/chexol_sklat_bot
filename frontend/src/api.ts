import type { Category, StockMap, HistoryEntry, Direction, DeleteImpact } from './types'

const BASE = '/api'

function initDataHeader(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData
  return initData ? { 'x-init-data': initData } : {}
}

function tgUserName(): string | null {
  const u = window.Telegram?.WebApp?.initDataUnsafe?.user
  return u?.first_name ?? u?.username ?? null
}

export async function fetchTree(): Promise<{ categories: Category[]; stock: StockMap }> {
  const res = await fetch(`${BASE}/tree`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function addCategory(name: string, parent_id: number | null): Promise<Category> {
  const res = await fetch(`${BASE}/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...initDataHeader() },
    body: JSON.stringify({ name, parent_id }),
  })
  if (!res.ok) throw new Error('Failed to add')
  return res.json()
}

export async function postTransaction(
  category_id: number, qty: number, direction: Direction
): Promise<{ category_id: number; new_qty: number; delta: number }> {
  const res = await fetch(`${BASE}/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...initDataHeader() },
    body: JSON.stringify({ category_id, qty, direction, user_name: tgUserName() }),
  })
  if (!res.ok) throw new Error('Transaction failed')
  return res.json()
}

export async function checkAccess(): Promise<{ allowed: boolean; reason?: string }> {
  const res = await fetch(`${BASE}/access`, { headers: initDataHeader() })
  if (!res.ok) return { allowed: true } // fail open on server error
  return res.json()
}

export async function fetchHistory(limit = 100): Promise<HistoryEntry[]> {
  const res = await fetch(`${BASE}/history?limit=${limit}`)
  if (!res.ok) throw new Error('Failed to fetch history')
  return res.json()
}

export type ExportPeriod = 'all' | 'week' | 'month'

// In Telegram: bot sends the .xlsx to the user's chat. In browser: triggers a download.
export async function exportExcel(period: ExportPeriod): Promise<{ mode: 'telegram' | 'browser' }> {
  const initData = window.Telegram?.WebApp?.initData
  if (initData) {
    const res = await fetch(`${BASE}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
      body: JSON.stringify({ period }),
    })
    if (!res.ok) throw new Error('Export failed')
    await res.json()
    return { mode: 'telegram' }
  }
  // Browser fallback — open the direct download
  window.open(`${BASE}/export.xlsx?period=${period}`, '_blank')
  return { mode: 'browser' }
}

export async function fetchDeleteImpact(id: number): Promise<DeleteImpact> {
  const res = await fetch(`${BASE}/categories/${id}/impact`)
  if (!res.ok) throw new Error('Failed to fetch impact')
  return res.json()
}

export async function deleteCategory(id: number): Promise<{ deleted: number; logsCreated: number }> {
  const res = await fetch(`${BASE}/categories/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...initDataHeader() },
    body: JSON.stringify({ user_name: tgUserName() }),
  })
  if (!res.ok) throw new Error('Delete failed')
  return res.json()
}

import { lazy, Suspense, useState, useEffect } from 'react'
import BottomNav from './components/BottomNav'
import { checkAccess } from './api'
import type { Page } from './types'

const ActionPage   = lazy(() => import('./pages/ActionPage'))
const HistoryPage  = lazy(() => import('./pages/HistoryPage'))
const ProductsPage = lazy(() => import('./pages/ProductsPage'))
const ClientsPage  = lazy(() => import('./pages/ClientsPage'))

function PageSkeleton() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="h-14 rounded-2xl"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }} />
      ))}
    </div>
  )
}

function AccessScreen({ reason }: { reason: string }) {
  const isPending = reason === 'pending'
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center gap-4">
      <div className="text-6xl">{isPending ? '🕐' : '🚫'}</div>
      <h1 className="text-xl font-bold">
        {isPending ? 'So\'rovingiz yuborildi' : 'Kirish taqiqlangan'}
      </h1>
      <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
        {isPending
          ? 'Admin tasdiqlashini kuting. Tasdiqlangandan so\'ng botdan qayta /start bosing.'
          : 'Sizga ushbu ilovaga kirish ruxsati berilmagan.'}
      </p>
    </div>
  )
}

export default function App() {
  // The board's ✏️ Tahrirlash button deep-links here as ?edit=<clientId>.<entryId>.
  // Without this the app opened on its default tab, Mijozlar never mounted, and
  // the parameter it reads was never seen -- so the link landed the operator on
  // the wrong screen and they had to find the client by hand, losing the one
  // thing the deep link exists to buy.
  const deepLinkPage: Page | null = (() => {
    try {
      return new URLSearchParams(window.location.search).get('edit') ? 'clients' : null
    } catch { return null }
  })()
  const [page, setPage] = useState<Page>(deepLinkPage ?? 'action')
  const [access, setAccess] = useState<{ allowed: boolean; reason?: string } | null>(null)

  useEffect(() => {
    checkAccess().then(setAccess)
  }, [])

  // While checking
  if (!access) return <PageSkeleton />

  // Blocked
  if (!access.allowed) return <AccessScreen reason={access.reason ?? 'rejected'} />

  return (
    <div className="min-h-screen" style={{ background: 'var(--tg-theme-bg-color)' }}>
      <Suspense fallback={<PageSkeleton />}>
        {page === 'action'   && <ActionPage />}
        {page === 'history'  && <HistoryPage />}
        {page === 'products' && <ProductsPage />}
        {page === 'clients'  && <ClientsPage />}
      </Suspense>
      <BottomNav page={page} setPage={setPage} />
    </div>
  )
}

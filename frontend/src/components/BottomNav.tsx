import type { Page } from '../types'

interface Props { page: Page; setPage: (p: Page) => void }

const TABS: { id: Page; label: string }[] = [
  { id: 'action',   label: 'Kirish/Chiqish' },
  { id: 'history',  label: 'Hisobot'         },
  { id: 'products', label: 'Mahsulotlar'     },
]

export default function BottomNav({ page, setPage }: Props) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t"
         style={{
           background: 'var(--tg-theme-bg-color)',
           borderColor: 'rgba(128,128,128,.15)',
           // Lift the tabs above the iPhone home-indicator / swipe area
           paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
           paddingTop: '10px',
           paddingLeft: '10px',
           paddingRight: '10px',
         }}>
      <div className="flex gap-2">
        {TABS.map(tab => {
          const active = page === tab.id
          return (
            <button key={tab.id} onClick={() => setPage(tab.id)}
                    className="flex flex-1 items-center justify-center py-3 rounded-xl text-sm transition-all active:scale-95"
                    style={active
                      ? {
                          background: 'var(--tg-theme-button-color)',
                          color: 'var(--tg-theme-button-text-color)',
                          boxShadow: '0 2px 8px rgba(0,0,0,.15)',
                        }
                      : {
                          background: 'var(--tg-theme-secondary-bg-color)',
                          color: 'var(--tg-theme-hint-color)',
                        }}>
              <span className={active ? 'font-semibold' : 'font-medium'}>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

import { useState, useCallback } from 'react'
import { useTree, useTransaction } from '../hooks/useWarehouse'
import { haptic } from '../hooks/useTelegram'
import type { Direction, TreeNode } from '../types'

const QUICK = [1, 2, 5, 10, 20, 50]

const ACCENT = 'var(--tg-theme-button-color)'

// One tappable model (leaf) row.
function ModelRow({ node, onPick }: { node: TreeNode; onPick: (leaf: TreeNode) => void }) {
  return (
    <button onClick={() => { haptic('light'); onPick(node) }}
            className="w-full flex items-center justify-between py-3 pl-4 pr-3 active:opacity-60 transition-opacity text-left">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ACCENT, opacity: .5 }} />
        <span className="text-sm truncate">{node.name}</span>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        <span className="text-sm px-2.5 py-0.5 rounded-full font-semibold"
              style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-text-color)' }}>
          {node.qty ?? 0} dona
        </span>
        <span style={{ color: 'var(--tg-theme-hint-color)' }}>›</span>
      </div>
    </button>
  )
}

// A list of model rows with dividers, boxed and indented under a sub-tur.
function ModelGroup({ models, onPick }: { models: TreeNode[]; onPick: (leaf: TreeNode) => void }) {
  return (
    <div className="ml-4 mb-2 rounded-xl overflow-hidden"
         style={{ borderLeft: `2px solid ${ACCENT}`, background: 'rgba(128,128,128,.04)' }}>
      {models.map((m, i) => (
        <div key={m.id}>
          {i > 0 && <div className="h-px ml-4" style={{ background: 'rgba(128,128,128,.12)' }} />}
          <ModelRow node={m} onPick={onPick} />
        </div>
      ))}
    </div>
  )
}

// Total stock of all leaf descendants under a node.
function sumLeaves(node: TreeNode): number {
  if (node.children.length === 0) return node.qty ?? 0
  return node.children.reduce((s, c) => s + sumLeaves(c), 0)
}

// A tur rendered as a card with clearly separated sub-tur sections.
function CategoryCard({ root, onPick }: { root: TreeNode; onPick: (leaf: TreeNode) => void }) {
  const directLeaves = root.children.filter(c => c.children.length === 0)
  const subTurs      = root.children.filter(c => c.children.length > 0)

  return (
    <div className="mx-3 mb-3 rounded-2xl overflow-hidden shadow-sm"
         style={{ border: '1px solid rgba(128,128,128,.12)' }}>
      {/* Tur header */}
      <div className="px-4 py-3 flex items-center justify-between"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <div className="flex items-center gap-2 font-bold text-sm tracking-wide min-w-0">
          <span>📁</span><span className="truncate">{root.name.toUpperCase()}</span>
        </div>
        <span className="text-sm font-bold px-2.5 py-0.5 rounded-full ml-3 shrink-0"
              style={{ background: ACCENT, color: 'var(--tg-theme-button-text-color)' }}>
          {sumLeaves(root)} dona
        </span>
      </div>

      <div className="py-1" style={{ background: 'var(--tg-theme-bg-color)' }}>
        {root.children.length === 0 && (
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
            Bo'sh — "Mahsulotlar" bo'limidan model qo'shing
          </p>
        )}

        {/* Models directly under the tur (no sub-tur) */}
        {directLeaves.length > 0 && (
          <div className="py-1"><ModelGroup models={directLeaves} onPick={onPick} /></div>
        )}

        {/* Each sub-tur as its own labelled section */}
        {subTurs.map(sub => (
          <div key={sub.id} className="pt-1.5 pb-1">
            <div className="flex items-center justify-between px-4 pb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm">🗂</span>
                <span className="font-semibold text-sm truncate">{sub.name}</span>
                <span className="text-xs shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  ({sub.children.length})
                </span>
              </div>
              <span className="text-xs font-semibold ml-3 shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>
                {sumLeaves(sub)} dona
              </span>
            </div>
            <ModelGroup models={sub.children} onPick={onPick} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ActionPage() {
  const { data, isLoading } = useTree()
  const txn = useTransaction()

  const [direction, setDirection] = useState<Direction>('in')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [qty, setQty] = useState(1)
  const [result, setResult] = useState<{
    name: string; path: string; qty: number; direction: Direction; newQty: number
  } | null>(null)

  const selected = selectedId !== null
    ? data?.leaves.find(l => l.id === selectedId) ?? null
    : null

  // Build "Nakitka › Ali cantara safir" path for a leaf (parent chain, excluding the leaf itself)
  const pathOf = useCallback((leafId: number): string => {
    if (!data) return ''
    const byId = new Map(data.flat.map(c => [c.id, c]))
    const parts: string[] = []
    let cur = byId.get(leafId)
    cur = cur?.parent_id != null ? byId.get(cur.parent_id) : undefined
    while (cur) {
      parts.unshift(cur.name)
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
    }
    return parts.join(' › ')
  }, [data])

  const confirm = useCallback(() => {
    if (!selected || qty <= 0) return
    haptic('medium')
    const preQty = selected.qty ?? 0
    const newQty = direction === 'in' ? preQty + qty : Math.max(0, preQty - qty)
    const snapshot = { name: selected.name, path: pathOf(selected.id), qty, direction, newQty }
    txn.mutate({ category_id: selected.id, qty, direction }, {
      onSuccess: () => {
        haptic('success')
        setResult(snapshot)
        setSelectedId(null)
        setQty(1)
        setTimeout(() => setResult(null), 4000)
      },
    })
  }, [selected, qty, direction, txn, pathOf])

  if (result) {
    const isIn = result.direction === 'in'
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center gap-4">
        <div className="text-6xl">✅</div>
        <p className="text-xl font-bold">Saqlandi!</p>

        <div className="w-full max-w-xs rounded-2xl p-5 space-y-3"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          {result.path && (
            <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
              📍 {result.path}
            </p>
          )}
          <p className="text-lg font-semibold">{result.name}</p>

          <div className="flex items-center justify-center gap-2 text-lg font-bold"
               style={{ color: isIn ? '#22c55e' : '#ef4444' }}>
            <span>{isIn ? '➕ Kirish' : '➖ Chiqish'}</span>
            <span>{isIn ? '+' : '−'}{result.qty} dona</span>
          </div>

          <div className="pt-3 border-t" style={{ borderColor: 'rgba(128,128,128,.15)' }}>
            <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>Yangi zaxira</p>
            <p className="text-2xl font-bold">{result.newQty} dona</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
      {/* Direction toggle */}
      <div className="px-4 pt-5 pb-4">
        <div className="flex rounded-2xl p-1 gap-1"
             style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
          <button onClick={() => { setDirection('in'); setSelectedId(null); haptic('light') }}
                  className="flex-1 py-3 rounded-xl font-bold text-sm transition-all"
                  style={direction === 'in'
                    ? { background: '#22c55e', color: '#fff' }
                    : { color: 'var(--tg-theme-hint-color)' }}>
            ➕ Kirish
          </button>
          <button onClick={() => { setDirection('out'); setSelectedId(null); haptic('light') }}
                  className="flex-1 py-3 rounded-xl font-bold text-sm transition-all"
                  style={direction === 'out'
                    ? { background: '#ef4444', color: '#fff' }
                    : { color: 'var(--tg-theme-hint-color)' }}>
            ➖ Chiqish
          </button>
        </div>
      </div>

      {/* Product tree */}
      {!selected && (
        <>
          {isLoading && (
            <div className="mx-3 rounded-2xl p-4 space-y-2 animate-pulse"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              {[1,2,3,4].map(i => (
                <div key={i} className="h-14 rounded-xl" style={{ background: 'var(--tg-theme-bg-color)' }} />
              ))}
            </div>
          )}
          {!isLoading && data?.tree.length === 0 && (
            <div className="mx-3 rounded-2xl p-8 text-center"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
              <p className="text-3xl mb-2">📭</p>
              <p>"Mahsulotlar" bo'limidan mahsulot qo'shing</p>
            </div>
          )}
          {data?.tree.map(root => (
            <CategoryCard key={root.id} root={root}
                          onPick={(leaf) => { setSelectedId(leaf.id); setQty(1) }} />
          ))}
        </>
      )}

      {/* Qty input — shown when a product is selected */}
      {selected && (
        <div className="mx-3 space-y-3">
          {/* Selected product card */}
          <div className="rounded-2xl px-4 py-3 flex items-center justify-between"
               style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
            <div className="min-w-0">
              {pathOf(selected.id) && (
                <p className="text-xs" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  📍 {pathOf(selected.id)}
                </p>
              )}
              <p className="font-semibold truncate">{selected.name}</p>
              <p className="text-sm mt-0.5" style={{ color: 'var(--tg-theme-hint-color)' }}>
                Hozirda: {selected.qty ?? 0} dona
              </p>
            </div>
            <button onClick={() => setSelectedId(null)}
                    className="text-2xl ml-3 shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>✕</button>
          </div>

          {/* Stepper */}
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
                       setQty(digits === '' ? 0 : Math.min(99999, Number(digits)))
                     }}
                     onBlur={() => { if (qty === 0) setQty(1) }}
                     className="w-24 text-center text-3xl font-bold bg-transparent border-b-2 outline-none"
                     style={{ borderColor: direction === 'in' ? '#22c55e' : '#ef4444' }} />
              <button onClick={() => setQty(q => q + 1)}
                      className="w-14 h-14 rounded-full text-3xl font-bold active:scale-90 transition-transform"
                      style={{ background: 'var(--tg-theme-bg-color)' }}>+</button>
            </div>

            {/* Quick amounts */}
            <div className="flex flex-wrap gap-2 justify-center">
              {QUICK.map(n => (
                <button key={n} onClick={() => { setQty(n); haptic('light') }}
                        className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95"
                        style={qty === n
                          ? { background: direction === 'in' ? '#22c55e' : '#ef4444', color: '#fff' }
                          : { background: 'var(--tg-theme-bg-color)', color: 'var(--tg-theme-text-color)' }}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Confirm button */}
          <button onClick={confirm} disabled={txn.isPending || qty < 1}
                  className="w-full py-4 rounded-2xl font-bold text-white text-base active:scale-95 transition-all disabled:opacity-50"
                  style={{ background: direction === 'in' ? '#22c55e' : '#ef4444' }}>
            {txn.isPending ? '...' : direction === 'in' ? `✅ Kirish qil (+${qty})` : `✅ Chiqish qil (−${qty})`}
          </button>
        </div>
      )}
    </div>
  )
}

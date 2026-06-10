import { useState, useRef, useEffect } from 'react'
import { useTree, useAddCategory, useDeleteImpact, useDeleteCategory } from '../hooks/useWarehouse'
import { haptic } from '../hooks/useTelegram'
import type { TreeNode, DeleteImpact } from '../types'

// ─── Add bottom sheet ─────────────────────────────────────────────────────────

interface SheetCtx { parentId: number | null; title: string; placeholder: string }

function AddSheet({ ctx, onClose }: { ctx: SheetCtx; onClose: () => void }) {
  const add = useAddCategory()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80) }, [])

  const submit = () => {
    const n = name.trim()
    if (!n || add.isPending) return
    haptic('medium')
    add.mutate({ name: n, parent_id: ctx.parentId }, {
      onSuccess: () => { haptic('success'); onClose() },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
         style={{ background: 'rgba(0,0,0,.45)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl px-5 pt-5 pb-5 shadow-2xl"
           style={{ background: 'var(--tg-theme-bg-color)' }}
           onClick={e => e.stopPropagation()}>
        <input ref={inputRef} autoFocus value={name} onChange={e => setName(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && submit()} placeholder={ctx.placeholder}
               className="w-full text-base outline-none border-b-2 py-2 mb-5 bg-transparent"
               style={{ borderColor: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-text-color)' }} />
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                  style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
            Bekor
          </button>
          <button onClick={submit} disabled={add.isPending || !name.trim()}
                  className="flex-[2] py-3 rounded-2xl font-bold text-sm disabled:opacity-40 active:scale-95 transition-all"
                  style={{ background: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-button-text-color)' }}>
            {add.isPending ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Delete confirm — step 1 (show impact) ────────────────────────────────────

function DeleteConfirm1({ nodeId, onConfirm, onClose }: {
  nodeId: number; onConfirm: (impact: DeleteImpact) => void; onClose: () => void
}) {
  const { data: impact, isLoading } = useDeleteImpact(nodeId)

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center px-5"
           style={{ background: 'rgba(0,0,0,.5)' }} onClick={onClose}>
        <div className="w-full max-w-sm rounded-3xl shadow-2xl p-5"
             style={{ background: 'var(--tg-theme-bg-color)' }}
             onClick={e => e.stopPropagation()}>

          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0"
                 style={{ background: 'rgba(239,68,68,.1)' }}>🗑️</div>
            <div>
              <p className="font-bold">O'chirishni tasdiqlang</p>
              <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
                Bu amalni qaytarib bo'lmaydi
              </p>
            </div>
          </div>

          {isLoading && (
            <div className="rounded-2xl p-4 mb-4 animate-pulse"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)', height: 80 }} />
          )}

          {impact && (
            <div className="rounded-2xl p-4 mb-4 space-y-2"
                 style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
              <p className="font-semibold text-sm">
                "<span style={{ color: '#ef4444' }}>{impact.name}</span>" o'chiriladi
              </p>
              {impact.descCount > 1 && (
                <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
                  Ichidagi {impact.descCount - 1} ta element ham o'chiriladi
                </p>
              )}
              {impact.leaves.length > 0 && (
                <div className="mt-2 space-y-1">
                  {impact.leaves.map((leaf: { id: number; name: string; qty: number }) => (
                    <div key={leaf.id} className="flex items-center justify-between text-sm">
                      <span style={{ color: 'var(--tg-theme-hint-color)' }}>• {leaf.name}</span>
                      {leaf.qty > 0 && (
                        <span className="font-semibold" style={{ color: '#ef4444' }}>
                          {leaf.qty} dona yo'qoladi
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {impact.totalStock > 0 && (
                <div className="mt-3 pt-3 border-t flex items-center gap-2"
                     style={{ borderColor: 'rgba(239,68,68,.2)' }}>
                  <span className="text-lg">⚠️</span>
                  <p className="text-sm font-semibold" style={{ color: '#ef4444' }}>
                    Jami {impact.totalStock} dona sklatdan chiqariladi
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                    style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
              Bekor
            </button>
            <button onClick={() => impact && onConfirm(impact)} disabled={isLoading || !impact}
                    className="flex-[2] py-3 rounded-2xl font-bold text-sm text-white disabled:opacity-40 active:scale-95 transition-all"
                    style={{ background: '#ef4444' }}>
              Davom etish →
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Delete confirm — step 2 (final, irreversible) ────────────────────────────

function DeleteConfirm2({ impact, onConfirm, onClose, isPending }: {
  impact: DeleteImpact; onConfirm: () => void; onClose: () => void; isPending: boolean
}) {
  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center px-5"
           style={{ background: 'rgba(0,0,0,.6)' }} onClick={onClose}>
        <div className="w-full max-w-sm rounded-3xl shadow-2xl p-6 text-center"
             style={{ background: 'var(--tg-theme-bg-color)' }}
             onClick={e => e.stopPropagation()}>
          <p className="text-5xl mb-3">⚠️</p>
          <p className="font-bold text-base mb-2">Ishonchingiz komilmi?</p>
          <p className="text-sm mb-6" style={{ color: 'var(--tg-theme-hint-color)' }}>
            <strong style={{ color: 'var(--tg-theme-text-color)' }}>"{impact.name}"</strong>
            {impact.totalStock > 0
              ? ` va ${impact.totalStock} dona mahsulot butunlay o'chib ketadi.`
              : ` butunlay o'chib ketadi.`}
            {' '}Bu amalni hech kim qaytara olmaydi.
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl font-semibold text-sm"
                    style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
              Yo'q, bekor
            </button>
            <button onClick={onConfirm} disabled={isPending}
                    className="flex-[2] py-3 rounded-2xl font-bold text-sm text-white disabled:opacity-60 active:scale-95 transition-all"
                    style={{ background: '#b91c1c' }}>
              {isPending ? "O'chirilmoqda..." : "Ha, o'chirish"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Sub-type section ─────────────────────────────────────────────────────────

const LINE = 'rgba(128,128,128,.35)'

// Tree connector: an elbow (├─ or └─) drawn to the left of a child row.
// `isLast` controls whether the vertical line continues below the elbow.
function Connector({ isLast }: { isLast: boolean }) {
  return (
    <div className="relative shrink-0 self-stretch" style={{ width: 26 }}>
      {/* vertical: top → middle (always) */}
      <div className="absolute" style={{ left: 12, top: 0, height: '50%', borderLeft: `2px solid ${LINE}` }} />
      {/* vertical: middle → bottom (only if not the last child) */}
      {!isLast && (
        <div className="absolute" style={{ left: 12, top: '50%', bottom: 0, borderLeft: `2px solid ${LINE}` }} />
      )}
      {/* horizontal elbow at the row's vertical center */}
      <div className="absolute" style={{ left: 12, top: '50%', width: 12, borderTop: `2px solid ${LINE}` }} />
    </div>
  )
}

// depth 1 = sub-tur (container, can hold models), depth 2+ = model (leaf).
function SubTypeSection({ node, onAdd, onDelete, isLast = false, depth = 1 }: {
  node: TreeNode
  onAdd: (ctx: SheetCtx) => void
  onDelete: (id: number) => void
  isLast?: boolean
  depth?: number
}) {
  const [open, setOpen] = useState(true)
  const isModel = depth >= 2

  // ── Model (leaf) ──
  if (isModel) {
    return (
      <div className="flex items-stretch">
        <Connector isLast={isLast} />
        <div className="flex items-center justify-between flex-1 pr-2 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm shrink-0">📌</span>
            <span className="text-sm truncate">{node.name}</span>
          </div>
          <button onClick={() => { haptic('light'); onDelete(node.id) }}
                  className="ml-3 shrink-0 w-7 h-7 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                  style={{ color: '#ef4444', background: 'rgba(239,68,68,.1)' }}>
            🗑
          </button>
        </div>
      </div>
    )
  }

  // ── Sub-tur (always a container — even when empty) ──
  return (
    <div className="flex items-stretch">
      <Connector isLast={isLast} />
      <div className="flex-1 min-w-0">
        {/* Sub-tur header */}
        <div className="flex items-center justify-between pr-2 py-2.5">
          <button className="flex items-center gap-2 min-w-0 flex-1"
                  onClick={() => setOpen(o => !o)}>
            <span className="text-base shrink-0">🗂</span>
            <span className="font-medium text-sm truncate">{node.name}</span>
            <span className="text-xs ml-1 shrink-0" style={{ color: 'var(--tg-theme-hint-color)' }}>
              ({node.children.length})
            </span>
            <span className="text-xs shrink-0 ml-1"
                  style={{ color: 'var(--tg-theme-hint-color)', display: 'inline-block',
                           transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}>▾</span>
          </button>
          <button onClick={() => { haptic('light'); onDelete(node.id) }}
                  className="shrink-0 ml-2 w-7 h-7 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                  style={{ color: '#ef4444', background: 'rgba(239,68,68,.1)' }}>
            🗑
          </button>
        </div>

        {/* Models branch off below */}
        {open && (
          <div className="pb-1">
            {node.children.map((leaf) => (
              <SubTypeSection key={leaf.id} node={leaf} onAdd={onAdd} onDelete={onDelete}
                              isLast={false} depth={depth + 1} />
            ))}
            {/* "add model" — always shown, even for an empty sub-tur */}
            <div className="flex items-stretch">
              <Connector isLast={true} />
              <button onClick={() => onAdd({ parentId: node.id, title: `${node.name} ichiga`,
                                             placeholder: '' })}
                      className="flex items-center gap-1.5 flex-1 py-2 active:opacity-60 transition-opacity"
                      style={{ color: 'var(--tg-theme-button-color)' }}>
                <span className="text-sm font-bold">+</span>
                <span className="text-sm">Model qo'shish</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Root category card ────────────────────────────────────────────────────────

function CategoryCard({ node, onAdd, onDelete }: {
  node: TreeNode
  onAdd: (ctx: SheetCtx) => void
  onDelete: (id: number) => void
}) {
  const [open, setOpen] = useState(true)
  const countLeaves = (n: TreeNode): number =>
    n.children.length === 0 ? 1 : n.children.reduce((s, c) => s + countLeaves(c), 0)
  const total = countLeaves(node)

  return (
    <div className="mx-3 mb-3 rounded-2xl overflow-hidden shadow-sm"
         style={{ border: '1px solid rgba(128,128,128,.12)' }}>
      <div className="flex items-center justify-between px-4 py-3.5"
           style={{ background: 'var(--tg-theme-secondary-bg-color)' }}>
        <button className="flex items-center gap-3 flex-1 text-left"
                onClick={() => setOpen(o => !o)}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm shrink-0"
               style={{ background: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-button-text-color)' }}>
            📁
          </div>
          <div>
            <p className="font-bold text-sm tracking-wide">{node.name.toUpperCase()}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--tg-theme-hint-color)' }}>
              {total} mahsulot
            </p>
          </div>
          <span className="text-xs ml-2" style={{ color: 'var(--tg-theme-hint-color)',
                                                   transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                                                   display: 'inline-block', transition: 'transform .2s' }}>▾</span>
        </button>
        <button onClick={() => { haptic('light'); onDelete(node.id) }}
                className="ml-3 shrink-0 w-8 h-8 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                style={{ color: '#ef4444', background: 'rgba(239,68,68,.12)' }}>
          🗑
        </button>
      </div>

      {open && (
        <div className="pl-3 pr-2 py-2" style={{ background: 'var(--tg-theme-bg-color)' }}>
          {node.children.map((child) => (
            <SubTypeSection key={child.id} node={child} onAdd={onAdd} onDelete={onDelete}
                            isLast={false} depth={1} />
          ))}
          {/* "add sub-tur" as the last branch */}
          <div className="flex items-stretch">
            <Connector isLast={true} />
            <button onClick={() => onAdd({ parentId: node.id, title: `${node.name} ichiga`,
                                           placeholder: '' })}
                    className="flex items-center gap-1.5 flex-1 py-2 active:opacity-60 transition-opacity"
                    style={{ color: 'var(--tg-theme-button-color)' }}>
              <span className="font-bold">+</span>
              <span className="text-sm font-medium">Sub-tur qo'shish</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

type Step = null | { step: 1; nodeId: number } | { step: 2; nodeId: number; impact: DeleteImpact }

export default function ProductsPage() {
  const { data, isLoading } = useTree()
  const delCat = useDeleteCategory()

  const [sheet, setSheet]   = useState<SheetCtx | null>(null)
  const [delFlow, setDelFlow] = useState<Step>(null)

  const openAdd = (ctx: SheetCtx) => { haptic('light'); setSheet(ctx) }
  const openDel = (id: number)    => { haptic('light'); setDelFlow({ step: 1, nodeId: id }) }

  const handleFinalDelete = () => {
    if (!delFlow || delFlow.step !== 2) return
    haptic('heavy')
    delCat.mutate(delFlow.nodeId, {
      onSuccess: () => { haptic('success'); setDelFlow(null) },
    })
  }

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
      <div className="px-4 pt-5 pb-4 flex items-center justify-between">
        {data ? (
          <p className="text-sm" style={{ color: 'var(--tg-theme-hint-color)' }}>
            {data.tree.length} asosiy tur
          </p>
        ) : <span />}
        <button onClick={() => openAdd({ parentId: null, title: 'Yangi asosiy tur',
                                          placeholder: '' })}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl font-semibold text-sm active:scale-95 transition-all"
                style={{ background: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-button-text-color)' }}>
          <span className="text-base leading-none">+</span>
          Yangi tur
        </button>
      </div>

      {isLoading && (
        <div className="mx-3 space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="rounded-2xl overflow-hidden animate-pulse"
                 style={{ border: '1px solid rgba(128,128,128,.12)' }}>
              <div className="h-14" style={{ background: 'var(--tg-theme-secondary-bg-color)' }} />
              <div className="p-3 space-y-2">
                {[1,2,3].map(j => <div key={j} className="h-10 rounded-xl"
                                       style={{ background: 'var(--tg-theme-secondary-bg-color)' }} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && data?.tree.length === 0 && (
        <div className="mx-3 rounded-2xl p-10 text-center"
             style={{ background: 'var(--tg-theme-secondary-bg-color)', color: 'var(--tg-theme-hint-color)' }}>
          <p className="text-4xl mb-3">📦</p>
          <p className="font-medium mb-1">Mahsulotlar ro'yxati bo'sh</p>
          <p className="text-sm">Yuqoridagi "+ Yangi tur" tugmasini bosing</p>
        </div>
      )}

      {data?.tree.map(root => (
        <CategoryCard key={root.id} node={root} onAdd={openAdd} onDelete={openDel} />
      ))}

      {/* Add sheet */}
      {sheet && <AddSheet ctx={sheet} onClose={() => setSheet(null)} />}

      {/* Delete step 1 */}
      {delFlow?.step === 1 && (
        <DeleteConfirm1
          nodeId={delFlow.nodeId}
          onConfirm={(impact) => setDelFlow({ step: 2, nodeId: delFlow.nodeId, impact })}
          onClose={() => setDelFlow(null)}
        />
      )}

      {/* Delete step 2 */}
      {delFlow?.step === 2 && (
        <DeleteConfirm2
          impact={delFlow.impact}
          onConfirm={handleFinalDelete}
          onClose={() => setDelFlow(null)}
          isPending={delCat.isPending}
        />
      )}
    </div>
  )
}

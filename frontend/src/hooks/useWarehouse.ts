import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchTree, addCategory, postTransaction, fetchHistory, fetchDeleteImpact, deleteCategory } from '../api'
import type { Category, StockMap, TreeNode, Direction } from '../types'

export function buildTree(categories: Category[], stock: StockMap): TreeNode[] {
  const map = new Map<number, TreeNode>()
  for (const cat of categories) map.set(cat.id, { ...cat, children: [], qty: null })

  const roots: TreeNode[] = []
  for (const node of map.values()) {
    if (node.parent_id === null) roots.push(node)
    else map.get(node.parent_id)?.children.push(node)
  }

  const finalise = (node: TreeNode): TreeNode => {
    node.children = node.children.map(finalise).sort((a, b) => a.name.localeCompare(b.name))
    if (node.children.length === 0) node.qty = stock[node.id] ?? 0
    return node
  }
  return roots.map(finalise).sort((a, b) => a.name.localeCompare(b.name))
}

// All leaf nodes (no children) from a flat category list
export function getLeaves(categories: Category[], stock: StockMap) {
  const parentIds = new Set(categories.map(c => c.parent_id).filter(Boolean))
  return categories
    .filter(c => !parentIds.has(c.id))
    .map(c => ({ ...c, qty: stock[c.id] ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: fetchTree,
    staleTime: 30_000,
    select: (data) => ({
      flat: data.categories,
      stock: data.stock,
      tree: buildTree(data.categories, data.stock),
      leaves: getLeaves(data.categories, data.stock),
    }),
  })
}

export function useHistory(limit = 100) {
  return useQuery({
    queryKey: ['history', limit],
    queryFn: () => fetchHistory(limit),
    staleTime: 10_000,
  })
}

export function useAddCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, parent_id }: { name: string; parent_id: number | null }) =>
      addCategory(name, parent_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tree'] }),
  })
}

export function useDeleteImpact(id: number | null) {
  return useQuery({
    queryKey: ['impact', id],
    queryFn: () => fetchDeleteImpact(id!),
    enabled: id !== null,
    staleTime: 0,
  })
}

export function useDeleteCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteCategory(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tree'] })
      qc.invalidateQueries({ queryKey: ['history'] })
    },
  })
}

export function useTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ category_id, qty, direction }: { category_id: number; qty: number; direction: Direction }) =>
      postTransaction(category_id, qty, direction),
    onMutate: async ({ category_id, qty, direction }) => {
      await qc.cancelQueries({ queryKey: ['tree'] })
      const prev = qc.getQueryData(['tree'])
      qc.setQueryData(['tree'], (old: any) => {
        if (!old) return old
        const delta = direction === 'in' ? qty : -qty
        return { ...old, stock: { ...old.stock, [category_id]: Math.max(0, (old.stock[category_id] ?? 0) + delta) } }
      })
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['tree'], ctx.prev) },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tree'] })
      qc.invalidateQueries({ queryKey: ['history'] })
    },
  })
}

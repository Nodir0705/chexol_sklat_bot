export interface Category {
  id: number
  parent_id: number | null
  name: string
}

export interface StockMap {
  [categoryId: number]: number
}

export interface TreeNode extends Category {
  children: TreeNode[]
  qty: number | null
}

export interface HistoryEntry {
  id: number
  category_name: string
  category_path: string
  delta: number
  performed_by_name: string
  action_type: 'stock' | 'delete'
  created_at: string
}

export interface DeleteImpact {
  name: string
  descCount: number
  leaves: { id: number; name: string; qty: number }[]
  totalStock: number
}

export type Direction = 'in' | 'out'
export type Page = 'action' | 'history' | 'products'

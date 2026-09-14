import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchClients, fetchClient, createClient, updateClient, deleteClient,
  fetchLedger, postHandover, postReturn, postPayment, reverseEntry,
  postHandoverBatch, postReturnBatch,
  fetchClientPrices, setClientPrice, removeClientPrice,
  fetchStatement, sendStatement, linkGroup, unlinkGroup,
} from '../api/clients'
import type {
  BatchItem, BatchResult, Client, ClientPrice, ClientRef,
  LedgerEntry, LedgerResult, LinkResult, Statement,
} from '../api/clients'

// ─── Query keys ───────────────────────────────────────────────────────────────

export const clientKeys = {
  list:      ['clients'] as const,
  one:       (id: number) => ['client', id] as const,
  ledger:    (id: number, limit: number) => ['ledger', id, limit] as const,
  prices:    (id: number) => ['client-prices', id] as const,
  statement: (id: number, year: number, month: number) =>
    ['statement', id, year, month] as const,
}

// Anything that writes a ledger row moves the balance, so the list, the client
// and the statement all go stale together.
function useLedgerInvalidation(clientId: number) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['clients'] })
    qc.invalidateQueries({ queryKey: ['client', clientId] })
    qc.invalidateQueries({ queryKey: ['ledger', clientId] })
    qc.invalidateQueries({ queryKey: ['statement', clientId] })
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useClients() {
  return useQuery<Client[]>({
    queryKey: clientKeys.list,
    queryFn: fetchClients,
    staleTime: 15_000,
  })
}

export function useClient(id: number) {
  return useQuery<Client>({
    queryKey: clientKeys.one(id),
    queryFn: () => fetchClient(id),
    staleTime: 10_000,
  })
}

export function useLedger(id: number, limit = 100) {
  return useQuery<LedgerEntry[]>({
    queryKey: clientKeys.ledger(id, limit),
    queryFn: () => fetchLedger(id, limit),
    staleTime: 10_000,
  })
}

export function useClientPrices(id: number) {
  return useQuery<ClientPrice[]>({
    queryKey: clientKeys.prices(id),
    queryFn: () => fetchClientPrices(id),
    staleTime: 30_000,
  })
}

export function useStatement(id: number, year: number, month: number) {
  return useQuery<Statement>({
    queryKey: clientKeys.statement(id, year, month),
    queryFn: () => fetchStatement(id, year, month),
    staleTime: 30_000,
  })
}

// ─── Client mutations ─────────────────────────────────────────────────────────

export function useAddClient() {
  const qc = useQueryClient()
  return useMutation<ClientRef, Error, { name: string; phone: string | null }>({
    mutationFn: ({ name, phone }) => createClient(name, phone),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clients'] }) },
  })
}

export function useUpdateClient() {
  const qc = useQueryClient()
  return useMutation<ClientRef, Error, { id: number; name?: string; phone?: string | null }>({
    mutationFn: ({ id, ...patch }) => updateClient(id, patch),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['clients'] })
      qc.invalidateQueries({ queryKey: ['client', id] })
    },
  })
}

export function useDeleteClient() {
  const qc = useQueryClient()
  return useMutation<{ deleted: boolean }, Error, number>({
    mutationFn: (id) => deleteClient(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clients'] }) },
  })
}

// ─── Ledger mutations ─────────────────────────────────────────────────────────

export interface GoodsVars { category_id: number; qty: number; note?: string }

export function useHandover(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<LedgerResult, Error, GoodsVars>({
    mutationFn: ({ category_id, qty, note }) => postHandover(clientId, category_id, qty, note),
    onSuccess: invalidate,
  })
}

export function useReturnGoods(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<LedgerResult, Error, GoodsVars>({
    mutationFn: ({ category_id, qty, note }) => postReturn(clientId, category_id, qty, note),
    onSuccess: invalidate,
  })
}

export interface BatchVars { items: BatchItem[]; note?: string }

/** Several products handed over at once — one transaction, one receipt. */
export function useHandoverBatch(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<BatchResult, Error, BatchVars>({
    mutationFn: ({ items, note }) => postHandoverBatch(clientId, items, note),
    onSuccess: invalidate,
  })
}

/** Several products returned at once — one transaction, one receipt. */
export function useReturnBatch(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<BatchResult, Error, BatchVars>({
    mutationFn: ({ items, note }) => postReturnBatch(clientId, items, note),
    onSuccess: invalidate,
  })
}

export function usePayment(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<LedgerResult, Error, { amount: number; note?: string }>({
    mutationFn: ({ amount, note }) => postPayment(clientId, amount, note),
    onSuccess: invalidate,
  })
}

export function useReverseEntry(clientId: number) {
  const invalidate = useLedgerInvalidation(clientId)
  return useMutation<LedgerResult, Error, { entryId: number; note?: string }>({
    mutationFn: ({ entryId, note }) => reverseEntry(entryId, note),
    onSuccess: invalidate,
  })
}

// ─── Price mutations ──────────────────────────────────────────────────────────

export function useSetClientPrice(clientId: number) {
  const qc = useQueryClient()
  return useMutation<
    { category_id: number; unit_price: number }, Error,
    { categoryId: number; unit_price: number }
  >({
    mutationFn: ({ categoryId, unit_price }) => setClientPrice(clientId, categoryId, unit_price),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client-prices', clientId] }) },
  })
}

export function useRemoveClientPrice(clientId: number) {
  const qc = useQueryClient()
  return useMutation<{ removed: boolean }, Error, number>({
    mutationFn: (categoryId) => removeClientPrice(clientId, categoryId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client-prices', clientId] }) },
  })
}

// ─── Statement ────────────────────────────────────────────────────────────────

export function useSendStatement(clientId: number) {
  return useMutation<{ sent: boolean }, Error, { year: number; month: number }>({
    mutationFn: ({ year, month }) => sendStatement(clientId, year, month),
  })
}

export function useLinkGroup(clientId: number) {
  const qc = useQueryClient()
  return useMutation<LinkResult, Error, { code: string }>({
    mutationFn: ({ code }) => linkGroup(clientId, code),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] })
      qc.invalidateQueries({ queryKey: ['clients'] })
    },
  })
}

export function useUnlinkGroup(clientId: number) {
  const qc = useQueryClient()
  return useMutation<LinkResult, Error, void>({
    mutationFn: () => unlinkGroup(clientId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] })
      qc.invalidateQueries({ queryKey: ['clients'] })
    },
  })
}

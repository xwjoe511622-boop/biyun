import { defineStore } from 'pinia'
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { isApiError } from '@/core/errors'
import { describeApiError } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import { session } from '@/core/session'
import { commitAll, createCoalescedRefresh, isPendingId, utcTimestamp, mergeById, pendingId, type Commit } from '@/core/swr'
import * as marginApi from '@/modules/margin/api'
import type { OrderItem } from '@/modules/api/types'
import { isDecimalString, mul, sub } from '@/modules/finance/decimal'
import { useMarginStore } from './margin'
import { useMarketStore } from './market'

const PAGE_SIZE = 10

export type MarginOrderList = 'open' | 'history'
export type MarginRefreshPart = MarginOrderList | 'account'
export type MarginOrderRow = OrderItem & { pending?: boolean }

function describe(error_: unknown): string {
  // Localised by (product, code) with sub-reasons; server msg / transport text as the fallback (2026-10-01).
  return describeApiError(error_, requestLanguage())
}

function createdOrderId(data: unknown): string | null {
  if (typeof data === 'string' || typeof data === 'number') return String(data)
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const id = record.order_id ?? record.orderId ?? record.id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return null
}

const orderKey = (row: { id: string }): string => row.id

/**
 * Margin (lever) orders for the selected pair: list, place, cancel. Lever orders match in the spot engine.
 * Same state conventions as the spot store (`@/core/swr`): stale-while-revalidate lists (`loaded`), an optimistic
 * pending row on placement, the row leaves on a confirmed cancel, the margin balances move at once, and each action
 * ends in one coalesced refresh (orders + margin account) committed together.
 */
export const useMarginOrdersStore = defineStore('marginOrders', () => {
  const market = useMarketStore()
  const margin = useMarginStore()

  const lists = shallowRef<Record<MarginOrderList, MarginOrderRow[]>>({ open: [], history: [] })
  const counts = ref<Record<MarginOrderList, number>>({ open: 0, history: 0 })
  const pages = ref<Record<MarginOrderList, number>>({ open: 1, history: 1 })
  const loading = ref<Record<MarginOrderList, boolean>>({ open: false, history: false })
  const loaded = ref<Record<MarginOrderList, boolean>>({ open: false, history: false })
  const errors = ref<Record<MarginOrderList, string | null>>({ open: null, history: null })
  const submitting = ref(false)
  const cancelingId = ref<string | null>(null)
  const cancelingIds = shallowRef<ReadonlySet<string>>(new Set())
  const cancelError = ref<string | null>(null)

  const versions = { open: 0, history: 0 }
  const inflight = new Map<string, MarginOrderRow>()
  let sessionToken = session.getToken()
  onScopeDispose(session.onInvalidate((snapshot) => {
    if (snapshot.token !== sessionToken) reset()
    sessionToken = snapshot.token
  }))
  watch(() => market.selectedPair, reset, { flush: 'sync' })

  const refresher = createCoalescedRefresh<MarginRefreshPart>(async (parts) => {
    const tasks: Promise<Commit>[] = []
    if (parts.has('open')) tasks.push(prepare('open'))
    if (parts.has('history')) tasks.push(prepare('history'))
    if (parts.has('account')) tasks.push(margin.prepareAccount())
    commitAll(await Promise.all(tasks))
  })

  function patch<T>(target: { value: Record<MarginOrderList, T> }, kind: MarginOrderList, value: T): void {
    if (target.value[kind] !== value) target.value = { ...target.value, [kind]: value }
  }

  function withInflight(server: OrderItem[]): MarginOrderRow[] {
    const extra = pages.value.open === 1 ? [...inflight.values()].filter((row) => !server.some((entry) => entry.id === row.id)) : []
    return mergeById<MarginOrderRow>(lists.value.open, [...extra, ...server], orderKey)
  }

  /** Fetch → commit; rows stay on screen while refetching or after a failed refresh. */
  async function prepare(kind: MarginOrderList): Promise<Commit> {
    const symbol = margin.currentSymbol
    if (symbol === '' || !session.isAuthenticated()) {
      return () => {
        lists.value = { ...lists.value, [kind]: [] }
        patch(counts, kind, 0)
        patch(loaded, kind, true)
      }
    }
    const version = ++versions[kind]
    const token = session.getToken()
    const current = (): boolean => version === versions[kind] && token === session.getToken() && symbol === margin.currentSymbol
    patch(loading, kind, true)
    try {
      const query = { symbol, page: pages.value[kind], pageSize: PAGE_SIZE }
      const data = kind === 'open' ? await marginApi.fetchMarginOpenOrders(query) : await marginApi.fetchMarginHistoryOrders(query)
      if (!current()) return null
      return () => {
        if (!current()) return
        const rows = data.orderList ?? []
        const extra = kind === 'open' ? [...inflight.values()].filter((row) => !rows.some((entry) => entry.id === row.id)).length : 0
        lists.value = { ...lists.value, [kind]: kind === 'open' ? withInflight(rows) : mergeById<MarginOrderRow>(lists.value.history, rows, orderKey) }
        patch(counts, kind, (data.count ?? 0) + extra)
        patch(errors, kind, null)
        patch(loaded, kind, true)
        patch(loading, kind, false)
      }
    } catch (error_) {
      if (!current()) return null
      const message = describe(error_)
      return () => {
        if (!current()) return
        patch(errors, kind, message)
        patch(loading, kind, false)
      }
    }
  }

  async function load(kind: MarginOrderList): Promise<void> {
    ;(await prepare(kind))?.()
  }

  function refreshAfterAction(...parts: MarginRefreshPart[]): Promise<void> {
    return refresher.request(...parts)
  }

  function setPage(kind: MarginOrderList, page: number): void {
    pages.value = { ...pages.value, [kind]: Math.max(1, page) }
  }

  function setOpen(rows: MarginOrderRow[], countDelta: number): void {
    lists.value = { ...lists.value, open: rows }
    counts.value = { ...counts.value, open: Math.max(0, counts.value.open + countDelta) }
  }

  /** Coin + amount a resting order holds (quote for a buy, base for a sell), or null when unknown. */
  function heldBy(order: { side?: string; type?: number | string; price?: string; volume?: string; deal_volume?: string }): { coin: 'base' | 'quote'; amount: string } | null {
    const volume = order.volume ?? ''
    const dealt = order.deal_volume ?? '0'
    const remaining = isDecimalString(volume) && isDecimalString(dealt) ? sub(volume, dealt) : ''
    if (remaining === '' || remaining.startsWith('-')) return null
    const buy = (order.side ?? '').toUpperCase() === 'BUY'
    if (String(order.type) === '2') return buy ? (isDecimalString(volume) ? { coin: 'quote', amount: volume } : null) : { coin: 'base', amount: remaining }
    if (!buy) return { coin: 'base', amount: remaining }
    return isDecimalString(order.price ?? '') ? { coin: 'quote', amount: mul(order.price as string, remaining) } : null
  }

  /** Returns `null` on success, or the server message. */
  async function submit(payload: { side: 'BUY' | 'SELL'; type: '1' | '2'; price: string; volume: string }): Promise<string | null> {
    const symbol = margin.currentSymbol
    if (symbol === '') return 'error.symbolMissing'
    if (!session.isAuthenticated()) return 'common.notLoggedIn'
    // A refused start is a message, never null (= placed) — 10-01 audit.
    if (submitting.value) return 'error.submitting'
    submitting.value = true
    const temp: MarginOrderRow | null = payload.type === '1'
      ? { id: pendingId(), side: payload.side, type: 1, status: 0, price: payload.price, volume: payload.volume, deal_volume: '0', created_at: utcTimestamp(), pending: true }
      : null
    if (temp !== null) {
      inflight.set(temp.id, temp)
      setOpen(pages.value.open === 1 ? [temp, ...lists.value.open] : lists.value.open, 1)
    }
    const held = heldBy({ ...payload, deal_volume: '0' })
    const reservation = held === null ? null : margin.reserve(held.coin, held.amount)
    try {
      const data = await marginApi.createMarginOrder({ symbol, ...payload })
      if (temp !== null && inflight.delete(temp.id)) {
        const confirmed: MarginOrderRow = { ...temp, id: createdOrderId(data) ?? temp.id, pending: false }
        setOpen(lists.value.open.map((row) => (row.id === temp.id ? confirmed : row)), 0)
      }
      reservation?.settle()
      if (symbol === margin.currentSymbol) void refreshAfterAction('open', 'account')
      return null
    } catch (error_) {
      if (temp !== null && inflight.delete(temp.id)) setOpen(lists.value.open.filter((row) => row.id !== temp.id), -1)
      reservation?.rollback()
      return describe(error_)
    } finally {
      submitting.value = false
    }
  }

  async function cancel(orderId: string): Promise<boolean> {
    const symbol = margin.currentSymbol
    // Every refusal to start has a reason (10-01 audit).
    const refuse = (key: string): boolean => {
      // An i18n key (error.* / common.*): the caller translates it, like submitError.
      cancelError.value = key
      return false
    }
    if (symbol === '') return refuse('error.symbolMissing')
    if (!session.isAuthenticated()) return refuse('common.notLoggedIn')
    if (cancelingIds.value.has(orderId)) return refuse('error.busy')
    if (isPendingId(orderId)) return refuse('error.submitting')
    cancelingId.value = orderId
    cancelingIds.value = new Set([...cancelingIds.value, orderId])
    cancelError.value = null
    try {
      await marginApi.cancelMarginOrder({ orderId, symbol })
      if (symbol !== margin.currentSymbol) return true
      const row = lists.value.open.find((entry) => entry.id === orderId)
      if (row !== undefined) {
        setOpen(lists.value.open.filter((entry) => entry.id !== orderId), -1)
        const held = heldBy(row)
        if (held !== null) margin.reserve(held.coin, `-${held.amount}`).settle()
      }
      void refreshAfterAction('open', 'history', 'account')
      return true
    } catch (error_) {
      cancelError.value = describe(error_)
      return false
    } finally {
      const next = new Set(cancelingIds.value)
      next.delete(orderId)
      cancelingIds.value = next
      if (cancelingId.value === orderId) cancelingId.value = null
    }
  }

  function reset(): void {
    versions.open += 1
    versions.history += 1
    refresher.cancel()
    inflight.clear()
    lists.value = { open: [], history: [] }
    counts.value = { open: 0, history: 0 }
    pages.value = { open: 1, history: 1 }
    loading.value = { open: false, history: false }
    loaded.value = { open: false, history: false }
    errors.value = { open: null, history: null }
    cancelError.value = null
    cancelingIds.value = new Set()
    cancelingId.value = null
  }

  return { lists, counts, pages, loading, loaded, errors, submitting, cancelingId, cancelingIds, cancelError, pageSize: PAGE_SIZE, load, refreshAfterAction, setPage, submit, cancel, reset }
})

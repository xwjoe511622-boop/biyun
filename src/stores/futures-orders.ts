import { defineStore } from 'pinia'
import { onScopeDispose, reactive, ref, shallowRef } from 'vue'
import { isApiError } from '@/core/errors'
import { describeApiError } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import { session } from '@/core/session'
import { isPendingId, mergeById, pendingId, type Commit } from '@/core/swr'
import * as api from '@/modules/futures/api'
import { isNotOpenedError } from '@/modules/futures/open-account'
import { ensureFuturesMessages } from '@/modules/futures/i18n'
import { i18n } from '@/i18n'
import { mergeClosedPositions, type ClosedPosition } from '@/modules/futures/position-history'
import type { FuturesOrder, FuturesTrade, FuturesTransaction, FuturesTriggerOrder } from '@/modules/futures/types'
import { fetchOpenOrders, type FapiOpenOrder } from '@/modules/futures/fapi'
import { describeFapiError } from '@/modules/futures/fapi-errors'
import { FAPI_CODE_USE_CLASSIC, cancelAllFapiOrders } from '@/modules/futures/fapi-order'
import { compareTriggerRows, isConditionalOrder, triggerOrderFromFapi } from '@/modules/futures/fapi-conditional'
import { showToast } from '@/core/toast'
import { groupDigits } from '@/modules/finance/decimal'
import {
  compareOrders,
  contractForSymbol,
  fillNotice,
  isTerminalStatus,
  orderFromSnapshot,
  orderFromStream,
  type FillNotice,
  type StreamOrder,
} from '@/modules/futures/stream-model'
import type { FuturesContract } from '@/modules/futures/contracts'
import { useFuturesAccountStore } from './futures-account'
import { useFuturesMarketStore } from './futures-market'

export type ListKey = 'current' | 'trigger' | 'history' | 'historyTrigger' | 'trades' | 'transactions' | 'positionHistory'

interface ListState<T> {
  rows: T[]
  count: number
  page: number
  /** Only before the first answer (the panel shows its loading block then, never on a refetch). */
  loading: boolean
  /** A request is in flight while rows stay on screen (thin progress line). */
  refreshing: boolean
  error: string | null
  loaded: boolean
}

/** An open order row; `pending` while its create request is in flight (optimistic row). */
export type FuturesOrderRow = FuturesOrder & { pending?: boolean }

function emptyList<T>(): ListState<T> {
  return { rows: [], count: 0, page: 1, loading: false, refreshing: false, error: null, loaded: false }
}

export const FUTURES_PAGE_SIZE = 10
const LIST_KEYS: readonly ListKey[] = ['current', 'trigger', 'history', 'historyTrigger', 'trades', 'transactions', 'positionHistory']

/**
 * Paged futures order lists for the current contract (`order/*_list`, `order/his_trade_list`) and
 * the margin-coin flow records (`record/get_transaction_list`).
 *
 * State conventions (`@/core/swr`): lists are stale-while-revalidate; a resting limit order shows up in 当前委托 as
 * a pending row the moment it is submitted; a cancelled order leaves the list as soon as the server confirms; the lists
 * take part in the account store's one coalesced refresh (assets + lists committed together).
 */
export const useFuturesOrdersStore = defineStore('futures-orders', () => {
  const market = useFuturesMarketStore()
  const account = useFuturesAccountStore()
  const lists = reactive({
    current: emptyList<FuturesOrderRow>(),
    trigger: emptyList<FuturesTriggerOrder>(),
    history: emptyList<FuturesOrder>(),
    historyTrigger: emptyList<FuturesTriggerOrder>(),
    trades: emptyList<FuturesTrade>(),
    transactions: emptyList<FuturesTransaction>(),
    positionHistory: emptyList<ClosedPosition>(),
  })
  const cancelingId = ref<string | null>(null)
  /** 仓位历史 contract filter: every contract (Binance default) or one contract id. */
  const positionHistoryContract = ref<number | 'all'>('all')
  /** Optimistic open orders whose create request is in flight; kept on top of every answer until it settles. */
  const inflight = new Map<string, FuturesOrderRow>()
  /**
   * Live mode (user stream): every open order of every contract, by id, kept by ORDER_TRADE_UPDATE and rebuilt from
   * `/fapi/v1/openOrders` on (re)connect; 当前委托 is a page of it (no `current_order_list`), 可平 is derived from it.
   */
  const openOrders = new Map<string, FuturesOrder>()
  /**
   * Waiting conditional orders (TP/SL, 条件委托) of every contract from `/fapi/v1/openOrders` (fgw 0.6.9+: ids ≥ 8e18,
   * types STOP / TAKE_PROFIT[_MARKET]); never part of 当前委托. `conditionalRows` is its reactive copy (TP/SL column,
   * TP/SL dialog). Re-read after own actions and when the stream shows an order this page did not place (a trigger
   * fired) or a position change (the core cancels a closed position's TP/SL); conditionals have no stream events yet.
   */
  const conditionals = new Map<string, FuturesTriggerOrder>()
  const conditionalRows = shallowRef<FuturesTriggerOrder[]>([])
  /** The map reflects a `/fapi` snapshot (else unknown: classic account, or not read yet). */
  const conditionalsKnown = ref(false)
  /** Ids this page cancelled (not reported as fired when they disappear). */
  const cancelledHere = new Set<string>()
  /** A conditional that just EXPIRED, by contract:side, until the order it placed shows up (then it fired). */
  const pendingFire = new Map<string, { order: FuturesTriggerOrder; at: number }>()
  let conditionalsTimer: ReturnType<typeof setTimeout> | null = null
  /** Debounced re-reads of the lists a fill changes (only lists the user has opened). */
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const staleKeys = new Set<ListKey>()
  let generation = 0
  let token = session.getToken()
  onScopeDispose(session.onInvalidate((snapshot) => {
    if (snapshot.token !== token) reset()
    token = snapshot.token
  }))
  onScopeDispose(account.registerListRefresh((parts) => LIST_KEYS.filter((key) => parts.has(key)).map((key) => prepare(key))))
  onScopeDispose(account.registerOpenOrders(() => openOrders.values()))
  onScopeDispose(() => { if (staleTimer !== null) clearTimeout(staleTimer); if (conditionalsTimer !== null) clearTimeout(conditionalsTimer) })

  /** Session change: everything goes. A contract switch keeps the all-contract open-order map (`resetForContract`). */
  function reset(): void {
    openOrders.clear()
    conditionals.clear()
    conditionalRows.value = []
    conditionalsKnown.value = false
    cancelledHere.clear()
    pendingFire.clear()
    resetLists()
  }

  function resetLists(): void {
    generation += 1
    inflight.clear()
    staleKeys.clear()
    if (staleTimer !== null) clearTimeout(staleTimer)
    staleTimer = null
    ;(Object.keys(lists) as ListKey[]).forEach((key) => {
      Object.assign(lists[key], emptyList())
    })
    cancelingId.value = null
  }

  function describe(error_: unknown): string {
    // `/fapi` order entry (Binance codes) first; then localised by (product, code) with sub-reasons; server msg /
    // transport text as the fallback (2026-10-01).
    return describeFapiError(error_, requestLanguage()) ?? describeApiError(error_, requestLanguage())
  }

  async function fetchList(key: ListKey): Promise<{ rows: unknown[]; count: number }> {
    const contract = market.currentContract
    if (contract === undefined) return { rows: [], count: 0 }
    const query = { contractId: contract.id, page: lists[key].page, limit: FUTURES_PAGE_SIZE }
    switch (key) {
      case 'current':
        if (account.live) {
          replaceOpenOrders(await fetchOpenOrders())
          return currentPage()
        }
        return api.fetchCurrentOrders(query)
      case 'trigger':
        if (account.fapiOrdersActive()) {
          replaceOpenOrders(await fetchOpenOrders())
          return triggerPage()
        }
        return api.fetchTriggerOrders(query)
      case 'history': return api.fetchHistoryOrders(query)
      case 'historyTrigger': return api.fetchHistoryTriggerOrders(query)
      case 'trades': return api.fetchTradeHistory(query)
      case 'transactions': return api.fetchTransactions({ symbol: contract.marginCoin, page: lists[key].page, limit: FUTURES_PAGE_SIZE })
      case 'positionHistory': {
        const filter = positionHistoryContract.value
        if (filter !== 'all') return api.fetchPositionHistory(filter, lists[key].page, FUTURES_PAGE_SIZE)
        const page = lists[key].page
        const parts = await Promise.all(market.allContracts.map((entry) => api.fetchPositionHistory(entry.id, 1, page * FUTURES_PAGE_SIZE)))
        return mergeClosedPositions(parts, page, FUTURES_PAGE_SIZE)
      }
    }
  }

  function rowKey(row: unknown): string {
    const id = (row as { id?: unknown }).id
    return typeof id === 'string' || typeof id === 'number' ? String(id) : ''
  }

  /** Fetch → commit. Rows stay on screen while refetching or after a failed refresh. */
  async function prepare(key: ListKey): Promise<Commit> {
    if (!session.isAuthenticated() || !account.isOpened || market.currentContract === undefined) return null
    const current = generation
    const target = lists[key]
    target.loading = !target.loaded
    target.refreshing = target.loaded
    try {
      const result = await fetchList(key)
      if (current !== generation) return null
      return () => {
        if (current !== generation) return
        let rows = result.rows
        let count = result.count
        if (key === 'current' && target.page === 1 && inflight.size > 0) {
          const extra = [...inflight.values()].filter((row) => !rows.some((entry) => rowKey(entry) === row.id))
          rows = [...extra, ...rows]
          count += extra.length
        }
        // Transactions have no unique id, and closed-position ids are per contract table (all-contract view): both are
        // replaced as a whole.
        ;(target as ListState<unknown>).rows = key === 'transactions' || key === 'positionHistory' ? rows : mergeById(target.rows as object[], rows as object[], rowKey)
        target.count = count
        target.loaded = true
        target.error = null
        target.loading = false
        target.refreshing = false
      }
    } catch (error_) {
      if (current !== generation) return null
      return () => {
        if (current !== generation) return
        if (isNotOpenedError(error_)) void account.loadConfig()
        target.error = describe(error_)
        target.loading = false
        target.refreshing = false
      }
    }
  }

  async function load(key: ListKey): Promise<void> {
    ;(await prepare(key))?.()
  }

  function setPage(key: ListKey, page: number): void {
    lists[key].page = Math.max(1, page)
    void load(key)
  }

  /** New contract: every list starts again from page 1. */
  function resetForContract(): void {
    resetLists()
  }

  /* ------------------------------------------------------------ live (user stream) */

  /**
   * Margin mode of a new order (the stream does not carry it): the contract's open position decides (a margin-mode
   * change made elsewhere sends no event, so the page config may be stale), else the page config.
   */
  function positionTypeFor(contractId: number): number | null {
    const held = account.positions.find((row) => row.contractId === contractId && row.positionType !== null)
    if (held !== undefined) return held.positionType
    return contractId === market.currentContract?.id ? account.marginModel : null
  }

  /** The current contract's open orders, newest first, as one page of 当前委托. */
  function currentPage(): { rows: FuturesOrder[]; count: number } {
    const id = market.currentContract?.id
    const all = [...openOrders.values()].filter((order) => order.contractId === id).sort(compareOrders)
    const start = (lists.current.page - 1) * FUTURES_PAGE_SIZE
    return { rows: all.slice(start, start + FUTURES_PAGE_SIZE), count: all.length }
  }

  /** Re-renders 当前委托 from the map (keeps unchanged rows and the in-flight optimistic rows). */
  function rebuildCurrent(): void {
    const target = lists.current
    if (!target.loaded || !account.live) return
    const page = currentPage()
    const extra = target.page === 1 ? [...inflight.values()].filter((row) => !openOrders.has(row.id)) : []
    target.rows = mergeById(target.rows, [...extra, ...page.rows], (row) => row.id)
    target.count = page.count + extra.length
  }

  /** The current contract's waiting conditionals, newest first, as one page of 条件委托. */
  function triggerPage(): { rows: FuturesTriggerOrder[]; count: number } {
    const id = market.currentContract?.id
    const all = [...conditionals.values()].filter((order) => order.contractId === id).sort(compareTriggerRows)
    const start = (lists.trigger.page - 1) * FUTURES_PAGE_SIZE
    return { rows: all.slice(start, start + FUTURES_PAGE_SIZE), count: all.length }
  }

  /**
   * `/fapi/v1/openOrders` (all contracts) → the open-order map (live mode) and the conditional map (always). Since fgw
   * 0.6.9 the snapshot also lists waiting conditionals: they never enter 当前委托 / 可平.
   */
  function replaceOpenOrders(rows: readonly FapiOpenOrder[]): void {
    const before = new Map(conditionals)
    if (account.live) openOrders.clear()
    conditionals.clear()
    for (const row of rows) {
      const own = contractForSymbol(market.allContracts, row.symbol)
      if (own === undefined || isTerminalStatus(row.status)) continue
      if (isConditionalOrder(row)) {
        const trigger = triggerOrderFromFapi(row, own)
        if (trigger.id !== '') conditionals.set(trigger.id, trigger)
        continue
      }
      if (!account.live) continue
      const order = orderFromSnapshot(row, own, positionTypeFor(own.id))
      if (order.id !== '') openOrders.set(order.id, order)
    }
    if (account.live) account.openOrdersChanged()
    publishConditionals(before)
  }

  /** Copies the map to `conditionalRows` and re-renders 条件委托 (if loaded). Fires are reported from the stream. */
  function publishConditionals(_before: Map<string, FuturesTriggerOrder> | null): void {
    conditionalsKnown.value = true
    conditionalRows.value = [...conditionals.values()]
    if (lists.trigger.loaded && account.fapiOrdersActive()) {
      const page = triggerPage()
      lists.trigger.rows = mergeById(lists.trigger.rows, page.rows, (row) => row.id)
      lists.trigger.count = page.count
    }
  }

  /** 「止损已触发：平多 BTCUSDT，触发价 80,000.0（标记价格）」 — the fill toast of the resulting order follows. */
  function toastFired(order: FuturesTriggerOrder): void {
    ensureFuturesMessages()
    const t = i18n.global.t
    const own = market.allContracts.find((entry) => entry.id === order.contractId)
    const kind = t(`fut.trigType.${order.open === 'CLOSE' ? (order.triggerType === 2 ? 2 : 1) : 5}`)
    const side = order.open === 'OPEN' ? (order.side === 'BUY' ? t('fut.openLong') : t('fut.openShort')) : (order.side === 'BUY' ? t('fut.closeShort') : t('fut.closeLong'))
    showToast(t('fut.cond.fired', {
      kind,
      side,
      symbol: own?.displayName ?? order.contractName,
      price: groupDigits(order.triggerPrice, own?.pricePrecision ?? null),
      priceType: t(order.workingType === 'MARK_PRICE' ? 'fut.cond.mark' : 'fut.cond.last'),
    }), 'info', { key: `fired:${order.id}`, timeout: 5000 })
  }

  /** Re-reads the conditional map soon (one request per burst). */
  function refreshConditionals(delayMs = 600): void {
    if (!session.isAuthenticated() || !account.fapiOrdersActive()) return
    if (conditionalsTimer !== null) return
    conditionalsTimer = setTimeout(() => {
      conditionalsTimer = null
      const current = generation
      const before = new Map(conditionals)
      void fetchOpenOrders().then((rows) => {
        if (current !== generation) return
        if (account.live) {
          replaceOpenOrders(rows)
          rebuildCurrent()
          return
        }
        conditionals.clear()
        for (const row of rows) {
          const own = contractForSymbol(market.allContracts, row.symbol)
          if (own === undefined || isTerminalStatus(row.status) || !isConditionalOrder(row)) continue
          const trigger = triggerOrderFromFapi(row, own)
          if (trigger.id !== '') conditionals.set(trigger.id, trigger)
        }
        publishConditionals(before)
      }).catch(() => undefined)
    }, delayMs)
  }

  /**
   * A position changed: the core cancels a closed position's TP/SL and says so on the stream (EXPIRED). Without the
   * stream (classic poll) the conditional map is re-read instead.
   */
  function positionsChanged(): void {
    if (!account.live && conditionals.size > 0) refreshConditionals(800)
  }

  /** Resync after (re)connect: the snapshot replaces the map and 当前委托 follows. */
  function resyncOpenOrders(rows: readonly FapiOpenOrder[]): void {
    replaceOpenOrders(rows)
    rebuildCurrent()
  }

  /**
   * ORDER_TRADE_UPDATE: NEW / partial fill updates the row, a final state removes it. Returns the fill (TRADE) for the
   * 「订单已成交」 toast, or null.
   */
  function applyOrderEvent(order: StreamOrder): FillNotice | null {
    const own = contractForSymbol(market.allContracts, order.s)
    if (own === undefined) return null
    // Conditional order events (core 0.8.7 via fgw): the conditional map, never 当前委托.
    const extra = order as unknown as Record<string, unknown>
    if (isConditionalOrder({ type: String(order.o ?? ''), origType: String(extra.ot ?? order.o ?? ''), orderId: String(order.i) })) {
      applyConditionalEvent(order, extra, own)
      return null
    }
    // The order a fired trigger placed (EXPIRED of the conditional came just before): 「…已触发」.
    if (String(order.x).toUpperCase() === 'NEW') {
      const key = `${own.id}:${String(order.S).toUpperCase()}`
      const fired = pendingFire.get(key)
      if (fired !== undefined && Date.now() - fired.at <= 5_000) {
        pendingFire.delete(key)
        toastFired(fired.order)
      }
    }
    const next = orderFromStream(order, own, positionTypeFor(own.id), openOrders.get(String(order.i)))
    if (next.id === '') return null
    if (isTerminalStatus(order.X)) openOrders.delete(next.id)
    else openOrders.set(next.id, next)
    account.openOrdersChanged()
    rebuildCurrent()
    const fill = fillNotice(order, own)
    // Zero-fill FOK/post-only cancellations are terminal history too.
    if (isTerminalStatus(order.X)) markStale('history')
    if (fill !== null) markStale('history', 'trades', 'positionHistory')
    // A NEW order this page did not place may be a conditional order that fired: 条件委托 changes (classic list).
    if (String(order.x).toUpperCase() === 'NEW' && lists.trigger.rows.length > 0 && !account.fapiOrdersActive()) markStale('trigger')
    return fill
  }

  /**
   * `ORDER_TRADE_UPDATE` of a conditional (`i` = 8e18 + row id; `sp` / `wt` / `cp` / `R` / `ps`; `oq` = USDT amount of
   * a vendor market OPEN; `otoPending` = attached leg not armed yet — it rides on its entry, not listed here). NEW →
   * listed (again after an OTO activation or a failed fire); CANCELED → gone; EXPIRED → gone, and when the order it
   * placed follows (NEW on the same contract and side within 5 s) it was a fire.
   */
  function applyConditionalEvent(order: StreamOrder, extra: Record<string, unknown>, own: FuturesContract): void {
    const id = String(order.i)
    const status = String(order.X).toUpperCase()
    const row: FapiOpenOrder = {
      orderId: id, symbol: String(order.s), status, price: String(order.p ?? '0'), avgPrice: '0', origQty: String(order.q ?? '0'), executedQty: '0',
      type: String(order.o ?? ''), origType: String(extra.ot ?? order.o ?? ''), timeInForce: String(order.f ?? 'GTC'), side: String(order.S), positionSide: String(extra.ps ?? ''),
      reduceOnly: extra.R === true, time: Number(order.T ?? 0), updateTime: Number(order.T ?? 0), stopPrice: String(extra.sp ?? ''), // float-ok: epoch timestamp
      workingType: String(extra.wt ?? ''), closePosition: extra.cp === true, origQuoteQty: String(extra.oq ?? ''),
    }
    const before = conditionals.get(id)
    if (status === 'NEW' && extra.otoPending !== true) {
      const trigger = triggerOrderFromFapi(row, own)
      // the snapshot row may know the creation time the event lacks
      conditionals.set(id, before !== undefined && trigger.ctime === null ? { ...trigger, ctime: before.ctime } : trigger)
    } else if (isTerminalStatus(status)) {
      conditionals.delete(id)
      if (status === 'EXPIRED' && !cancelledHere.has(id)) pendingFire.set(`${own.id}:${row.side.toUpperCase()}`, { order: before ?? triggerOrderFromFapi(row, own), at: Date.now() })
    } else {
      return
    }
    publishConditionals(null)
  }

  /** Lists that changed on the server: re-read (once per burst) the ones the user has loaded. */
  function markStale(...keys: ListKey[]): void {
    keys.forEach((key) => { if (lists[key].loaded) staleKeys.add(key) })
    if (staleKeys.size === 0 || staleTimer !== null) return
    staleTimer = setTimeout(() => {
      staleTimer = null
      const keysNow = [...staleKeys]
      staleKeys.clear()
      keysNow.forEach((key) => { void load(key) })
    }, 1_000)
  }

  /**
   * Places an order through the account store (margin reservation, one refresh). A resting limit order (GTC / post
   * only, not conditional) appears in 当前委托 at once as a pending row; it is removed again if the server refuses.
   */
  async function placeOrder(payload: api.CreateOrderPayload, options: { reserve?: string } = {}): Promise<string | null> {
    const contract = market.currentContract
    const rests = !payload.isConditionOrder && (payload.type === 1 || payload.type === 5)
    const temp: FuturesOrderRow | null = rests && contract !== undefined && contract.id === payload.contractId && account.busy === null
      ? {
          id: pendingId(), contractId: payload.contractId, contractName: contract.contractName, side: payload.side, open: payload.open,
          type: payload.type, positionType: payload.positionType, price: payload.price, avgPrice: '', volume: payload.volume, dealVolume: '0',
          status: 0, tradeFee: '', realizedAmount: '', orderBalance: '', memo: '', liqPositionMsg: '', ctime: Date.now(), mtime: null, pending: true,
        }
      : null
    const target = lists.current
    if (temp !== null) {
      inflight.set(temp.id, temp)
      if (target.page === 1) target.rows = [temp, ...target.rows]
      target.count += 1
    }
    const result = await account.placeOrder(payload, {
      reserve: options.reserve,
      onAccepted: (ids) => {
        // Reconcile loaded history even without a stream event (classic / disconnected clients).
        markStale(payload.isConditionOrder ? 'historyTrigger' : 'history')
        if (temp === null || !inflight.delete(temp.id)) return
        const confirmed: FuturesOrderRow = { ...temp, id: ids[0] ?? temp.id, pending: false }
        if (account.live && ids[0] !== undefined) {
          // The stream usually delivered NEW before this answer; otherwise hold the confirmed row until it does.
          if (!openOrders.has(confirmed.id)) openOrders.set(confirmed.id, { ...confirmed, pending: undefined } as FuturesOrder)
          target.rows = target.rows.filter((row) => row.id !== temp.id)
          rebuildCurrent()
          return
        }
        target.rows = target.rows.map((row) => (row.id === temp.id ? confirmed : row))
      },
    })
    if (result !== null && temp !== null && inflight.delete(temp.id)) {
      target.rows = target.rows.filter((row) => row.id !== temp.id)
      target.count = Math.max(0, target.count - 1)
    }
    return result
  }

  /** Cancels one order: 撤销中 while the request runs, the row leaves on confirmation, then one refresh (list + 可用). */
  async function cancel(order: { id: string; contractId: number | null }, conditional: boolean): Promise<string | null> {
    const contractId = order.contractId ?? market.currentContract?.id
    // A refused start is a message, never null (= cancelled) — 10-01 audit.
    ensureFuturesMessages()
    if (contractId === undefined) return i18n.global.t('fut.err.incomplete')
    if (cancelingId.value !== null) return i18n.global.t('fut.pm.busy')
    if (isPendingId(order.id)) return i18n.global.t('fut.err.orderPending')
    const key: ListKey = conditional ? 'trigger' : 'current'
    const current = generation
    cancelingId.value = order.id
    try {
      if (conditional) await account.cancelConditionalRouted(contractId, order.id)
      else await account.cancelOrderRouted(contractId, order.id)
      if (!conditional && openOrders.delete(order.id)) account.openOrdersChanged()
      if (conditional) {
        cancelledHere.add(order.id)
        if (conditionals.delete(order.id)) publishConditionals(null)
      }
      if (current === generation) {
        const target = lists[key] as ListState<{ id: string }>
        if (target.rows.some((row) => row.id === order.id)) {
          target.rows = target.rows.filter((row) => row.id !== order.id)
          target.count = Math.max(0, target.count - 1)
        }
        void account.refreshAfterAction(key, 'assets')
      }
      return null
    } catch (error_) {
      return describe(error_)
    } finally {
      cancelingId.value = null
    }
  }

  /**
   * 全部撤单 for the current contract's open (or conditional) orders. The list is paged, so cancel the loaded page and
   * reload until empty (bounded); failures are collected, not fatal.
   */
  async function cancelAll(conditional: boolean): Promise<string | null> {
    const key: ListKey = conditional ? 'trigger' : 'current'
    if (cancelingId.value !== null) {
      ensureFuturesMessages()
      return i18n.global.t('fut.pm.busy')
    }
    cancelingId.value = '*'
    const failures: string[] = []
    try {
      // Binance-style: one DELETE allOpenOrders for the contract (conditional orders are not included); the classic
      // per-order loop below remains for a `-4000` account and as the sweep for anything left.
      const own = market.currentContract
      // allOpenOrders also cancels the contract's conditional orders (fgw 0.6.9): only when it has none (read first
      // when unknown); otherwise the per-order loop below cancels the normal orders only.
      if (!conditional && own !== undefined && account.fapiOrdersActive() && !conditionalsKnown.value) {
        try { replaceOpenOrders(await fetchOpenOrders()) } catch { /* unknown: per-order loop */ }
      }
      const hasConditionals = !conditionalsKnown.value || [...conditionals.values()].some((row) => row.contractId === own?.id)
      if (!conditional && own !== undefined && account.fapiOrdersActive() && !hasConditionals) {
        try {
          await cancelAllFapiOrders(own)
          for (const [id, order] of openOrders) if (order.contractId === own.id) openOrders.delete(id)
          account.openOrdersChanged()
          lists[key].page = 1
          await load(key)
        } catch (error_) {
          if (isApiError(error_) && error_.code === FAPI_CODE_USE_CLASSIC) account.useClassicOrders()
          else failures.push(describe(error_))
        }
      }
      for (let round = 0; round < 20 && failures.length === 0; round += 1) {
        const rows = (lists[key].rows as { id: string; contractId: number | null }[]).filter((row) => !isPendingId(row.id))
        if (rows.length === 0) break
        for (const order of rows) {
          const contractId = order.contractId ?? market.currentContract?.id
          if (contractId === undefined) continue
          try {
            if (conditional) {
              await account.cancelConditionalRouted(contractId, order.id)
              cancelledHere.add(order.id)
              conditionals.delete(order.id)
            } else await account.cancelOrderRouted(contractId, order.id)
          } catch (error_) {
            failures.push(describe(error_))
          }
        }
        lists[key].page = 1
        await load(key)
        if (failures.length > 0) break
      }
      await account.refreshAfterAction('assets')
      return failures.length > 0 ? [...new Set(failures)].join('；') : null
    } finally {
      cancelingId.value = null
    }
  }

  /** New 仓位历史 filter: page 1 of that selection. */
  function setPositionHistoryContract(next: number | 'all'): void {
    positionHistoryContract.value = next
    Object.assign(lists.positionHistory, emptyList())
    void load('positionHistory')
  }

  return {
    lists, cancelingId, positionHistoryContract, reset, load, setPage, resetForContract, setPositionHistoryContract, placeOrder, cancel, cancelAll,
    applyOrderEvent, resyncOpenOrders, markStale, conditionalRows, conditionalsKnown, refreshConditionals, positionsChanged,
    noteCancelled: (id: string) => { cancelledHere.add(id) },
  }
})

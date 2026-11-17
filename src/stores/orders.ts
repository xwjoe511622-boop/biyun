import { i18n } from '@/i18n/composer'
import { defineStore } from 'pinia'
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { commitAll, createCoalescedRefresh, isPendingId, utcTimestamp, mergeById, pendingId, type Commit } from '@/core/swr'
import { describeApiError, guardedRefresh, isOrderResultUnknown, orderUnconfirmedText } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import * as orderApi from '@/modules/api/order.api'
import type { OrderItem, TradeItem } from '@/modules/api/types'
import { isDecimalString, mul, sub } from '@/modules/finance/decimal'
import { newClientOrderId } from '@/modules/futures/fapi-order'
import type { OverlayHandle } from '@/core/swr'
import { cancelAllSpotOrders, cancelSpotOrder, fetchSpotOpenOrders, placeSpotOrder, type SpotV3Order } from '@/modules/spot/spot-api'
import { describeSpotV3Error, isSpotV3ResultUnknown, isSpotV3Unavailable } from '@/modules/spot/spot-errors'
import { markSpotV3Unavailable, spotOrderParams, spotV3Enabled, type SpotOrderPayload } from '@/modules/spot/spot-order'
import { compareOpenRows, isMarginOrder, isOpenStatus, orderFromV3, v3Symbol, type SpotOrderRow } from '@/modules/spot/spot-stream-model'
import { useAccountStore } from './account'
import { useMarketStore } from './market'

const PAGE_SIZE = 20

export type OrderSideFilter = '' | 'BUY' | 'SELL'
type ListKind = 'open' | 'history' | 'trades'
/** Parts of the one refresh that follows an order action. */
export type SpotRefreshPart = ListKind | 'account'

/** The last order the server accepted (quick buy reads its fill): id when given, `/api/v3` reply when that path was used. */
export interface PlacedOrder { id: string | null; symbol: string; v3: SpotV3Order | null }

/** An open-order row; `pending` while the create request is in flight (optimistic row). */
export type OpenOrderRow = OrderItem & { pending?: boolean; clientOrderId?: string }

/** Optimistic balance moves wait at most this long for the stream's balance event, then they are dropped. */
const LIVE_HOLD_MS = 10_000
/**
 * 全部撤单 = one `DELETE /api/v3/openOrders?symbol=` (fgw 0.6.5 touches spot orders only: margin orders are excluded
 * from `/api/v3`, 10-02). `false` = one `DELETE /api/v3/order` per row known here (also the classic-path behaviour).
 */
export const SPOT_V3_BULK_CANCEL = true
/** i18n key: IOC / FOK chosen while `/api/v3` is not available (the classic path has no time-in-force). */
export const IOC_UNAVAILABLE = 'error.tifUnavailable'

interface LiveHold { handle: OverlayHandle; timer: ReturnType<typeof setTimeout>; keys: string[] }

const orderKey = (row: { id: string }): string => row.id
const tradeKey = (row: TradeItem): string => String(row.id)

function createdOrderId(data: unknown): string | null {
  if (typeof data === 'string' || typeof data === 'number') return String(data)
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const id = record.order_id ?? record.orderId ?? record.id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return null
}

/**
 * Open orders / history / my fills for the selected pair, plus order placement and cancel.
 *
 * State conventions (`@/core/swr`): lists are stale-while-revalidate (`loaded` = first answer seen; `loading` = a
 * request in flight, never a reason to hide rows); a limit order appears in 当前委托 as a pending row the moment it is
 * submitted and a cancelled order leaves the list as soon as the server confirms; balances move at once through the
 * account overlay; every action ends in ONE coalesced refresh whose answers are committed together.
 */
export const useOrdersStore = defineStore('orders', () => {
  const openOrders = shallowRef<OpenOrderRow[]>([])
  const historyOrders = shallowRef<OrderItem[]>([])
  const myTrades = shallowRef<TradeItem[]>([])
  const openCount = ref(0)
  const historyCount = ref(0)
  const tradesCount = ref(0)
  const openPage = ref(1)
  const historyPage = ref(1)
  const tradesPage = ref(1)
  const sideFilter = ref<OrderSideFilter>('')
  const showCanceled = ref(true)
  const loading = ref<Record<ListKind, boolean>>({ open: false, history: false, trades: false })
  const loaded = ref<Record<ListKind, boolean>>({ open: false, history: false, trades: false })
  const errors = ref<Record<ListKind, string | null>>({ open: null, history: null, trades: null })
  const submitting = ref(false)
  const submitError = ref<string | null>(null)
  const lastPlaced = shallowRef<PlacedOrder | null>(null)
  /** Last order a cancel was started for (kept for callers); `cancelingIds` holds every order being cancelled. */
  const cancelingId = ref<string | null>(null)
  const cancelingIds = shallowRef<ReadonlySet<string>>(new Set())
  const cancelError = ref<string | null>(null)
  const cancelingAll = ref(false)
  /**
   * Spot user stream live (`stores/spot-live.ts`): 当前委托 is the stream-maintained map of the current pair (paged
   * here), balances move by the stream, and an order action triggers no refresh of its own.
   */
  const live = ref(false)
  /** `/api/v3` usable for this session (IOC / FOK need it). Turns false after a "not here" answer. */
  const v3Available = ref(spotV3Enabled())
  const liveOrders = new Map<string, SpotOrderRow>()
  /** Ids seen final (filled / cancelled / expired) recently: a late reply never re-adds them. */
  const finalIds = new Map<string, number>()
  /** Optimistic balance moves waiting for the stream: by `c:<clientOrderId>` (orders) or `o:<orderId>` (cancels). */
  const liveHolds = new Map<string, LiveHold>()
  /** Holds whose order event arrived: dropped after the next authoritative balance read. */
  const releaseOnBalance: OverlayHandle[] = []

  const market = useMarketStore()
  const account = useAccountStore()
  const requestVersions = { open: 0, history: 0, trades: 0 }
  /** Optimistic rows whose create request is still in flight: kept on top of every server answer until it settles. */
  const inflight = new Map<string, OpenOrderRow>()
  let sessionToken = session.getToken()
  onScopeDispose(session.onInvalidate(snapshot => {
    if (snapshot.token !== sessionToken) reset()
    sessionToken = snapshot.token
  }))
  watch(() => market.selectedPair, reset, { flush: 'sync' })

  const refresher = createCoalescedRefresh<SpotRefreshPart>(async (parts) => {
    const tasks: Promise<Commit>[] = []
    if (parts.has('open')) tasks.push(prepareOpenOrders())
    if (parts.has('history')) tasks.push(prepareHistoryOrders())
    if (parts.has('trades')) tasks.push(prepareMyTrades())
    // Live mode: balance notifications schedule their own authoritative classic read.
    if (parts.has('account') && !live.value) tasks.push(account.prepare())
    commitAll(await Promise.all(tasks))
  })

  function requestGuard(kind: keyof typeof requestVersions, symbol: string): () => boolean {
    const version = ++requestVersions[kind]
    const token = session.getToken()
    return () => version === requestVersions[kind] && token === session.getToken() && symbol === requireSymbol()
  }

  function describe(error_: unknown): string {
    // Guard refusals (-1003 / -1013 / -1015 / -2010, sub-reason aware), then the spot code table, then the server msg.
    return describeSpotV3Error(error_, requestLanguage()) ?? describeApiError(error_, requestLanguage())
  }

  function requireSymbol(): string | null {
    const symbol = market.currentSymbolName
    return symbol === '' ? null : symbol
  }

  function setFlag(target: typeof loading | typeof loaded, kind: ListKind, value: boolean): void {
    if (target.value[kind] !== value) target.value = { ...target.value, [kind]: value }
  }

  function setError(kind: ListKind, value: string | null): void {
    if (errors.value[kind] !== value) errors.value = { ...errors.value, [kind]: value }
  }

  /** Server rows plus the optimistic rows still in flight (page 1 only), merged by id so unchanged rows keep their DOM. */
  function withInflight(server: OrderItem[]): OpenOrderRow[] {
    const extra = openPage.value === 1 ? [...inflight.values()].filter((row) => !server.some((entry) => entry.id === row.id)) : []
    return mergeById<OpenOrderRow>(openOrders.value, [...extra, ...server], orderKey)
  }

  /**
   * Generic list fetch → commit. A refetch keeps the current rows on screen (`loading` only), an error keeps them too
   * (the panel shows the message next to the rows); the full loading state is for the first answer only.
   */
  async function prepareList<T>(kind: ListKind, fetch: (symbol: string) => Promise<{ rows: T[]; count: number }>, apply: (rows: T[], count: number) => void): Promise<Commit> {
    const symbol = requireSymbol()
    if (symbol === null || !session.isAuthenticated()) {
      return () => {
        apply([], 0)
        setFlag(loaded, kind, true)
      }
    }
    const current = requestGuard(kind, symbol)
    setFlag(loading, kind, true)
    try {
      const data = await fetch(symbol)
      if (!current()) return null
      return () => {
        if (!current()) return
        apply(data.rows, data.count)
        setError(kind, null)
        setFlag(loaded, kind, true)
        setFlag(loading, kind, false)
      }
    } catch (error_) {
      if (!current()) return null
      const message = describe(error_)
      return () => {
        if (!current()) return
        setError(kind, message)
        setFlag(loading, kind, false)
      }
    }
  }

  function prepareOpenOrders(): Promise<Commit> {
    if (live.value) return prepareLiveOpenOrders()
    return prepareList<OrderItem>('open', async (symbol) => {
      const data = await orderApi.fetchOpenOrders({ symbol, page: openPage.value, pageSize: PAGE_SIZE, side: sideFilter.value })
      return { rows: data.orderList ?? [], count: data.count ?? 0 }
    }, (rows, count) => {
      openOrders.value = withInflight(rows)
      openCount.value = count + [...inflight.values()].filter((row) => !rows.some((entry) => entry.id === row.id)).length
    })
  }

  /** Live mode: `/api/v3/openOrders?symbol=` (core memory) replaces the map of the current pair. */
  function prepareLiveOpenOrders(): Promise<Commit> {
    return prepareList<SpotV3Order>('open', async (symbol) => {
      const rows = await fetchSpotOpenOrders(v3Symbol(symbol))
      return { rows, count: rows.length }
    }, (rows) => resyncLiveOrders(rows))
  }

  /** Stream resync: the snapshot of the current pair's open orders becomes the live map. */
  function resyncLiveOrders(rows: readonly SpotV3Order[]): void {
    const symbol = requireSymbol()
    liveOrders.clear()
    if (symbol !== null) {
      const wanted = v3Symbol(symbol)
      for (const order of rows) {
        if (isMarginOrder(order)) continue
        const row = orderFromV3(order)
        if (row.v3Symbol === wanted && isOpenStatus(row.status)) liveOrders.set(row.id, row)
      }
    }
    renderLive()
    setFlag(loaded, 'open', true)
    setError('open', null)
  }

  /** Live map → the current page (side filter, newest first) plus optimistic rows still in flight. */
  function renderLive(): void {
    const side = sideFilter.value
    const all = [...liveOrders.values()].filter((row) => side === '' || row.side === side).sort(compareOpenRows)
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
    if (openPage.value > pages) openPage.value = pages
    const start = (openPage.value - 1) * PAGE_SIZE
    const page = all.slice(start, start + PAGE_SIZE)
    openOrders.value = withInflight(page)
    openCount.value = all.length + [...inflight.values()].filter((row) => !liveOrders.has(row.id)).length
  }

  function noteFinal(id: string): void {
    finalIds.set(id, Date.now())
    if (finalIds.size > 500) {
      const cutoff = Date.now() - 120_000
      for (const [key, at] of finalIds) if (at < cutoff) finalIds.delete(key)
    }
  }

  /**
   * One `executionReport` (already mapped). Updates 当前委托 of the current pair (open → upsert, otherwise removed),
   * swaps an optimistic row for the real one (matched by `clientOrderId`) and queues the order's optimistic balance
   * move to be dropped on the next balance event. Returns true when the row belongs to the current pair.
   */
  function applyOrderEvent(row: SpotOrderRow): boolean {
    const open = isOpenStatus(row.status)
    // Order holds: matched by our client id or (once the reply gave it) the order id; cancel holds: by the final event.
    // A cancel's hold waits for the order's final state (PENDING_CANCEL does not unfreeze yet).
    const final = row.status === 2 || row.status === 4 || row.status === 6
    for (const key of [row.clientOrderId === undefined ? '' : `c:${row.clientOrderId}`, `n:${row.id}`, final ? `o:${row.id}` : '']) {
      const hold = key === '' ? undefined : liveHolds.get(key)
      if (hold !== undefined) {
        clearTimeout(hold.timer)
        for (const alias of hold.keys) liveHolds.delete(alias)
        releaseOnBalance.push(hold.handle)
      }
    }
    if (!open) noteFinal(row.id)
    const symbol = requireSymbol()
    if (!live.value || symbol === null || row.v3Symbol !== v3Symbol(symbol)) return false
    if (row.clientOrderId !== undefined) {
      for (const [id, temp] of inflight) {
        if (temp.clientOrderId === row.clientOrderId) inflight.delete(id)
      }
    }
    // A fill racing an accepted cancel must not bring the row back (it is on its way out).
    if (open && !finalIds.has(row.id)) liveOrders.set(row.id, row)
    else liveOrders.delete(row.id)
    renderLive()
    return true
  }

  /** After an authoritative balance read: drop estimates whose order event was seen. */
  function balanceApplied(): void {
    for (const handle of releaseOnBalance.splice(0)) handle.rollback()
  }

  /** Optimistic move kept until a read after the stream notification confirms it. */
  function holdLive(keys: string[], handle: OverlayHandle | null): void {
    if (handle === null) return
    for (const key of keys) {
      const previous = liveHolds.get(key)
      if (previous !== undefined) { clearTimeout(previous.timer); previous.handle.rollback(); for (const alias of previous.keys) liveHolds.delete(alias) }
    }
    const hold: LiveHold = { handle, keys, timer: setTimeout(() => {
      for (const alias of keys) liveHolds.delete(alias)
      handle.rollback()
    }, LIVE_HOLD_MS) }
    for (const key of keys) liveHolds.set(key, hold)
  }

  function aliasHold(key: string, alias: string): void {
    const hold = liveHolds.get(key)
    if (hold === undefined) return
    hold.keys.push(alias)
    liveHolds.set(alias, hold)
  }

  function dropLiveHolds(): void {
    for (const hold of new Set(liveHolds.values())) { clearTimeout(hold.timer); hold.handle.rollback() }
    liveHolds.clear()
    for (const handle of releaseOnBalance.splice(0)) handle.rollback()
  }

  /** Stream up / down (`spot-live.ts`). Down: the classic list takes over at once. */
  function setLive(on: boolean): void {
    if (live.value === on) return
    live.value = on
    if (!on) {
      liveOrders.clear()
      dropLiveHolds()
      if (session.isAuthenticated()) void refreshAfterAction('open', 'account')
    }
  }

  function prepareHistoryOrders(): Promise<Commit> {
    return prepareList<OrderItem>('history', async (symbol) => {
      const data = await orderApi.fetchHistoryOrders({
        symbol,
        page: historyPage.value,
        pageSize: PAGE_SIZE,
        side: sideFilter.value,
        isShowCanceled: showCanceled.value ? 1 : 0,
      })
      return { rows: data.orderList ?? [], count: data.count ?? 0 }
    }, (rows, count) => {
      historyOrders.value = mergeById(historyOrders.value, rows, orderKey)
      historyCount.value = count
    })
  }

  function prepareMyTrades(): Promise<Commit> {
    return prepareList<TradeItem>('trades', async (symbol) => {
      const data = await orderApi.fetchMyTrades({ symbol, page: tradesPage.value, pageSize: PAGE_SIZE })
      return { rows: data.trade_list ?? [], count: data.count ?? 0 }
    }, (rows, count) => {
      myTrades.value = mergeById(myTrades.value, rows, tradeKey)
      tradesCount.value = count
    })
  }

  async function loadOpenOrders(): Promise<void> {
    ;(await prepareOpenOrders())?.()
  }

  async function loadHistoryOrders(): Promise<void> {
    ;(await prepareHistoryOrders())?.()
  }

  async function loadMyTrades(): Promise<void> {
    ;(await prepareMyTrades())?.()
  }

  async function refreshAll(): Promise<void> {
    commitAll(await Promise.all([prepareOpenOrders(), prepareHistoryOrders(), prepareMyTrades()]))
  }

  /** The single refresh after an order action (coalesced with any other action inside the same window). */
  function refreshAfterAction(...parts: SpotRefreshPart[]): Promise<void> {
    return refresher.request(...parts)
  }

  /** What a resting order holds: quote (price × remaining) for a buy, base (remaining) for a sell; `null` if unknown. */
  function heldBy(order: { side?: string; type?: number | string; price?: string; volume?: string; deal_volume?: string }): { coin: 'base' | 'quote'; amount: string } | null {
    const volume = order.volume ?? ''
    const dealt = order.deal_volume ?? '0'
    const remaining = isDecimalString(volume) && isDecimalString(dealt) ? sub(volume, dealt) : ''
    if (remaining === '' || remaining.startsWith('-')) return null
    const buy = (order.side ?? '').toUpperCase() === 'BUY'
    if (String(order.type) === '2') return buy && isDecimalString(volume) ? { coin: 'quote', amount: volume } : buy ? null : { coin: 'base', amount: remaining }
    if (!buy) return { coin: 'base', amount: remaining }
    return isDecimalString(order.price ?? '') ? { coin: 'quote', amount: mul(order.price as string, remaining) } : null
  }

  function coinOf(which: 'base' | 'quote'): string {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : which === 'base' ? symbol.base : symbol.quote
  }

  /** True for an IOC / FOK limit order: it never rests, so it gets no optimistic 当前委托 row. */
  function immediate(payload: SpotOrderPayload): boolean {
    return payload.type === '1' && payload.timeInForce !== undefined && payload.timeInForce !== 'GTC'
  }

  /**
   * Sends the order: `/api/v3/order` when available (IOC / FOK only there), else the classic `order/create`. A "not
   * here" answer from `/api/v3` (404, HTML, API-key-only gateway) turns it off for a while and the same order goes the
   * classic way (nothing was placed). Returns the new order id when the server gave one.
   */
  async function routeOrder(symbol: string, payload: SpotOrderPayload, clientId: string): Promise<{ id: string | null; v3: SpotV3Order | null }> {
    const params = spotV3Enabled() ? spotOrderParams(symbol, payload, clientId) : null
    if (params !== null) {
      try {
        const reply = await placeSpotOrder(params)
        v3Available.value = true
        return { id: reply?.orderId === undefined ? null : String(reply.orderId), v3: reply ?? null }
      } catch (error_) {
        if (!isSpotV3Unavailable(error_)) throw error_
        markSpotV3Unavailable()
        v3Available.value = false
      }
    }
    if (immediate(payload)) throw new Error(IOC_UNAVAILABLE)
    const data = await orderApi.createOrder({ symbol, side: payload.side, type: payload.type, volume: payload.volume, price: payload.price })
    return { id: createdOrderId(data), v3: null }
  }

  /**
   * Places an order with decimal strings exactly as validated.
   * Returns `true` only when the server accepted it; any failure is surfaced verbatim (`submitError`).
   * A resting limit order shows up in 当前委托 immediately (pending) and the available balance drops at once; both are
   * rolled back if the server refuses. Classic mode: reconciled by the one refresh that follows success. Live mode
   * (stream): the order's `executionReport` replaces the pending row and the next balance event replaces the estimate;
   * no refresh is requested.
   */
  async function submitOrder(payload: SpotOrderPayload): Promise<boolean> {
    if (!session.isAuthenticated()) {
      submitError.value = 'common.notLoggedIn'
      return false
    }
    if (submitting.value) {
      submitError.value = 'error.submitting'
      return false
    }
    const token = session.getToken()
    const symbol = requireSymbol()
    if (symbol === null) {
      submitError.value = 'error.symbolMissing'
      return false
    }
    if (immediate(payload) && !spotV3Enabled()) {
      submitError.value = IOC_UNAVAILABLE
      return false
    }
    submitting.value = true
    submitError.value = null
    lastPlaced.value = null
    const clientId = newClientOrderId()

    const temp: OpenOrderRow | null = payload.type === '1' && !immediate(payload) && (sideFilter.value === '' || sideFilter.value === payload.side)
      ? { id: pendingId(), side: payload.side, type: 1, status: 0, price: payload.price, volume: payload.volume, deal_volume: '0', created_at: utcTimestamp(), pending: true, clientOrderId: clientId }
      : null
    if (temp !== null) {
      inflight.set(temp.id, temp)
      if (openPage.value === 1) openOrders.value = [temp, ...openOrders.value]
      openCount.value += 1
    }
    const held = heldBy({ side: payload.side, type: payload.type, price: payload.price, volume: payload.volume, deal_volume: '0' })
    const coin = held === null ? '' : coinOf(held.coin)
    const reservation = held === null || coin === '' ? null : account.reserve(coin, held.amount)
    const liveAtStart = live.value
    // Live: the estimate waits for the stream (its events may arrive before this request's reply).
    if (liveAtStart) holdLive([`c:${clientId}`], reservation)

    const dropTemp = (): void => {
      if (temp === null || !inflight.delete(temp.id)) return
      if (openOrders.value.some((row) => row.id === temp.id)) openOrders.value = openOrders.value.filter((row) => row.id !== temp.id)
      openCount.value = Math.max(0, openCount.value - 1)
    }
    try {
      const placed = await routeOrder(symbol, payload, clientId)
      lastPlaced.value = { id: placed.id, symbol, v3: placed.v3 }
      const current = token === session.getToken() && symbol === requireSymbol()
      if (live.value && liveAtStart && current) {
        // The stream owns 当前委托 and balances: the reply only fills in a row its event has not delivered yet.
        if (temp !== null) inflight.delete(temp.id)
        if (placed.v3 !== null && placed.id !== null && !finalIds.has(placed.id) && !liveOrders.has(placed.id) && payload.type === '1' && !immediate(payload)) {
          const row = orderFromV3(placed.v3)
          if (isOpenStatus(row.status)) liveOrders.set(row.id, row)
        }
        renderLive()
        // The hold (registered before sending) is released by the order's event + the next balance event; the order
        // id becomes a second key for an event that carries no client id.
        if (placed.id !== null) aliasHold(`c:${clientId}`, `n:${placed.id}`)
        return true
      }
      if (temp !== null && inflight.delete(temp.id)) {
        // Confirmed: the row stops being "pending"; it carries the real id when the server returned one.
        const confirmed: OpenOrderRow = { ...temp, id: placed.id ?? temp.id, pending: false }
        openOrders.value = openOrders.value.map((row) => (row.id === temp.id ? confirmed : row))
      }
      reservation?.settle()
      if (current) void refreshAfterAction('open', 'trades', 'account')
      // Placed: true even when the pair / session changed meanwhile, so the form still confirms it (10-01 audit:
      // an order placed after a pair switch got no feedback at all).
      return true
    } catch (error_) {
      dropTemp()
      reservation?.rollback()
      if (live.value) renderLive()
      if (token !== session.getToken()) return false
      if (isOrderResultUnknown(error_) || isSpotV3ResultUnknown(error_)) {
        // The order may exist (timed out after sending): say so, never retry, and re-read 当前委托 + balances while
        // `submitting` still blocks the button so a double click cannot place it twice (2026-10-01).
        submitError.value = orderUnconfirmedText(requestLanguage())
        await guardedRefresh(() => refreshAfterAction('open', 'account'))
        return false
      }
      submitError.value = error_ instanceof Error && error_.message === IOC_UNAVAILABLE ? IOC_UNAVAILABLE : describe(error_)
      return false
    } finally {
      submitting.value = false
    }
  }

  /**
   * Cancels one order. The row reads 撤单中 while the request runs and leaves the list as soon as the server confirms
   * (its held balance is released at once); the refresh that follows re-reads the truth. On failure the row stays and
   * `cancelError` carries the reason.
   */
  function staleCancel(error_: unknown): boolean {
    if (isApiError(error_) && (error_.code === '-2011' || error_.code === '-2013')) return true
    const text = error_ instanceof Error ? error_.message : String(error_ ?? '')
    return /不能取消|没有查询到订单|cannot be cancel|not exist/i.test(text)
  }

  /** `DELETE /api/v3/order` when available, else the classic `order/cancel`. */
  async function routeCancel(symbol: string, orderId: string): Promise<void> {
    if (spotV3Enabled()) {
      try {
        await cancelSpotOrder(v3Symbol(symbol), orderId)
        v3Available.value = true
        return
      } catch (error_) {
        if (!isSpotV3Unavailable(error_)) throw error_
        markSpotV3Unavailable()
        v3Available.value = false
      }
    }
    await orderApi.cancelOrder({ orderId, symbol })
  }

  async function cancelOrder(orderId: string, options: { quiet?: boolean } = {}): Promise<boolean> {
    // Every refusal to start has a reason the caller can show (10-01 audit: a stale error was re-toasted, or nothing).
    const refuse = (key: string): boolean => {
      // An i18n key (error.* / common.*): the caller translates it, like submitError.
      cancelError.value = key
      return false
    }
    if (!session.isAuthenticated()) return refuse('common.notLoggedIn')
    if (cancelingIds.value.has(orderId)) return refuse('error.busy')
    if (isPendingId(orderId)) return refuse('error.submitting')
    const token = session.getToken()
    const symbol = requireSymbol()
    if (symbol === null) return refuse('error.symbolMissing')
    cancelingId.value = orderId
    cancelingIds.value = new Set([...cancelingIds.value, orderId])
    cancelError.value = null
    // Live: the release estimate is made before sending, so a CANCELED event that beats the reply still drops it.
    const liveAtStart = live.value
    let release: OverlayHandle | null = null
    const estimate = (): OverlayHandle | null => {
      const row = live.value ? liveOrders.get(orderId) : openOrders.value.find((entry) => entry.id === orderId)
      const held = row === undefined ? null : heldBy(row)
      const coin = held === null ? '' : coinOf(held.coin)
      return held !== null && coin !== '' ? account.reserve(coin, `-${held.amount}`) : null
    }
    if (liveAtStart) {
      release = estimate()
      holdLive([`o:${orderId}`], release)
    }
    try {
      await routeCancel(symbol, orderId)
      const current = token === session.getToken() && symbol === requireSymbol()
      // Cancelled even if the pair / session changed meanwhile: report it as done.
      if (!current) return true
      const row = live.value ? liveOrders.get(orderId) : openOrders.value.find((entry) => entry.id === orderId)
      if (!liveAtStart) release = estimate()
      if (live.value && liveAtStart) {
        // Accepted (PENDING_CANCEL): the row leaves now; the funds unfreeze with the CANCELED event + balance event.
        liveOrders.delete(orderId)
        noteFinal(orderId)
        renderLive()
        if (!options.quiet) void refreshAfterAction('history')
        return true
      }
      if (row !== undefined) {
        openOrders.value = openOrders.value.filter((entry) => entry.id !== orderId)
        openCount.value = Math.max(0, openCount.value - 1)
      }
      release?.settle()
      if (!options.quiet) void refreshAfterAction('open', 'history', 'account')
      return true
    } catch (error_) {
      release?.rollback()
      if (token === session.getToken()) {
        // Most cancel refusals mean the list is stale: the order was already filled or cancelled
        // (server: 订单状态不能取消 / 没有查询到订单 / -2011). Say so and re-read, so the row does not linger.
        cancelError.value = staleCancel(error_) ? i18n.global.t('orderDisplay.thisOrderWasFilledOrCancelledTheListHas') : describe(error_)
        void refreshAfterAction('open', 'history', 'trades', 'account')
      }
      return false
    } finally {
      const next = new Set(cancelingIds.value)
      next.delete(orderId)
      cancelingIds.value = next
      if (cancelingId.value === orderId) cancelingId.value = null
    }
  }

  /**
   * Cancels every open order of the current pair (Binance 「全部撤单」): one bulk `/api/v3` call, or (classic path)
   * per-order cancels of the rows known here (all live rows in stream mode, the shown page otherwise). Returns how
   * many were cancelled and how many failed; `cancelError` = the first reason.
   */
  async function cancelAll(): Promise<{ cancelled: number; failed: number }> {
    if (!session.isAuthenticated()) { cancelError.value = 'common.notLoggedIn'; return { cancelled: 0, failed: 0 } }
    if (cancelingAll.value) { cancelError.value = 'error.busy'; return { cancelled: 0, failed: 0 } }
    const symbol = requireSymbol()
    if (symbol === null) { cancelError.value = 'error.symbolMissing'; return { cancelled: 0, failed: 0 } }
    cancelingAll.value = true
    cancelError.value = null
    try {
      if (SPOT_V3_BULK_CANCEL && spotV3Enabled()) {
        // Counted before sending: the stream may already remove rows while the request runs.
        const n = live.value ? liveOrders.size : openOrders.value.filter((row) => !isPendingId(row.id)).length
        try {
          await cancelAllSpotOrders(v3Symbol(symbol))
          if (live.value) { for (const id of liveOrders.keys()) noteFinal(id); liveOrders.clear(); renderLive() }
          void refreshAfterAction(...(live.value ? (['history'] as const) : (['open', 'history', 'account'] as const)))
          return { cancelled: n, failed: 0 }
        } catch (error_) {
          if (!isSpotV3Unavailable(error_)) { cancelError.value = describe(error_); return { cancelled: 0, failed: 1 } }
          markSpotV3Unavailable()
          v3Available.value = false
        }
      }
      const ids = (live.value ? [...liveOrders.values()] : openOrders.value).map((row) => row.id).filter((id) => !isPendingId(id))
      let cancelled = 0
      let failed = 0
      let firstError: string | null = null
      // A few at a time: fast, and well inside the per-uid order weight.
      for (let index = 0; index < ids.length; index += 5) {
        const results = await Promise.all(ids.slice(index, index + 5).map(async (id) => {
          const ok = await cancelOrder(id, { quiet: true })
          if (!ok && firstError === null) firstError = cancelError.value
          return ok
        }))
        cancelled += results.filter(Boolean).length
        failed += results.filter((ok) => !ok).length
      }
      cancelError.value = firstError
      void refreshAfterAction(...(live.value ? (['history'] as const) : (['open', 'history', 'account'] as const)))
      return { cancelled, failed }
    } finally {
      cancelingAll.value = false
    }
  }

  function setSideFilter(side: OrderSideFilter): void {
    sideFilter.value = side
    openPage.value = 1
    historyPage.value = 1
    if (live.value) renderLive()
  }

  function setShowCanceled(value: boolean): void {
    showCanceled.value = value
    historyPage.value = 1
  }

  function setPage(tab: ListKind, page: number): void {
    if (tab === 'open') {
      openPage.value = page
      if (live.value) renderLive()
    } else if (tab === 'history') {
      historyPage.value = page
    } else {
      tradesPage.value = page
    }
  }

  function reset(): void {
    requestVersions.open += 1
    requestVersions.history += 1
    requestVersions.trades += 1
    refresher.cancel()
    inflight.clear()
    liveOrders.clear()
    dropLiveHolds()
    loading.value = { open: false, history: false, trades: false }
    loaded.value = { open: false, history: false, trades: false }
    errors.value = { open: null, history: null, trades: null }
    openOrders.value = []
    historyOrders.value = []
    myTrades.value = []
    openCount.value = 0
    historyCount.value = 0
    tradesCount.value = 0
    openPage.value = 1
    historyPage.value = 1
    tradesPage.value = 1
    submitError.value = null
    lastPlaced.value = null
    cancelError.value = null
    cancelingIds.value = new Set()
    cancelingId.value = null
    cancelingAll.value = false
  }

  return {
    openOrders,
    historyOrders,
    myTrades,
    openCount,
    historyCount,
    tradesCount,
    openPage,
    historyPage,
    tradesPage,
    sideFilter,
    showCanceled,
    pageSize: PAGE_SIZE,
    loading,
    loaded,
    errors,
    submitting,
    submitError,
    lastPlaced,
    cancelingId,
    cancelingIds,
    cancelError,
    cancelingAll,
    live,
    v3Available,
    loadOpenOrders,
    loadHistoryOrders,
    loadMyTrades,
    refreshAll,
    refreshAfterAction,
    submitOrder,
    cancelOrder,
    cancelAll,
    setLive,
    resyncLiveOrders,
    applyOrderEvent,
    balanceApplied,
    setSideFilter,
    setShowCanceled,
    setPage,
    reset,
  }
})

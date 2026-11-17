import { defineStore } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'
import { session } from '@/core/session'
import { createCoalescedRefresh } from '@/core/swr'
import { showToast } from '@/core/toast'
import { i18n } from '@/i18n'
import { cmp, groupDigits, isDecimalString, toFixedString } from '@/modules/finance/decimal'
import { UserStream, type SocketLike, type UserStreamEvent, type UserStreamStatus } from '@/modules/futures/user-stream'
import { createSpotListenKey, fetchSpotOpenOrders, keepAliveSpotListenKey, SPOT_USER_WS_URL } from '@/modules/spot/spot-api'
import { spotV3Enabled } from '@/modules/spot/spot-order'
import { fillNotice, isMarginOrder, orderFromEvent, v3Symbol, type ExecutionReport, type SpotFillNotice } from '@/modules/spot/spot-stream-model'
import { useAccountStore } from './account'
import { useMarketStore } from './market'
import { useOrdersStore } from './orders'

/** Resync retries while the socket is open but the snapshots failed (meanwhile the classic poll keeps the page right). */
const RESYNC_RETRY_MS = [3_000, 10_000, 30_000]
/** Safety snapshot while live (visible tab): with open orders on the pair / without. Core memory, not Java. */
export const SAFETY_OPEN_MS = 120_000
export const SAFETY_IDLE_MS = 300_000
/** Fills / cancels re-read the (classic) history and fills lists once per burst. */
const LISTS_DEBOUNCE_MS = 1_000

/** QA 10-26 待确认-006: wait this long after a crossing public trade for the order's own event before re-reading. */
export const CROSS_CHECK_MS = 1_500
/** At most one crossing re-read per this window. */
export const CROSS_MIN_GAP_MS = 10_000

/**
 * Whether a public trade at `price` reached one of our resting limit orders (a SELL at or below it, a BUY at or above
 * it). The maker's own `executionReport` normally arrives first; when it is missed (half-open socket, gateway
 * hiccup), 当前委托 would keep a filled order until the 2-min safety snapshot (QA 10-26 待确认-006: order 26043555
 * shown open after it filled at 3998). Exact decimal compare.
 */
export function tradeCrossesOpen(rows: ReadonlyArray<{ side: string; type: number; price?: string; pending?: boolean }>, price: string): boolean {
  if (!isDecimalString(price)) return false
  return rows.some((row) => {
    if (row.pending === true || row.type !== 1 || row.price === undefined || !isDecimalString(row.price)) return false
    const c = cmp(row.price, price)
    return row.side === 'SELL' ? c <= 0 : row.side === 'BUY' ? c >= 0 : false
  })
}

/**
 * Spot user data stream → spot trade-page stores (2026-10-02; fgw `/api/v3/userDataStream` + `wss://…/spot/ws/<key>`,
 * reference docs/03-reference/api/spot-v3.md). Same lifecycle class as the futures stream (`UserStream`: listenKey
 * POST on every connect, PUT every 30 min, `-1125` → re-POST, backoff 1…30 s, 25 s text heartbeat, hidden 5 min →
 * paused).
 *
 * - Every open: one exact core-backed classic balance read + `/api/v3/openOrders?symbol=`; buffered order events
 *   are replayed, balance events only request a fresh read. Reconnect also refreshes history / fills.
 * - Live (`orders.live` / `account.live`): `executionReport` → 当前委托 of the current pair at once, fills → 「订单已成交」
 *   toast (any pair) + one debounced re-read of history / fills; `outboundAccountPosition` → coalesced REST read. The
 *   5 s classic poll of TradeView stops; only a safety snapshot runs (2 / 5 min).
 * - Socket down / resync failed → not live: the classic poll and refreshes take over (no dead end).
 * - Sign-out / account switch / leaving the page → stop. The listenKey is never DELETEd (one per uid, shared with the
 *   user's API-key clients); it lapses 60 min after the last keepalive.
 */
export const useSpotLiveStore = defineStore('spot-live', () => {
  const orders = useOrdersStore()
  const account = useAccountStore()
  const market = useMarketStore()
  const status = ref<UserStreamStatus>('idle')
  const lastEventAt = ref<number | null>(null)
  const resyncs = ref(0)

  let stream: UserStream | null = null
  let streamToken: string | null = null
  let streamUid = session.getUser()?.id
  let resyncing = false
  let resyncEpoch = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  let listsTimer: ReturnType<typeof setTimeout> | null = null
  const listsPending = new Set<'history' | 'trades'>()
  const buffered: UserStreamEvent[] = []
  // User events are dirty notifications only. A late/duplicated WS payload can
  // never overwrite a newer authoritative REST quantity. Bursts share one read
  // and at most one queued trailing run, bound to the current stream identity.
  const balanceRefresh = createCoalescedRefresh<'account'>(async () => {
    const token = streamToken
    const owner = stream
    const uid = streamUid
    if (owner === null || token === null || token !== session.getToken()) return
    await account.refresh()
    if (owner !== stream || token !== streamToken || token !== session.getToken() || uid !== streamUid) return
    if (account.data !== null && account.error === null) orders.balanceApplied()
    else {
      // A failed authoritative read stays unknown. Re-enable fallback polling
      // and use the existing bounded resync retries instead of waiting minutes.
      setLive(false)
      if (owner.isOpen) void resync(false)
    }
  })

  // QA 10-26 待确认-006: a public trade through one of our resting orders without its executionReport → re-read 当前委托
  let crossTimer: ReturnType<typeof setTimeout> | null = null
  let lastCrossAt = 0
  watch(() => market.trades[0], (tick) => {
    if (tick === undefined || crossTimer !== null || !orders.live || stream?.isOpen !== true) return
    if (Date.now() - lastCrossAt < CROSS_MIN_GAP_MS || !tradeCrossesOpen(orders.openOrders, String(tick.price))) return
    const price = String(tick.price)
    crossTimer = setTimeout(() => {
      crossTimer = null
      // still showing an order the trade went through: the event was missed
      if (!orders.live || stream?.isOpen !== true || resyncing || !tradeCrossesOpen(orders.openOrders, price)) return
      lastCrossAt = Date.now()
      void resync(false, 0, true)
    }, CROSS_CHECK_MS)
  })

  onScopeDispose(session.onInvalidate((snapshot) => {
    if (stream !== null && (snapshot.token !== streamToken || (streamUid !== undefined && snapshot.user?.id !== streamUid))) stop()
    streamUid = snapshot.user?.id
  }))

  function setLive(on: boolean): void {
    orders.setLive(on)
    account.setLive(on)
    if (on) armSafety()
    else clearSafety()
  }

  function start(): void {
    if (stream !== null || !session.isAuthenticated() || !spotV3Enabled()) return
    streamToken = session.getToken()
    streamUid = session.getUser()?.id
    stream = new UserStream({
      createKey: createSpotListenKey,
      keepAlive: keepAliveSpotListenKey,
      // Never DELETE: the one listenKey per uid is shared with the user's API-key clients (spot-v3.md §1.1).
      closeKey: async () => undefined,
      wsBase: SPOT_USER_WS_URL,
      socket: (url) => new WebSocket(url) as unknown as SocketLike,
      visibility: typeof document !== 'undefined' ? document : null,
    }, {
      onEvent: receive,
      onOpen: ({ reconnect }) => { void resync(reconnect) },
      onStatus: (next) => {
        status.value = next
        if (next !== 'open') {
          resyncEpoch += 1
          resyncing = false
          buffered.length = 0
          clearRetry()
          setLive(false)
        }
      },
    })
    stream.start()
  }

  function stop(): void {
    balanceRefresh.cancel()
    if (crossTimer !== null) clearTimeout(crossTimer)
    crossTimer = null
    clearRetry()
    clearSafety()
    if (listsTimer !== null) clearTimeout(listsTimer)
    listsTimer = null
    listsPending.clear()
    resyncEpoch += 1
    resyncing = false
    buffered.length = 0
    stream?.stop()
    stream = null
    streamToken = null
    status.value = 'idle'
    setLive(false)
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }

  function clearSafety(): void {
    if (safetyTimer !== null) clearTimeout(safetyTimer)
    safetyTimer = null
  }

  /** Next safety snapshot: sooner while orders rest on the pair (a missed event there matters most). */
  function armSafety(): void {
    clearSafety()
    const delay = orders.openCount > 0 ? SAFETY_OPEN_MS : SAFETY_IDLE_MS
    safetyTimer = setTimeout(() => {
      safetyTimer = null
      if (stream?.isOpen !== true || !orders.live) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') { armSafety(); return }
      void resync(false, 0, true)
    }, delay)
  }

  /** Rebuild from snapshots (first open and after every reconnect: the stream has no replay). */
  async function resync(reconnect: boolean, attempt = 0, safety = false): Promise<void> {
    clearRetry()
    const epoch = ++resyncEpoch
    resyncing = true
    const symbol = market.currentSymbolName
    try {
      const [, open] = await Promise.all([account.load(), symbol === '' ? Promise.resolve([]) : fetchSpotOpenOrders(v3Symbol(symbol))])
      if (epoch !== resyncEpoch) return
      if (account.data === null || account.error !== null) throw new Error(i18n.global.t('clientFailure.accountSnapshotUnavailable'))
      if (!orders.live) setLive(true)
      // The pair changed meanwhile: its 当前委托 is read by the orders panel's own load for the new pair.
      if (symbol === market.currentSymbolName) orders.resyncLiveOrders(open)
      orders.balanceApplied()
      resyncing = false
      buffered.splice(0).forEach(dispatch)
      resyncs.value += 1
      if (reconnect) refreshLists('history', 'trades')
      armSafety()
    } catch {
      if (epoch !== resyncEpoch) return
      resyncing = false
      buffered.length = 0
      if (safety) { armSafety(); return }
      setLive(false)
      const delay = RESYNC_RETRY_MS[Math.min(attempt, RESYNC_RETRY_MS.length - 1)] ?? 30_000
      retryTimer = setTimeout(() => { if (stream?.isOpen === true) void resync(reconnect, attempt + 1) }, delay)
    }
  }

  function receive(event: UserStreamEvent): void {
    lastEventAt.value = Date.now()
    if (resyncing) {
      buffered.push(event)
      return
    }
    if (!orders.live) return
    dispatch(event)
  }

  function dispatch(event: UserStreamEvent): void {
    switch (event.e) {
      case 'executionReport': {
        const report = event as unknown as ExecutionReport
        if (isMarginOrder(report)) return
        const row = orderFromEvent(report)
        const onPair = orders.applyOrderEvent(row)
        const fill = fillNotice(report)
        if (fill !== null) toastFill(fill)
        if (onPair && fill !== null) refreshLists('trades', ...(fill.complete ? (['history'] as const) : []))
        else if (onPair && (row.status === 4 || row.status === 6)) refreshLists('history')
        break
      }
      case 'outboundAccountPosition': {
        void balanceRefresh.request('account')
        break
      }
      default:
        break
    }
  }

  /** History / fills come from the classic lists: one re-read per burst of events. */
  function refreshLists(...parts: Array<'history' | 'trades'>): void {
    for (const part of parts) listsPending.add(part)
    if (listsTimer !== null) return
    listsTimer = setTimeout(() => {
      listsTimer = null
      const next = [...listsPending]
      listsPending.clear()
      if (next.length > 0 && session.isAuthenticated()) void orders.refreshAfterAction(...next)
    }, LISTS_DEBOUNCE_MS)
  }

  /** Binance-style fill notice; one toast per order (later partial fills of the same order replace it). */
  function toastFill(fill: SpotFillNotice): void {
    const t = i18n.global.t
    const info = market.symbols.find((entry) => v3Symbol(entry.symbol) === fill.v3Symbol)
    const dp = info?.pricePrecision ?? 8
    const price = fill.avgPrice === '' ? '--' : groupDigits(toFixedString(fill.avgPrice, dp), dp)
    const qty = groupDigits(fill.filled, null)
    const message = t(fill.complete ? 'trade.fill.filled' : 'trade.fill.partFilled', {
      type: t(fill.market ? 'trade.fill.market' : 'trade.fill.limit'),
      side: t(fill.side === 'BUY' ? 'trade.fill.buy' : 'trade.fill.sell'),
      symbol: info?.showPair ?? fill.v3Symbol,
      qty,
      base: info?.base ?? '',
      price,
    })
    showToast(message, 'success', { key: `spot-fill:${fill.orderId}`, timeout: 4000 })
  }

  return { status, lastEventAt, resyncs, start, stop, reconnectNow: () => stream?.reconnectNow() }
})

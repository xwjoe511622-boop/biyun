import { defineStore } from 'pinia'
import { onScopeDispose, ref } from 'vue'
import { session } from '@/core/session'
import { showToast } from '@/core/toast'
import { i18n } from '@/i18n'
import { groupDigits, toFixedString } from '@/modules/finance/decimal'
import { FUTURES_USER_WS_URL } from '@/modules/futures/endpoints'
import { closeListenKey, createListenKey, fetchFapiAccount, fetchOpenOrders, fetchPositionRisk, keepAliveListenKey } from '@/modules/futures/fapi'
import { ensureFuturesMessages } from '@/modules/futures/i18n'
import type { FillNotice, StreamAccountUpdate, StreamOrder } from '@/modules/futures/stream-model'
import { UserStream, type SocketLike, type UserStreamEvent, type UserStreamStatus } from '@/modules/futures/user-stream'
import { useFuturesAccountStore } from './futures-account'
import { useFuturesOrdersStore } from './futures-orders'

/** Resync retries while the socket is open but the snapshots failed (then the legacy poll keeps the page right). */
const RESYNC_RETRY_MS = [3_000, 10_000, 30_000]

/**
 * Futures user data stream → futures stores (2026-10-01; contract docs/04-design/futures-user-stream.md).
 *
 * - `start()` after sign-in on the futures page: listenKey + socket (`UserStream`), on every open a resync from the
 *   `/fapi` snapshots (account, positionRisk, openOrders); events that arrive during a resync are applied after it.
 * - While live (`account.live`): ORDER_TRADE_UPDATE → open orders (+ 「订单已成交」 toast, fills / history lists
 *   re-read if opened), ACCOUNT_UPDATE → positions and balances at once + one snapshot reconcile,
 *   ACCOUNT_CONFIG_UPDATE → leverage, MARGIN_CALL → warning toast. Only a 60 s safety snapshot is polled.
 * - Socket down / resync failed → `account.live` false: the legacy 5 s `get_assets_list` poll takes over until the next
 *   successful resync (no dead end when the stream is unavailable).
 * - Sign-out / account switch → stop (the listenKey is closed with the old session's token).
 */
export const useFuturesLiveStore = defineStore('futures-live', () => {
  const account = useFuturesAccountStore()
  const orders = useFuturesOrdersStore()
  const status = ref<UserStreamStatus>('idle')
  const lastEventAt = ref<number | null>(null)
  /** Completed resyncs (first open included). */
  const resyncs = ref(0)

  let stream: UserStream | null = null
  let streamToken: string | null = null
  let resyncing = false
  let resyncEpoch = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const buffered: UserStreamEvent[] = []

  onScopeDispose(session.onInvalidate((snapshot) => {
    if (stream !== null && snapshot.token !== streamToken) stop({ logout: true })
  }))

  function start(): void {
    if (stream !== null || !session.isAuthenticated()) return
    streamToken = session.getToken()
    const token = streamToken ?? undefined
    stream = new UserStream({
      createKey: createListenKey,
      keepAlive: keepAliveListenKey,
      closeKey: () => closeListenKey(token),
      wsBase: FUTURES_USER_WS_URL,
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
          account.setLive(false)
        }
      },
    })
    stream.start()
  }

  function stop(options: { logout?: boolean } = {}): void {
    clearRetry()
    resyncEpoch += 1
    resyncing = false
    buffered.length = 0
    stream?.stop(options)
    stream = null
    streamToken = null
    status.value = 'idle'
    account.setLive(false)
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }

  /** Rebuild from snapshots (first open and after every reconnect: the stream has no replay). */
  async function resync(reconnect: boolean, attempt = 0): Promise<void> {
    clearRetry()
    const epoch = ++resyncEpoch
    resyncing = true
    try {
      const [fapiAccount, risk, open] = await Promise.all([fetchFapiAccount(), fetchPositionRisk(), fetchOpenOrders()])
      if (epoch !== resyncEpoch) return
      // Live first: 当前委托 is rebuilt from the map only in live mode.
      account.setLive(true)
      orders.resyncOpenOrders(open)
      account.commitLiveSnapshot(fapiAccount, risk)
      account.markSynced()
      resyncing = false
      const pending = buffered.splice(0)
      pending.forEach(dispatch)
      resyncs.value += 1
      // Legacy-only fields once (ids of positions opened while away, realized PnL, fees, TP/SL), never sooner than its gap.
      account.scheduleLegacy(0)
      if (reconnect) {
        // Missed while disconnected: leverage / margin mode, conditional orders that fired, fills.
        void account.loadConfig(false)
        orders.markStale('trigger', 'history', 'trades', 'positionHistory', 'transactions')
      }
    } catch {
      if (epoch !== resyncEpoch) return
      resyncing = false
      account.setLive(false)
      buffered.length = 0
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
    if (!account.live) return
    dispatch(event)
  }

  function dispatch(event: UserStreamEvent): void {
    switch (event.e) {
      case 'ORDER_TRADE_UPDATE': {
        const fill = orders.applyOrderEvent(event.o as StreamOrder)
        if (fill !== null) toastFill(fill)
        // A resting order freezes margin (可用 / 冻结) without any ACCOUNT_UPDATE (as on Binance).
        account.scheduleSnapshot()
        break
      }
      case 'ACCOUNT_UPDATE':
        account.applyStreamAccountUpdate(event.a as StreamAccountUpdate)
        // A closed position takes its TP/SL with it (core memo 7): re-read the conditional map.
        orders.positionsChanged()
        break
      case 'ACCOUNT_CONFIG_UPDATE':
        account.applyStreamConfig((event.ac ?? {}) as { s?: unknown; l?: unknown })
        break
      case 'MARGIN_CALL':
        toastMarginCall(event)
        account.scheduleSnapshot()
        break
      default:
        break
    }
  }

  /** Binance-style fill notice; one toast per order (later partial fills of the same order replace it). */
  function toastFill(fill: FillNotice): void {
    ensureFuturesMessages()
    const t = i18n.global.t
    const side = fill.open === 'OPEN' ? (fill.side === 'BUY' ? t('fut.openLong') : t('fut.openShort')) : (fill.side === 'BUY' ? t('fut.closeShort') : t('fut.closeLong'))
    const price = fill.avgPrice === '' ? '--' : groupDigits(toFixedString(fill.avgPrice, fill.contract.pricePrecision), fill.contract.pricePrecision)
    const message = t(fill.complete ? 'fut.us.filled' : 'fut.us.partFilled', {
      side,
      symbol: fill.contract.displayName,
      qty: fill.filledCoin,
      coin: fill.contract.multiplierCoin,
      price,
    })
    showToast(message, 'success', { key: `fill:${fill.orderId}`, timeout: 4000 })
  }

  function toastMarginCall(event: UserStreamEvent): void {
    ensureFuturesMessages()
    const rows = Array.isArray(event.p) ? (event.p as { s?: unknown }[]) : []
    const symbols = [...new Set(rows.map((row) => String(row.s ?? '')).filter((symbol) => symbol !== ''))].join(', ')
    showToast(i18n.global.t('fut.us.marginCall', { symbols: symbols || '--' }), 'error', { key: 'margin-call', timeout: 8000 })
  }

  return { status, lastEventAt, resyncs, start, stop, reconnectNow: () => stream?.reconnectNow() }
})

/**
 * Data loader for the open-source `klinecharts` v10 widget.
 *
 * The transport is the exchange's own K-line WebSocket (`modules/ws/protocol`), shared with the
 * market store through `modules/ws/shared-socket`, speaking the same private protocol the legacy
 * TradingView adapter used:
 *   - history: `{ event: 'req', params: { channel, cb_id, endIdx?, pageSize } }`
 *   - live:    `{ event: 'sub', params: { channel, cb_id } }`
 * and pages are requested backwards from `endIdx` (seconds) with a 300 bar page size.
 *
 * klinecharts 10 has no `updateData`/`applyNewData`: the widget pulls data through
 * `DataLoader.getBars` (`init` | `forward` | `backward`) and pushes realtime bars through
 * `DataLoader.subscribeBar`, so this module adapts the socket to that contract instead of
 * remounting the chart on every tick.
 */
import type {
  DataLoadMore,
  DataLoader,
  DataLoaderGetBarsParams,
  DataLoaderSubscribeBarParams,
  DataLoaderUnsubscribeBarParams,
  KLineData,
  Period,
  SymbolInfo,
} from 'klinecharts'
import { DEFAULT_KLINE_SCALES } from '@/modules/market/symbols'
import { toDecString } from '@/modules/finance/decimal'
import { toNumberForDisplay } from '@/modules/finance/display'
import type { SocketRequestOptions, SocketState } from '@/modules/ws/kline-socket'
import { sharedSockets } from '@/modules/ws/shared-socket'
import { buildKlineRequest, klineChannel, type KlineBar, type WsMessage } from '@/modules/ws/protocol'

/** Server page size used for every history request (matches the legacy client). */
export const KLINE_PAGE_SIZE = 300
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MS_PER_SECOND = 1_000

/* ------------------------------------------------------------------ conversion */

/** Exchange scale -> klinecharts period. */
const SCALE_PERIOD: Record<string, Period> = {
  '1min': { type: 'minute', span: 1 },
  '3min': { type: 'minute', span: 3 },
  '5min': { type: 'minute', span: 5 },
  '15min': { type: 'minute', span: 15 },
  '30min': { type: 'minute', span: 30 },
  '60min': { type: 'hour', span: 1 },
  '1h': { type: 'hour', span: 1 },
  '2h': { type: 'hour', span: 2 },
  '4h': { type: 'hour', span: 4 },
  '6h': { type: 'hour', span: 6 },
  '12h': { type: 'hour', span: 12 },
  '1day': { type: 'day', span: 1 },
  '3day': { type: 'day', span: 3 },
  '1week': { type: 'week', span: 1 },
  '1month': { type: 'month', span: 1 },
}

function periodKey(period: Period): string {
  return `${period.type}:${period.span}`
}

/** Reverse map; the configured default scales win when two scales share a period. */
const PERIOD_SCALE = ((): Map<string, string> => {
  const map = new Map<string, string>()
  const add = (scale: string): void => {
    const period = SCALE_PERIOD[scale]
    if (period !== undefined && !map.has(periodKey(period))) {
      map.set(periodKey(period), scale)
    }
  }
  DEFAULT_KLINE_SCALES.forEach(add)
  Object.keys(SCALE_PERIOD).forEach(add)
  return map
})()

/** `30min` -> `{ type: 'minute', span: 30 }`; `null` for an unsupported scale. */
export function scaleToPeriod(scale: string | null | undefined): Period | null {
  if (typeof scale !== 'string') {
    return null
  }
  const period = SCALE_PERIOD[scale.trim()]
  return period === undefined ? null : { type: period.type, span: period.span }
}

/** `{ type: 'minute', span: 30 }` -> `30min`; `null` for an unsupported period. */
export function periodToScale(period: Period | null | undefined): string | null {
  if (period === null || period === undefined) {
    return null
  }
  if (typeof period.type !== 'string' || !Number.isFinite(period.span) || period.span <= 0) {
    return null
  }
  return PERIOD_SCALE.get(periodKey(period)) ?? null
}

/**
 * Channel symbol for the chart's symbol info: `btcusdt`, `BTC/USDT` and `btc_usdt` all map to
 * `btcusdt`, because the exchange channel is built from the unseparated lowercase pair.
 * Empty when the chart has no usable symbol yet.
 */
export function channelSymbol(symbol: SymbolInfo | null | undefined): string {
  const ticker = symbol?.ticker
  return typeof ticker === 'string' ? ticker.trim().toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

/**
 * Exchange bar -> chart bar. Bar ids are seconds and `KLineData.timestamp` is milliseconds.
 * Malformed rows (non finite numbers, impossible OHLC, negative volume) are dropped instead of
 * being padded with invented candles.
 */
export function convertKlineBar(input: KlineBar | null | undefined): KLineData | null {
  const values = [input?.id, input?.open, input?.high, input?.low, input?.close, input?.vol].map(
    (value) => toNumberForDisplay(toDecString(value)),
  )
  if (values.some((value) => value === null || !Number.isFinite(value))) {
    return null
  }
  const [id, open, high, low, close, volume] = values as number[]
  if (id <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) {
    return null
  }
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
    return null
  }
  return { timestamp: Math.round(id * MS_PER_SECOND), open, high, low, close, volume }
}

/** Number of valid rows in a raw payload; the server page size tells us whether more exists. */
export function countValidBars(rows: unknown): number {
  if (!Array.isArray(rows)) {
    return 0
  }
  let count = 0
  rows.forEach((row) => {
    if (convertKlineBar(row as KlineBar) !== null) {
      count += 1
    }
  })
  return count
}

export interface BarBatchRange {
  /** Keep only bars strictly older than this millisecond timestamp. */
  olderThan?: number
  /** Keep only bars strictly newer than this millisecond timestamp. */
  newerThan?: number
}

/**
 * Converts, validates, de-duplicates (last row wins) and sorts a history page. The range filter
 * keeps pages from overlapping the series that is already on the chart.
 */
export function normalizeBarBatch(rows: unknown, range: BarBatchRange = {}): KLineData[] {
  if (!Array.isArray(rows)) {
    return []
  }
  const unique = new Map<number, KLineData>()
  rows.forEach((row) => {
    const bar = convertKlineBar(row as KlineBar)
    if (bar === null) {
      return
    }
    if (range.olderThan !== undefined && bar.timestamp >= range.olderThan) {
      return
    }
    if (range.newerThan !== undefined && bar.timestamp <= range.newerThan) {
      return
    }
    unique.set(bar.timestamp, bar)
  })
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp)
}

/* ------------------------------------------------------------------ socket seam */

export type DatafeedStatus = 'connecting' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * The subset of a shared-socket lease (`modules/ws/shared-socket`) the loader uses; injectable so
 * the loader is unit testable.
 */
export interface DatafeedSocketLike {
  readonly isOpen: boolean
  onMessage(handler: (message: WsMessage) => void): () => void
  onStateChange(listener: (state: SocketState) => void): () => void
  registerChannel(channel: string, params: Record<string, unknown>, kind?: 'req' | 'sub'): void
  unsubscribe(channel: string): void
  request(channel: string, params: Record<string, unknown>, options: SocketRequestOptions): () => void
  release(): void
}

export type DatafeedSocketAcquirer = (url: string) => DatafeedSocketLike

export interface KlineDatafeedOptions {
  url: string
  /** Injectable transport (tests); defaults to a lease on the tab-wide shared socket for `url`. */
  acquireSocket?: DatafeedSocketAcquirer
  /** A page that does not answer in time settles with an empty page and an `error` status. */
  requestTimeoutMs?: number
  onStatus?: (status: DatafeedStatus) => void
  /**
   * Called when the realtime stream reconnects after a gap. The chart must reload its series
   * (`resetData()`) because bars produced while the socket was down are simply missing; splicing
   * the gap from live ticks alone would either lose those bars or break monotonic time.
   */
  onReconnect?: () => void
  /**
   * Reports each answered history page of the newest request: `init` with 0 bars means the server
   * has no history for this symbol/period (the chart then only shows bars built from live ticks).
   */
  onHistory?: (type: 'init' | 'forward' | 'backward', bars: number) => void
  /**
   * Maps the chart's symbol info to the channel symbol. Defaults to `channelSymbol` (spot pairs);
   * futures pass a resolver that keeps the contract-type prefix (`e_btcusdt`).
   */
  channelSymbol?: (symbol: SymbolInfo | null | undefined) => string
}

export interface KlineDatafeed {
  readonly dataLoader: DataLoader
  dispose: () => void
}

type HistoryType = 'init' | 'forward' | 'backward'
type SettleOutcome = 'ok' | 'timeout' | 'closed' | 'superseded' | 'disposed'

interface PendingHistory {
  /** Request identity; only the newest id may touch the shared status. */
  id: number
  channel: string
  symbol: string
  scale: string
  type: HistoryType
  /** Millisecond boundary taken from the chart (`params.timestamp`) for page requests. */
  cursor: number | null
  callback: (data: KLineData[], more?: DataLoadMore) => void
  generation: number
  /** Withdraws the correlated `req` from the shared socket (no-op once it has answered). */
  cancel: (() => void) | null
  settled: boolean
}

interface LiveSubscription {
  channel: string
  symbol: string
  scale: string
  params: Record<string, unknown>
  callback: (data: KLineData) => void
  lastTimestamp: number
}

const NO_MORE: DataLoadMore = { forward: false, backward: false }

function moreFor(type: HistoryType, hasMore: boolean): DataLoadMore {
  if (type === 'backward') {
    return { forward: false, backward: hasMore }
  }
  return { forward: hasMore, backward: false }
}

function defaultAcquireSocket(url: string): DatafeedSocketLike {
  return sharedSockets.acquire(url)
}

/**
 * Wires the exchange K-line socket to a klinecharts `DataLoader`.
 *
 * Guarantees:
 *   - no socket of its own: history pages and live bars ride on the tab-wide shared market socket
 *     (the one the market store already holds). A page is a correlated `req` (`KlineSocket.request`):
 *     one in flight per channel, answered in order, so a `rep` frame (which carries no request id)
 *     is always attributed to the request that asked for it.
 *   - `endIdx` is sent in seconds with `pageSize: 300`; init and "newer bars" both ask for the
 *     newest page, and only `forward` (older bars) paginates backwards from a cursor.
 *   - a page timeout settles the page with an error status and never closes the shared socket.
 *   - a superseded page settles its callback empty before the next request takes over, and only
 *     the newest request may change the reported status.
 *   - a realtime reconnect raises `onReconnect` so the chart reloads history instead of accepting
 *     a non-monotonic live cursor.
 */
export function createKlineDatafeed(options: KlineDatafeedOptions): KlineDatafeed {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const resolveSymbol = options.channelSymbol ?? channelSymbol
  let disposed = false
  let generation = 0
  let requestId = 0
  let latestRequestId = 0
  let sawDisconnect = false
  let pending: PendingHistory | null = null
  let live: LiveSubscription | null = null
  let status: DatafeedStatus = 'connecting'

  const socket = (options.acquireSocket ?? defaultAcquireSocket)(options.url)
  const offMessage = socket.onMessage(handleRealtimeMessage)
  const offState = socket.onStateChange(handleRealtimeState)

  function emit(next: DatafeedStatus): void {
    if (disposed || status === next) {
      return
    }
    status = next
    options.onStatus?.(next)
  }

  /** Millisecond range kept from a page so it never overlaps the series already on the chart. */
  function rangeFor(request: PendingHistory): BarBatchRange {
    if (request.cursor === null) {
      return {}
    }
    if (request.type === 'forward') {
      return { olderThan: request.cursor }
    }
    if (request.type === 'backward') {
      return { newerThan: request.cursor }
    }
    return {}
  }

  function countValidBarsNewerThan(rows: unknown, cursor: number): number {
    if (!Array.isArray(rows)) {
      return 0
    }
    let count = 0
    rows.forEach((row) => {
      const bar = convertKlineBar(row as KlineBar)
      if (bar !== null && bar.timestamp > cursor) {
        count += 1
      }
    })
    return count
  }

  /**
   * `raw >= page size` is the only signal the protocol gives us that more rows may exist. For
   * "newer" loading the newest page has already reached the live edge as soon as it contains a bar
   * at or before the cursor, so there is nothing more to fetch.
   */
  function hasMoreFor(request: PendingHistory, payload: unknown, bars: KLineData[], validRows: number): boolean {
    if (validRows < KLINE_PAGE_SIZE) {
      return false
    }
    if (request.type === 'backward') {
      return request.cursor !== null && countValidBarsNewerThan(payload, request.cursor) === validRows
    }
    return bars.length > 0
  }

  function settle(request: PendingHistory, outcome: SettleOutcome, payload?: unknown): void {
    if (request.settled) {
      return
    }
    request.settled = true
    const cancel = request.cancel
    request.cancel = null
    if (outcome === 'superseded' || outcome === 'disposed') {
      // Frees the request on the shared socket; its late reply is swallowed there.
      cancel?.()
    }
    if (pending === request) {
      pending = null
    }
    // Only the newest request may report a status; a superseded or disposed page stays silent.
    const isLatest = !disposed && request.generation === generation && request.id === latestRequestId
    let bars: KLineData[] = []
    let hasMore = false
    if (outcome === 'ok') {
      const validRows = countValidBars(payload)
      bars = normalizeBarBatch(payload, rangeFor(request))
      hasMore = hasMoreFor(request, payload, bars, validRows)
    }
    if (outcome === 'ok') {
      if (request.type === 'init') {
        if (isLatest) {
          emit(bars.length > 0 ? 'ready' : 'empty')
        }
      } else if (isLatest && status !== 'ready') {
        emit('ready')
      }
    } else if ((outcome === 'timeout' || outcome === 'closed') && isLatest) {
      emit('error')
    }
    if (outcome === 'ok' && isLatest) {
      options.onHistory?.(request.type, bars.length)
    }
    request.callback(bars, moreFor(request.type, hasMore))
  }

  /** Queues the single `req` frame for this page on the shared socket. */
  function dispatchHistory(request: PendingHistory): void {
    // `endIdx` is inclusive and pages backwards, so only "older bars" use it. Init and "newer
    // bars" both ask for the newest page, which the caller filters to its own range.
    const params: Record<string, unknown> =
      request.type === 'forward' && request.cursor !== null
        ? { endIdx: Math.floor(request.cursor / MS_PER_SECOND), pageSize: KLINE_PAGE_SIZE }
        : { pageSize: KLINE_PAGE_SIZE }
    const frame = buildKlineRequest('req', request.symbol, request.scale, params)
    request.cancel = socket.request(request.channel, frame.params, {
      timeoutMs: requestTimeoutMs,
      onSettle: (outcome, message) => {
        if (disposed || request.settled) {
          return
        }
        if (outcome === 'ok') {
          settle(request, 'ok', message?.data)
        } else if (outcome === 'timeout' || outcome === 'closed') {
          // The page failed; the shared socket stays up (and reconnects by itself if it dropped).
          settle(request, outcome)
        }
      },
    })
  }

  function handleRealtimeState(state: SocketState): void {
    if (disposed) {
      return
    }
    if (state === 'open') {
      const reconnected = sawDisconnect
      sawDisconnect = false
      if (reconnected && options.onReconnect !== undefined) {
        // Reload from the server: the bars missed while the socket was down cannot be recovered
        // from live ticks, and resetting the live cursor would only hide the gap.
        options.onReconnect()
        return
      }
      const subscription = live
      if (subscription !== null) {
        // Idempotent: the socket registry replays it too, but this also covers a naked transport.
        socket.registerChannel(subscription.channel, subscription.params, 'sub')
      }
      return
    }
    if (state === 'closed') {
      // Do not touch the status here: the chart may already hold good history, and the reconnect
      // path either reloads it (via `onReconnect`) or re-registers the live channel.
      sawDisconnect = true
    }
  }

  function handleRealtimeMessage(message: WsMessage): void {
    if (disposed) {
      return
    }
    const channel = message.channel
    if (typeof channel !== 'string' || channel === '' || message.tick === undefined || message.event_rep === 'rep') {
      return
    }
    const subscription = live
    if (subscription === null || subscription.channel !== channel) {
      return
    }
    const bar = convertKlineBar(message.tick as KlineBar)
    if (bar === null || bar.timestamp < subscription.lastTimestamp) {
      return
    }
    subscription.lastTimestamp = bar.timestamp
    // A live bar proves the stream is healthy; ready is the only status a tick can restore.
    if (status !== 'ready') {
      emit('ready')
    }
    subscription.callback(bar)
  }

  function releaseLive(subscription: LiveSubscription): void {
    socket.unsubscribe(subscription.channel)
  }

  const dataLoader: DataLoader = {
    getBars(params: DataLoaderGetBarsParams): void {
      const type: HistoryType = params.type === 'update' ? 'init' : params.type
      const scale = periodToScale(params.period)
      const symbol = resolveSymbol(params.symbol)
      if (disposed || scale === null || symbol === '') {
        params.callback([], NO_MORE)
        if (!disposed) {
          emit('error')
        }
        return
      }
      if (type === 'init') {
        // A new series invalidates everything queued for the previous one.
        generation += 1
      }
      const cursor = params.timestamp ?? null
      if (type !== 'init' && (cursor === null || !Number.isFinite(cursor))) {
        params.callback([], moreFor(type, false))
        return
      }
      // klinecharts only ever wants the newest page: settle the one still in flight (empty) before
      // switching, otherwise its late frame would have to be dropped without ever calling back.
      const previous = pending
      if (previous !== null) {
        settle(previous, 'superseded')
      }
      requestId += 1
      latestRequestId = requestId
      const request: PendingHistory = {
        id: requestId,
        channel: klineChannel(symbol, scale),
        symbol,
        scale,
        type,
        cursor: type === 'init' ? null : cursor,
        callback: params.callback,
        generation,
        cancel: null,
        settled: false,
      }
      pending = request
      emit('loading')
      dispatchHistory(request)
    },

    subscribeBar(params: DataLoaderSubscribeBarParams): void {
      const scale = periodToScale(params.period)
      const symbol = resolveSymbol(params.symbol)
      if (disposed || scale === null || symbol === '') {
        return
      }
      const channel = klineChannel(symbol, scale)
      const previous = live
      if (previous !== null && previous.channel !== channel) {
        releaseLive(previous)
      }
      live = {
        channel,
        symbol,
        scale,
        params: buildKlineRequest('sub', symbol, scale).params,
        callback: params.callback,
        lastTimestamp: 0,
      }
      socket.registerChannel(channel, live.params, 'sub')
    },

    unsubscribeBar(params: DataLoaderUnsubscribeBarParams): void {
      const subscription = live
      if (subscription === null) {
        return
      }
      const scale = periodToScale(params.period)
      const symbol = resolveSymbol(params.symbol)
      const channel = scale !== null && symbol !== '' ? klineChannel(symbol, scale) : null
      if (channel !== null && channel !== subscription.channel) {
        // Stale unsubscribe for another symbol/timeframe: keep the live series we are on.
        return
      }
      releaseLive(subscription)
      live = null
    },
  }

  return {
    dataLoader,
    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      generation += 1
      const request = pending
      pending = null
      if (request !== null) {
        settle(request, 'disposed')
      }
      const subscription = live
      live = null
      if (subscription !== null) {
        releaseLive(subscription)
      }
      offMessage()
      offState()
      socket.release()
    },
  }
}

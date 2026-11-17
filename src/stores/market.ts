import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { FALLBACK_WS_URL, SPOT_SEQ_DEPTH_SNAPSHOT_URL, SPOT_SEQ_DEPTH_WS_URL, WS_URL_OVERRIDE } from '@/config/endpoints'
import { applyPublicInfo, runtimeWsUrl } from '@/config/runtime'
import { isApiError } from '@/core/errors'
import { readCache, writeCache } from '@/core/session-cache'
import { PUBLIC_INFO_FRESH_MS, fetchPublicInfo, readCachedPublicInfo } from '@/modules/api/public.api'
import type { PublicInfoV4 } from '@/modules/api/types'
import { canonicalDecimal, toDecString } from '@/modules/finance/decimal'
import { coarseChannelForStep, composeSide, tickDepthSteps, tickFromPrecision, type RawLevel } from '@/modules/market/book-aggregate'
import { DepthBook } from '@/modules/market/depth-book'
import { buildMarketSymbols, findSymbolByPair, normalizeKlineScales, pickDefaultSymbol, type MarketSymbol } from '@/modules/market/symbols'
import { toNumberForDisplay } from '@/modules/finance/display'
import {
  buildDepthRequest,
  buildKlineRequest,
  buildReviewRequest,
  REVIEW_CHANNEL,
  buildTickerRequest,
  buildTradeRequest,
  depthChannel,
  klineChannel,
  pairToSymbol,
  parseChannel,
  tickerChannel,
  tradeChannel,
  type DepthDelta,
  type DepthSnapshot,
  type KlineBar,
  type TickerTick,
  type TradeTick,
  type WsMessage,
} from '@/modules/ws/protocol'
import type { SocketState } from '@/modules/ws/kline-socket'
import { SOCKET_RELEASE_GRACE_MS, sharedSockets, type SocketLease } from '@/modules/ws/shared-socket'
import { SeqDepthClient, isSpotSeqDepthEnabled, type SeqDepthStatus } from '@/modules/ws/seq-depth'
import { fetchClosedSpotSymbols } from '@/modules/spot/exchange-status'

export interface DepthLevel {
  price: string
  amount: string
  total: string
  /** 1 = grew, 2 = shrank, 0 = unchanged (matches the legacy flash highlight). */
  diff: 0 | 1 | 2
}

export interface TickerSnapshot {
  close: string
  open: string
  high: string
  low: string
  vol: string
  amount: string
  rose: string
}

/**
 * What a page needs from the market stream:
 * - `overview` (home, markets): the `review` channel only — every pair's 24h ticker in one stream.
 * - `terminal` (spot/margin trading): review plus the selected pair's ticker, trades and book.
 * K-line history and live bars belong to the chart (`modules/charts/kline-datafeed`), which rides
 * on the same shared socket.
 */
export type MarketMode = 'overview' | 'terminal'

/**
 * Book renders are throttled, not delayed: the first change after a quiet interval renders at once (leading edge), a
 * burst renders at most once per interval with a trailing render for the last change (09-30: a trailing-only 200 ms
 * timer delayed every best-level change by ~210 ms, journal BOOK_LATENCY_20260930).
 */
const DEPTH_PUBLISH_INTERVAL_MS = 100
/** Ticker/review frames are coalesced to at most 4 UI updates per second. */
export const TICKER_PUBLISH_INTERVAL_MS = 250
/**
 * QA-003 (10-25): the server answers `review` only on `req` (one HVALS snapshot) and never broadcasts it, so the home
 * page, the markets list and the trade-page pair list froze at their first price. The snapshot is re-requested on this
 * interval while a market page is shown and the tab is visible (spot-md rebuilds tickers every 1-5 s).
 */
export const REVIEW_REFRESH_MS = 2_000
const MAX_TRADES = 60
const MAX_DEPTH_ROWS = 50
/** Last tickers kept in `sessionStorage` so a reload shows a price before the socket is up. */
const TICKER_CACHE_NAME = 'tickers'
const TICKER_CACHE_MAX_AGE_MS = 2 * 60_000
const TICKER_CACHE_WRITE_INTERVAL_MS = 5_000
/**
 * Home/markets trends: one-shot `req` of hourly bars per pair, never a subscription. One request per
 * pair serves both the home hero (48 points) and the market-list sparkline (last 24 points). At most
 * `TREND_CONCURRENCY` requests are in flight, each pair is refreshed at most every `TREND_TTL_MS`,
 * and nothing is requested while the tab is hidden. With five pairs that is ~5 small requests / 5 min.
 */
const TREND_SCALE = '60min'
const TREND_POINTS = 48
/** Points shown per row in the market list (24 hourly closes). */
export const ROW_TREND_POINTS = 24
export const TREND_TTL_MS = 5 * 60_000
const TREND_TIMEOUT_MS = 15_000
export const TREND_CONCURRENCY = 2

function emptyTicker(): TickerSnapshot {
  return { close: '', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
}

function sanitizeTickerCache(data: unknown): Record<string, TickerSnapshot> | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const result: Record<string, TickerSnapshot> = {}
  Object.entries(data as Record<string, unknown>).forEach(([key, value]) => {
    if (!/^[a-z0-9_]{1,40}$/.test(key) || value === null || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    const read = (field: string): string => canonicalDecimal(toDecString(row[field]))
    result[key] = { close: read('close'), open: read('open'), high: read('high'), low: read('low'), vol: read('vol'), amount: read('amount'), rose: read('rose') }
  })
  return result
}

/**
 * Market data: public info (pair config), all-pair tickers, and — on the trading terminal — the
 * selected pair's ticker, order book and recent trades. All realtime values come from the market
 * WebSocket (shared per tab, `modules/ws/shared-socket`); nothing is synthesized. The only cached
 * values are the last real tickers (`sessionStorage`, two minutes), shown until the stream answers
 * and flagged by `tickerLive === false`.
 */
export const useMarketStore = defineStore('market', () => {
  const cachedTickers = readCache(TICKER_CACHE_NAME, TICKER_CACHE_MAX_AGE_MS, sanitizeTickerCache)?.data ?? {}
  const publicInfo = shallowRef<PublicInfoV4 | null>(null)
  const publicInfoLoading = ref(false)
  const publicInfoError = ref<string | null>(null)
  /** Retry number while `public_info_v4` is being retried after a transport failure (0 = none). */
  const publicInfoRetry = ref(0)
  const selectedPair = ref<string>('BTC/USDT')
  const ticker = shallowRef<TickerSnapshot>(emptyTicker())
  /** Every pair's 24h ticker from the `review` channel, keyed by lower-case symbol (`btcusdt`). */
  const tickers = shallowRef<Record<string, TickerSnapshot>>(cachedTickers)
  const tickerReceived = ref(false)
  /** False while `ticker`/`tickers` still show the cached snapshot rather than a streamed frame. */
  const tickerLive = ref(false)
  /**
   * Hourly closes per pair (keyed by the pair's channel symbol, e.g. `btcusdt`; display numbers only). A key is present once
   * that pair's request answered: `[]` (or fewer than two points) means the pair has no K-line data.
   * A missing key means not loaded yet (or the last request failed and will be retried).
   */
  const trends = shallowRef<Record<string, number[]>>({})
  /** Hourly closes of the selected pair for the home hero sparkline. */
  const trend = computed<number[]>(() => trends.value[tickerSymbol.value] ?? [])
  const mode = ref<MarketMode | null>(null)
  const trades = shallowRef<TradeTick[]>([])
  const asks = shallowRef<DepthLevel[]>([])
  const buys = shallowRef<DepthLevel[]>([])
  const depthStepIndex = ref(0)
  const klineScale = ref('5min') // owner 10-22: open on 5m (was 30m)
  const connectionState = ref<SocketState>('idle')
  const lastMessageAt = ref<number | null>(null)

  /** Pairs `/api/v3/exchangeInfo` marks non-TRADING (closed in the admin): hidden everywhere (`modules/spot/exchange-status.ts`). */
  const closedSymbols = shallowRef<ReadonlySet<string>>(new Set())
  /** Retained metadata serves owned orders even after a pair disappears from the discovery list. */
  const rememberedSymbols = shallowRef<MarketSymbol[]>([])
  const allSymbols = computed<MarketSymbol[]>(() => [...new Map([...rememberedSymbols.value, ...buildMarketSymbols(publicInfo.value, { includeHidden: true })].map(entry => [entry.symbol, entry])).values()])
  const symbols = computed<MarketSymbol[]>(() => {
    const all = buildMarketSymbols(publicInfo.value)
    const closed = closedSymbols.value
    return closed.size === 0 ? all : all.filter((entry) => !closed.has(entry.symbol.toUpperCase()))
  })
  const klineScales = computed<string[]>(() => normalizeKlineScales(publicInfo.value))
  const quoteGroups = computed<string[]>(() => [...new Set(symbols.value.map((entry) => entry.quoteGroup))])
  const currentSymbol = computed<MarketSymbol | undefined>(() => findSymbolByPair(allSymbols.value, selectedPair.value))
  const currentSymbolName = computed<string>(() => currentSymbol.value?.symbol ?? '')
  const currentTradingClosed = computed(() => closedSymbols.value.has(currentSymbolName.value.toUpperCase()))
  /**
   * Key of the displayed ticker. Before public info has loaded (or while it is failing) the
   * selected pair's own channel symbol is used, so the review stream alone can show the price.
   */
  const tickerSymbol = computed<string>(() => currentSymbolName.value !== '' ? currentSymbolName.value : publicInfo.value === null ? pairToSymbol(selectedPair.value) : '')
  /** Book grouping steps: the pair's server steps plus one client-side coarser decade. */
  const bookSteps = computed<string[]>(() => tickDepthSteps(tickFromPrecision(currentSymbol.value?.pricePrecision), currentSymbol.value?.rules.depthSteps ?? []))
  const depthStep = computed<string>(() => bookSteps.value[depthStepIndex.value] ?? bookSteps.value[0] ?? '')
  /** Channel level of the finest server step (always subscribed; grouped client-side). */
  const depthLevel = computed<number>(() => currentSymbol.value?.depthLevels[0] ?? 0)

  /** Finest server channel, grouped at the chosen step. */
  const fineBook = new DepthBook()
  /** Coarse server channel for the chosen step (only extends the book beyond the fine range). */
  const coarseBook = new DepthBook()
  let coarseLevel: number | null = null
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let lastPublishAt = 0
  let lease: SocketLease | null = null
  let leaseOffs: (() => void)[] = []
  /** Views currently using the stream; the lease is held while any is active. */
  const users = new Map<symbol, MarketMode>()
  let publicInfoPromise: Promise<void> | null = null
  let publicInfoFetchedAt = 0
  const tickerBuffer = new Map<string, TickerSnapshot>()
  let tickerTimer: ReturnType<typeof setTimeout> | null = null
  let lastTickerPublish = 0
  let lastTickerCacheWrite = 0
  /** When each pair's trend last answered (ms). */
  const trendAt = new Map<string, number>()
  const trendInflight = new Map<string, () => void>()
  let trendQueue: string[] = []
  /** Pairs the visible market list shows (`loadTrends`) and whether the hero wants the selected pair. */
  let trendRows: string[] = []
  let trendHero = false
  let trendTimer: ReturnType<typeof setTimeout> | null = null
  let trendVisibilityBound = false
  let warmTimer: ReturnType<typeof setTimeout> | null = null
  let reviewTimer: ReturnType<typeof setInterval> | null = null
  /** The selected pair's own ticker channel has delivered: a (possibly older) review row must not overwrite it. */
  let pairTickerSeen = false
  /** Pair channels registered for the terminal; the review stream is kept across pair switches. */
  let pairChannels: string[] = []
  /**
   * Sequenced depth feed (`modules/ws/seq-depth.ts`, spot-md `/smd/v1`, exact engine-precision book with update
   * ids): while it is `live` it replaces the step0 channel as the fine book; otherwise (disabled, connecting,
   * resyncing, failed — the client retries every 60 s) the step0 channel is used exactly as before. step0 stays
   * subscribed throughout, so the fallback is instant and never blank. Coarser steps keep the existing design (the
   * fine book grouped client-side, the coarse `depth_step<n>` channel only extends it).
   */
  const depthFeed = ref<'seq' | 'legacy'>('legacy')
  const seqDepthStatus = ref<SeqDepthStatus>('idle')
  let seqLevels: { asks: RawLevel[]; bids: RawLevel[] } = { asks: [], bids: [] }
  let seqDepth: SeqDepthClient | null = null

  function describe(error_: unknown): string {
    if (isApiError(error_)) {
      return error_.message
    }
    return error_ instanceof Error ? error_.message : String(error_)
  }

  function applyInfo(info: PublicInfoV4): void {
    rememberedSymbols.value = allSymbols.value
    publicInfo.value = info
    applyPublicInfo(info, WS_URL_OVERRIDE ?? FALLBACK_WS_URL)
    keepSelectionOpen()
    void refreshTradingStatus()
    const scales = normalizeKlineScales(info)
    if (!scales.includes(klineScale.value)) {
      klineScale.value = scales[0]
    }
    restoreTickerFromMap()
  }

  /** The selected pair was closed (or never existed): move to the default pair. */
  function keepSelectionOpen(): void {
    const preferred = pickDefaultSymbol(symbols.value)
    if (preferred !== undefined && findSymbolByPair(allSymbols.value, selectedPair.value) === undefined) {
      selectedPair.value = preferred.pair
    }
  }

  /** Re-reads which pairs are closed (cached 60 s); called with every public info load / refresh. */
  async function refreshTradingStatus(): Promise<void> {
    const closed = await fetchClosedSpotSymbols()
    const before = closedSymbols.value
    if (closed.size === before.size && [...closed].every((symbol) => before.has(symbol))) return
    closedSymbols.value = closed
    keepSelectionOpen()
  }

  async function fetchAndApply(): Promise<void> {
    const info = await fetchPublicInfo({
      onRetry: (retry) => {
        publicInfoRetry.value = retry
      },
    })
    publicInfoFetchedAt = Date.now()
    applyInfo(info)
    publicInfoError.value = null
  }

  /**
   * Loads `public_info_v4` once per tab and dedupes concurrent callers (the route prefetch, the view
   * and the header all ask). A cached copy (`sessionStorage`, per language) renders immediately and
   * is revalidated in the background; `force` (locale switch) always refetches.
   */
  async function loadPublicInfo(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true
    if (!force && publicInfo.value !== null) {
      // Already rendered: refresh quietly; a failed refresh keeps the current config on screen.
      if (Date.now() - publicInfoFetchedAt >= PUBLIC_INFO_FRESH_MS) void revalidatePublicInfo()
      void refreshTradingStatus()
      return
    }
    if (publicInfoPromise !== null && !force) return publicInfoPromise
    if (!force) {
      const cached = readCachedPublicInfo()
      if (cached !== null) {
        applyInfo(cached.data)
        publicInfoFetchedAt = Date.now() - cached.age
        if (cached.age >= PUBLIC_INFO_FRESH_MS) void revalidatePublicInfo()
        return
      }
    }
    publicInfoLoading.value = true
    publicInfoError.value = null
    publicInfoRetry.value = 0
    const run = fetchAndApply()
    publicInfoPromise = run
    try {
      await run
    } catch (error_) {
      if (publicInfoPromise === run) publicInfoError.value = describe(error_)
      throw error_
    } finally {
      if (publicInfoPromise === run) {
        publicInfoPromise = null
        publicInfoLoading.value = false
        publicInfoRetry.value = 0
      }
    }
  }

  /** Background refresh of a cached public info; a failure keeps the cached copy on screen. */
  async function revalidatePublicInfo(): Promise<void> {
    if (publicInfoPromise !== null) return
    const run = fetchAndApply().catch(() => undefined).finally(() => {
      if (publicInfoPromise === run) publicInfoPromise = null
    })
    publicInfoPromise = run
    await run
  }

  function resolveWsUrl(): string {
    if (WS_URL_OVERRIDE !== null && WS_URL_OVERRIDE !== '') {
      return WS_URL_OVERRIDE
    }
    return runtimeWsUrl() ?? FALLBACK_WS_URL
  }

  function toSnapshot(tick: TickerTick): TickerSnapshot {
    return {
      close: canonicalDecimal(toDecString(tick.close)),
      open: canonicalDecimal(toDecString(tick.open)),
      high: canonicalDecimal(toDecString(tick.high)),
      low: canonicalDecimal(toDecString(tick.low)),
      vol: canonicalDecimal(toDecString(tick.vol)),
      amount: canonicalDecimal(toDecString(tick.amount)),
      rose: canonicalDecimal(toDecString(tick.rose)),
    }
  }

  /** Shows the last known ticker of the selected pair (cached or streamed) until a frame arrives. */
  function restoreTickerFromMap(): void {
    const known = tickers.value[tickerSymbol.value]
    ticker.value = known ?? emptyTicker()
    tickerReceived.value = known !== undefined
  }

  /**
   * Coalesces ticker/review frames: the first frame after a quiet period is published at once (the
   * price must appear fast), later ones at most every `TICKER_PUBLISH_INTERVAL_MS`.
   */
  function publishTickers(): void {
    tickerTimer = null
    lastTickerPublish = Date.now()
    if (tickerBuffer.size === 0) return
    const next = { ...tickers.value }
    tickerBuffer.forEach((snapshot, key) => {
      next[key] = snapshot
    })
    tickerBuffer.clear()
    tickers.value = next
    tickerLive.value = true
    const own = next[tickerSymbol.value]
    if (own !== undefined && own !== ticker.value) {
      ticker.value = own
      tickerReceived.value = true
    }
    if (lastTickerPublish - lastTickerCacheWrite >= TICKER_CACHE_WRITE_INTERVAL_MS) {
      lastTickerCacheWrite = lastTickerPublish
      writeCache(TICKER_CACHE_NAME, next)
    }
  }

  function schedulePublishTickers(): void {
    if (tickerTimer !== null || tickerBuffer.size === 0) return
    const wait = TICKER_PUBLISH_INTERVAL_MS - (Date.now() - lastTickerPublish)
    if (wait <= 0) publishTickers()
    else tickerTimer = setTimeout(publishTickers, wait)
  }

  function applyTickerTick(tick: TickerTick): void {
    const name = currentSymbolName.value
    if (name !== '') {
      pairTickerSeen = true
      tickerBuffer.set(name, toSnapshot(tick))
      schedulePublishTickers()
    }
  }

  function applyReview(payload: Record<string, TickerTick>): void {
    const own = pairTickerSeen && mode.value === 'terminal' ? currentSymbolName.value : ''
    Object.entries(payload).forEach(([key, tick]) => {
      if (own !== '' && key.toLowerCase() === own) return
      if (tick !== null && typeof tick === 'object') {
        tickerBuffer.set(key.toLowerCase(), toSnapshot(tick))
      }
    })
    schedulePublishTickers()
  }

  function publishDepth(): void {
    publishTimer = null
    lastPublishAt = Date.now()
    // Always grouped at the selected step (the first option is the tick): asks ceil, bids floor.
    const step = depthStep.value
    const extend = coarseLevel !== null
    buys.value = composeSide(fineLevels('bid'), extend ? coarseBook.levels('bid') : null, step, 'bid', MAX_DEPTH_ROWS)
    asks.value = composeSide(fineLevels('ask'), extend ? coarseBook.levels('ask') : null, step, 'ask', MAX_DEPTH_ROWS)
    fineBook.clearFlash()
    coarseBook.clearFlash()
  }

  /** Finest book: the sequenced feed while live, else the step0 channel. */
  function fineLevels(side: 'ask' | 'bid'): RawLevel[] {
    if (depthFeed.value === 'seq') return side === 'ask' ? seqLevels.asks : seqLevels.bids
    return fineBook.levels(side)
  }

  function onSeqBook(next: { asks: RawLevel[]; bids: RawLevel[]; symbol: string }): void {
    if (next.symbol !== currentSymbolName.value || seqDepthStatus.value !== 'live') return
    seqLevels = { asks: next.asks, bids: next.bids }
    depthFeed.value = 'seq'
    // The client already coalesces to one emit per publish interval.
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishDepth()
  }

  function onSeqStatus(status: SeqDepthStatus): void {
    seqDepthStatus.value = status
    if (status === 'live' || depthFeed.value !== 'seq') return
    // Fall back to the step0 channel at once (it stayed subscribed).
    depthFeed.value = 'legacy'
    seqLevels = { asks: [], bids: [] }
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishDepth()
  }

  function startSeqDepth(symbol: string): void {
    stopSeqDepth()
    if (symbol === '' || !isSpotSeqDepthEnabled()) return
    seqDepth ??= new SeqDepthClient({
      wsUrl: SPOT_SEQ_DEPTH_WS_URL,
      snapshotUrl: SPOT_SEQ_DEPTH_SNAPSHOT_URL,
      emitIntervalMs: DEPTH_PUBLISH_INTERVAL_MS,
      onBook: onSeqBook,
      onStatus: onSeqStatus,
    })
    seqDepth.start(symbol)
  }

  function stopSeqDepth(): void {
    seqDepth?.stop()
    depthFeed.value = 'legacy'
    seqLevels = { asks: [], bids: [] }
  }

  function schedulePublish(): void {
    if (publishTimer !== null) return
    const wait = lastPublishAt + DEPTH_PUBLISH_INTERVAL_MS - Date.now()
    if (wait <= 0) publishDepth()
    else publishTimer = setTimeout(publishDepth, wait)
  }

  function coarseLevelFor(index: number): number | null {
    const levels = currentSymbol.value?.depthLevels ?? []
    const channel = coarseChannelForStep(bookSteps.value[index] ?? '', currentSymbol.value?.rules.depthSteps ?? [])
    return channel === null ? null : levels[channel] ?? null
  }

  function applyTradeTick(tick: TradeTick): void {
    trades.value = [tick, ...trades.value].slice(0, MAX_TRADES)
  }

  function applyTradeHistory(payload: unknown): void {
    if (Array.isArray(payload)) {
      trades.value = [...payload as TradeTick[]].sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, MAX_TRADES) // float-ok: timestamp ordering
    }
  }

  function handleMessage(message: WsMessage): void {
    lastMessageAt.value = Date.now()
    const parsed = parseChannel(message.channel ?? '')
    const expected = currentSymbolName.value
    if (parsed.kind === 'review') {
      const payload = message.data ?? message.tick
      if (payload !== null && typeof payload === 'object') {
        applyReview(payload as Record<string, TickerTick>)
      }
      return
    }
    if (expected !== '' && parsed.symbol !== expected) {
      return
    }
    if (parsed.kind === 'ticker' && message.tick !== undefined) {
      applyTickerTick(message.tick as TickerTick)
      return
    }
    if (parsed.kind === 'trade') {
      if (message.event_rep === 'rep') {
        applyTradeHistory(message.data)
      } else {
        const tick = message.tick as { data?: TradeTick[] } | undefined
        if (tick?.data !== undefined && Array.isArray(tick.data)) {
          tick.data.forEach((entry) => applyTradeTick(entry))
        }
      }
      return
    }
    if (parsed.kind === 'depth' && message.tick !== undefined) {
      const book = parsed.depthLevel === String(depthLevel.value)
        ? fineBook
        : coarseLevel !== null && parsed.depthLevel === String(coarseLevel) ? coarseBook : null
      if (book === null) return
      const tick = message.tick as DepthDelta & DepthSnapshot
      if (tick.side === 'asks' || tick.side === 'buys') book.applyDelta(tick)
      else book.applySnapshot(tick)
      schedulePublish()
    }
    // K-line frames belong to the chart datafeed and the trend request.
  }

  function ensureLease(): SocketLease {
    if (lease !== null && lease.url !== resolveWsUrl()) {
      // Public info named another socket than the fallback the prefetch used: move over.
      leaseOffs.forEach((off) => off())
      leaseOffs = []
      pairChannels = []
      lease.release()
      lease = null
    }
    if (lease === null) {
      const next = sharedSockets.acquire(resolveWsUrl())
      lease = next
      connectionState.value = next.state
      leaseOffs = [
        next.onStateChange((state) => {
          connectionState.value = state
        }),
        next.onMessage(handleMessage),
      ]
    } else {
      lease.connect()
    }
    return lease
  }

  function effectiveMode(): MarketMode | null {
    if (users.size === 0) return null
    return [...users.values()].includes('terminal') ? 'terminal' : 'overview'
  }

  /** (Re)subscribes the channels the active pages need for the current pair. */
  function resubscribe(): void {
    const wanted = effectiveMode()
    mode.value = wanted
    if (wanted === null) return
    const active = ensureLease()
    pairChannels.forEach((channel) => active.unsubscribe(channel))
    pairChannels = []
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishTimer = null
    asks.value = []
    buys.value = []
    fineBook.clear()
    coarseBook.clear()
    trades.value = []
    restoreTickerFromMap()
    pairTickerSeen = false

    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
    armReviewRefresh()
    const symbol = currentSymbolName.value
    if (wanted !== 'terminal' || symbol === '') {
      stopSeqDepth()
      return
    }
    startSeqDepth(symbol)
    const level = depthLevel.value
    coarseLevel = coarseLevelFor(depthStepIndex.value)
    if (coarseLevel === level) coarseLevel = null
    pairChannels = [tickerChannel(symbol), tradeChannel(symbol), depthChannel(symbol, level)]
    active.registerChannel(tickerChannel(symbol), buildTickerRequest('sub', symbol).params)
    active.registerChannel(tradeChannel(symbol), buildTradeRequest('req', symbol, MAX_TRADES).params, 'req')
    active.registerChannel(tradeChannel(symbol), buildTradeRequest('sub', symbol, MAX_TRADES).params)
    active.registerChannel(depthChannel(symbol, level), buildDepthRequest('sub', symbol, level).params)
    if (coarseLevel !== null) {
      pairChannels.push(depthChannel(symbol, coarseLevel))
      active.registerChannel(depthChannel(symbol, coarseLevel), buildDepthRequest('sub', symbol, coarseLevel).params)
    }
  }

  /**
   * A page starts using the market stream; returns the matching stop function. Leaving a page only
   * returns its lease: the shared socket stays open for a grace period so the next market page
   * (home -> trade) reuses it.
   */
  function start(pageMode: MarketMode): () => void {
    const id = Symbol(pageMode)
    users.set(id, pageMode)
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
    resubscribe()
    // A market list set up before this page took the stream has its trends queued.
    enqueueTrends()
    return () => {
      if (!users.delete(id)) return
      if (users.size > 0) {
        resubscribe()
        return
      }
      releaseStream()
    }
  }

  /**
   * Opens the socket and the review stream before the page chunk has loaded (route prefetch), so
   * the handshake overlaps the chunk download. Held for one grace period; the page's `start` takes
   * it over, and if no market page follows it is returned.
   */
  function warmUp(): void {
    if (lease !== null) return
    const active = ensureLease()
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
    warmTimer = setTimeout(() => {
      warmTimer = null
      if (users.size === 0) releaseStream()
    }, SOCKET_RELEASE_GRACE_MS)
  }

  function armReviewRefresh(): void {
    if (reviewTimer !== null) return
    reviewTimer = setInterval(() => {
      if (tabHidden()) return
      // Refresh listing flags and paused-trading status even on a long-lived terminal tab. Both fetches dedupe/cache.
      void loadPublicInfo()
      if (lease === null || !lease.isOpen) return
      lease.send({ event: 'req', params: buildReviewRequest('req').params })
    }, REVIEW_REFRESH_MS)
  }

  function stopReviewRefresh(): void {
    if (reviewTimer !== null) clearInterval(reviewTimer)
    reviewTimer = null
  }

  function tabHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  function trendFresh(symbol: string): boolean {
    const at = trendAt.get(symbol)
    return at !== undefined && Date.now() - at < TREND_TTL_MS
  }

  function wantedTrendSymbols(): string[] {
    const hero = trendHero ? tickerSymbol.value : ''
    return [...new Set([hero, ...trendRows])].filter((symbol) => symbol !== '')
  }

  /** Queues every wanted pair whose trend is stale; the hero pair goes first. */
  function enqueueTrends(): void {
    const wanted = wantedTrendSymbols()
    trendQueue = trendQueue.filter((symbol) => wanted.includes(symbol))
    wanted.forEach((symbol) => {
      if (trendFresh(symbol) || trendInflight.has(symbol) || trendQueue.includes(symbol)) return
      trendQueue.push(symbol)
    })
    pumpTrends()
    armTrendRefresh()
  }

  /** Starts queued requests up to the concurrency limit (only with a live lease and a visible tab). */
  function pumpTrends(): void {
    if (lease === null || tabHidden()) return
    while (trendInflight.size < TREND_CONCURRENCY && trendQueue.length > 0) {
      const symbol = trendQueue.shift() as string
      if (trendFresh(symbol) || trendInflight.has(symbol)) continue
      requestTrend(lease, symbol)
    }
  }

  function requestTrend(active: SocketLease, symbol: string): void {
    const request = buildKlineRequest('req', symbol, TREND_SCALE, { pageSize: TREND_POINTS })
    let settled = false
    const token = (): void => cancel()
    let cancel: () => void = () => undefined
    trendInflight.set(symbol, token)
    cancel = active.request(klineChannel(symbol, TREND_SCALE), request.params, {
      timeoutMs: TREND_TIMEOUT_MS,
      onSettle: (outcome, message) => {
        if (settled) return
        settled = true
        if (trendInflight.get(symbol) !== token) return
        trendInflight.delete(symbol)
        if (outcome === 'ok' && Array.isArray(message?.data)) {
          trendAt.set(symbol, Date.now())
          const values = (message.data as KlineBar[])
            .slice(-TREND_POINTS)
            .map((bar) => toNumberForDisplay(canonicalDecimal(toDecString(bar.close))) ?? Number.NaN)
            .filter((value) => Number.isFinite(value))
          trends.value = { ...trends.value, [symbol]: values }
        }
        // A failed request leaves the pair unloaded; the next refresh round retries it.
        pumpTrends()
      },
    })
  }

  /** Re-checks the wanted pairs once per TTL while a page holds the stream. */
  function armTrendRefresh(): void {
    if (trendTimer !== null || lease === null || wantedTrendSymbols().length === 0) return
    trendTimer = setTimeout(() => {
      trendTimer = null
      if (tabHidden()) return // the visibility listener refreshes on return
      enqueueTrends()
    }, TREND_TTL_MS)
  }

  function bindTrendVisibility(): void {
    if (trendVisibilityBound || typeof document === 'undefined') return
    trendVisibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (!tabHidden() && lease !== null) enqueueTrends()
    })
  }

  /**
   * The last page left: cancels in-flight trend requests, the queue and the refresh timer. The cache
   * stays (a page opened within the TTL shows it at once); the next page states what it wants.
   */
  function stopTrends(): void {
    const cancels = [...trendInflight.values()]
    trendInflight.clear()
    cancels.forEach((cancel) => cancel())
    trendQueue = []
    trendRows = []
    trendHero = false
    if (trendTimer !== null) clearTimeout(trendTimer)
    trendTimer = null
  }

  /**
   * Hourly trend of the selected pair for the home hero sparkline: one-shot K-line `req`, no
   * subscription, refreshed at most every five minutes (shared per-pair cache with `loadTrends`).
   */
  function loadTrend(): void {
    trendHero = true
    bindTrendVisibility()
    enqueueTrends()
  }

  /**
   * Hourly trends of the pairs the market list currently shows (channel symbols). Replaces
   * the previous list: pairs scrolled/filtered away are dropped from the queue. Requests start once a
   * page holds the stream, two at a time, and pause while the tab is hidden.
   */
  function loadTrends(symbolsInView: string[]): void {
    trendRows = [...new Set(symbolsInView.filter((symbol) => symbol !== ''))]
    bindTrendVisibility()
    enqueueTrends()
  }

  function releaseStream(): void {
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
    tickerLive.value = false
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishTimer = null
    if (tickerTimer !== null) clearTimeout(tickerTimer)
    tickerTimer = null
    tickerBuffer.clear()
    stopReviewRefresh()
    stopTrends()
    stopSeqDepth()
    leaseOffs.forEach((off) => off())
    leaseOffs = []
    pairChannels = []
    lease?.release()
    lease = null
    mode.value = null
    connectionState.value = 'closed'
  }

  function selectPair(pair: string): void {
    if (pair === selectedPair.value) {
      return
    }
    selectedPair.value = pair
    depthStepIndex.value = 0
    resubscribe()
    if (trendHero) enqueueTrends()
  }

  /** The chart follows `klineScale` through its own datafeed; the store only keeps the choice. */
  function setKlineScale(scale: string): void {
    klineScale.value = scale
  }

  /**
   * Changes the grouping step. The fine channel stays subscribed (the book is regrouped at once,
   * never blanked); only the coarse channel is swapped.
   */
  function setDepthStepIndex(index: number): void {
    if (index === depthStepIndex.value || index < 0 || index >= bookSteps.value.length) {
      return
    }
    depthStepIndex.value = index
    const symbol = currentSymbolName.value
    let next = coarseLevelFor(index)
    if (next === depthLevel.value) next = null
    if (lease !== null && mode.value === 'terminal' && symbol !== '' && next !== coarseLevel) {
      if (coarseLevel !== null) {
        const old = depthChannel(symbol, coarseLevel)
        lease.unsubscribe(old)
        pairChannels = pairChannels.filter((channel) => channel !== old)
      }
      coarseBook.clear()
      coarseLevel = next
      if (next !== null) {
        pairChannels.push(depthChannel(symbol, next))
        lease.registerChannel(depthChannel(symbol, next), buildDepthRequest('sub', symbol, next).params)
      }
    }
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishDepth()
  }

  /** Drops every page's use of the stream at once (the shared socket closes after its grace). */
  function disconnect(): void {
    users.clear()
    releaseStream()
  }

  /** The chart leases the same shared socket. */
  function chartWsUrl(): string {
    return resolveWsUrl()
  }

  return {
    publicInfo,
    publicInfoLoading,
    publicInfoError,
    publicInfoRetry,
    selectedPair,
    ticker,
    tickers,
    tickerReceived,
    tickerLive,
    trend,
    trends,
    mode,
    trades,
    asks,
    buys,
    depthStepIndex,
    depthStep,
    depthLevel,
    depthFeed,
    seqDepthStatus,
    bookSteps,
    klineScale,
    klineScales,
    connectionState,
    lastMessageAt,
    symbols,
    allSymbols,
    closedSymbols,
    currentTradingClosed,
    quoteGroups,
    currentSymbol,
    currentSymbolName,
    loadPublicInfo,
    selectPair,
    setKlineScale,
    setDepthStepIndex,
    resubscribe,
    start,
    warmUp,
    loadTrend,
    loadTrends,
    disconnect,
    chartWsUrl,
  }
})

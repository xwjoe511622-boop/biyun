import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { SymbolInfo } from 'klinecharts'
import { isApiError } from '@/core/errors'
import { describeApiError } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import { i18n } from '@/i18n'
import { canonicalDecimal, toDecString } from '@/modules/finance/decimal'
import { DEFAULT_KLINE_SCALES } from '@/modules/market/symbols'
import { FUTURES_PUBLIC_INFO_FRESH_MS, fetchFuturesPublicInfo, fetchPublicMarketInfo, readCachedFuturesPublicInfo } from '@/modules/futures/api'
import { futuresTradeValue, futuresTurnover } from '@/modules/futures/math'
import { buildContracts, contractWsSymbol, pickDefaultContract, type FuturesContract } from '@/modules/futures/contracts'
import { DepthBook } from '@/modules/market/depth-book'
import { coarseChannelForStep, composeSide, tickDepthSteps, tickFromPrecision, type RawLevel } from '@/modules/market/book-aggregate'
import { FUTURES_FALLBACK_WS_URL, FUTURES_SEQ_DEPTH_SNAPSHOT_URL, FUTURES_SEQ_DEPTH_WS_URL, FUTURES_WS_URL_OVERRIDE } from '@/modules/futures/endpoints'
import type { FuturesMarketInfo, FuturesPublicInfo } from '@/modules/futures/types'
import type { SocketState } from '@/modules/ws/kline-socket'
import { SOCKET_RELEASE_GRACE_MS, sharedSockets, type SocketLease } from '@/modules/ws/shared-socket'
import { SeqDepthClient, isFuturesSeqDepthEnabled, type SeqDepthStatus } from '@/modules/ws/seq-depth'
import {
  REVIEW_CHANNEL,
  buildDepthRequest,
  buildReviewRequest,
  buildTickerRequest,
  buildTradeRequest,
  depthChannel,
  parseChannel,
  tickerChannel,
  tradeChannel,
  type DepthDelta,
  type DepthSnapshot,
  type TickerTick,
  type TradeTick,
  type WsMessage,
} from '@/modules/ws/protocol'
import type { MarketSourceSymbol } from '@/components/trade/market-source'
import type { BookTop } from '@/modules/futures/order-entry'
import type { DepthLevel, TickerSnapshot } from './market'

const STORAGE_KEY = 'picat.futures.contract'
/**
 * Book renders are throttled, not delayed: the first change after a quiet interval renders at once (leading edge), a
 * burst renders at most once per interval with a trailing render for the last change (09-30: a trailing-only 200 ms
 * timer delayed every best-level change by ~210 ms, journal BOOK_LATENCY_20260930).
 */
const DEPTH_PUBLISH_INTERVAL_MS = 100
const MAX_TRADES = 60
const MAX_DEPTH_ROWS = 30
const BOOK_TOP_LEVELS = 5
const MARKET_INFO_INTERVAL_MS = 10_000

function emptyTicker(): TickerSnapshot {
  return { close: '', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
}

function emptyMarketInfo(): FuturesMarketInfo {
  return { tagPrice: '', indexPrice: '', currentFundRate: '', nextFundRate: '' }
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function save(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // Private mode: the selection simply is not remembered.
  }
}

/** Chart symbol info carries the contract name (`E-BTC-USDT`) as its ticker. */
export function futuresChartChannelSymbol(symbol: SymbolInfo | null | undefined): string {
  const ticker = symbol?.ticker
  return typeof ticker === 'string' ? contractWsSymbol(ticker) : ''
}

/**
 * USDT-margined perpetual market data: contract list (`common/public_info`), mark/index/funding
 * (`common/public_market_info`, polled) and the futures market WebSocket (ticker, book, trades).
 * The socket is the tab-wide shared one for the futures URL (`modules/ws/shared-socket`); the
 * futures chart leases the same connection for K-line history and live bars. It implements
 * `MarketSource`, so the shared terminal widgets render it unchanged. Nothing is synthesised:
 * without a socket the book/trades stay empty and the UI says so.
 */
export const useFuturesMarketStore = defineStore('futures-market', () => {
  const contracts = shallowRef<FuturesContract[]>([])
  /** Metadata needed to close existing exposure remains available after delisting. */
  const archivedContracts = shallowRef<FuturesContract[]>([])
  const allContracts = computed(() => [...new Map([...archivedContracts.value, ...contracts.value].map(entry => [entry.id, entry])).values()])
  const wsUrlFromServer = ref('')
  const serverTimeOffset = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Retry number while `common/public_info` is being retried after a transport failure (0 = none). */
  const retry = ref(0)
  const loaded = ref(false)
  const selectedName = ref<string>(readSaved() ?? '')

  const ticker = shallowRef<TickerSnapshot>(emptyTicker())
  const tickers = shallowRef<Record<string, TickerSnapshot>>({})
  const tickerReceived = ref(false)
  const trades = shallowRef<TradeTick[]>([])
  const asks = shallowRef<DepthLevel[]>([])
  const buys = shallowRef<DepthLevel[]>([])
  /** First levels of the finest (ungrouped) book, for the ticket's best-price shortcuts. */
  const bookTop = shallowRef<BookTop>({ asks: [], bids: [] })
  const depthStepIndex = ref(0)
  const klineScale = ref('5min') // owner 10-22: open on 5m (was 15m)
  const klineScales = ref<string[]>([...DEFAULT_KLINE_SCALES])
  const connectionState = ref<SocketState>('idle')
  const lastMessageAt = ref<number | null>(null)

  const marketInfo = shallowRef<FuturesMarketInfo>(emptyMarketInfo())
  const marketInfoError = ref<string | null>(null)

  const currentContract = computed<FuturesContract | undefined>(() =>
    contracts.value.find((entry) => entry.contractName === selectedName.value),
  )
  const currentSymbolName = computed(() => currentContract.value?.wsSymbol ?? '')
  /**
   * Book grouping steps from the contract's price tick (`symbolPricePrecision`; BTC perp 1 -> 0.1 / 1 / 10 / 100,
   * matching its exchange filter tickSize 0.1), not the server channel list (still 0.01 / 0.1 / 1 for BTC perp).
   */
  const bookSteps = computed(() => tickDepthSteps(tickFromPrecision(currentContract.value?.pricePrecision), currentContract.value?.depthSteps ?? []))
  const depthStep = computed(() => bookSteps.value[depthStepIndex.value] ?? bookSteps.value[0] ?? '')
  /** Mark price (from `public_market_info`), shown in the book's mid row. */
  const markPrice = computed(() => marketInfo.value.tagPrice)

  /** `MarketSource` view of the contract: the book and trades are quoted in contracts. */
  const currentSymbol = computed<MarketSourceSymbol | undefined>(() => {
    const contract = currentContract.value
    if (contract === undefined) return undefined
    return {
      symbol: contract.wsSymbol,
      pair: contract.contractName,
      base: contract.base,
      quote: contract.quote,
      pricePrecision: contract.pricePrecision,
      volumePrecision: 0,
      rules: { depthSteps: contract.depthSteps },
      volumeUnit: i18n.global.t('orderDisplay.cont'),
      valueMultiplier: contract.multiplier,
    }
  })

  const wsUrl = computed(() => FUTURES_WS_URL_OVERRIDE ?? (wsUrlFromServer.value !== '' ? wsUrlFromServer.value : FUTURES_FALLBACK_WS_URL))
  const wsConfigured = computed(() => wsUrl.value !== '')

  /** Finest server channel (step0): always subscribed, grouped client-side at the chosen step. */
  const book = new DepthBook()
  /** Coarse server channel for the chosen step (extends the book beyond the fine range), if any. */
  const coarseBook = new DepthBook()
  let coarseLevel: number | null = null
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let lastPublishAt = 0
  let lease: SocketLease | null = null
  let leaseOffs: (() => void)[] = []
  let warmTimer: ReturnType<typeof setTimeout> | null = null
  let publicInfoPromise: Promise<void> | null = null
  let publicInfoFetchedAt = 0
  let infoTimer: ReturnType<typeof setInterval> | null = null
  let infoRequest = 0
  let started = false

  /**
   * Sequenced depth feed (`modules/ws/seq-depth.ts`, futures-md `/fmd/v1`): while it is `live` it
   * replaces the step0 channel as the fine book; otherwise (disabled, connecting, resyncing, failed —
   * the client retries every 60 s) the step0 channel is used exactly as before. The step0 channel
   * stays subscribed throughout so the fallback is instant and never blank.
   *
   * Coarser steps: kept on the existing design — the fine book (now the sequenced one) is grouped
   * client-side (bids floor / asks ceil, `book-aggregate.ts`) and the old coarse `depth_step<n>`
   * channel only extends it beyond the fine range. That is the simpler robust option: no new
   * aggregation code, and the coarse rows keep working whichever fine source is active.
   * Quantities are contracts in both feeds, so the rows carry the same raw values as before.
   */
  const depthFeed = ref<'seq' | 'legacy'>('legacy')
  const seqDepthStatus = ref<SeqDepthStatus>('idle')
  let seqLevels: { asks: RawLevel[]; bids: RawLevel[] } = { asks: [], bids: [] }
  let seqDepth: SeqDepthClient | null = null

  function describe(error_: unknown): string {
    // Localised by (product, code) with sub-reasons; server msg / transport text as the fallback (2026-10-01).
    return describeApiError(error_, requestLanguage())
  }

  function applyInfo(info: FuturesPublicInfo): void {
    contracts.value = buildContracts(info.contractList)
    archivedContracts.value = [...new Map([...archivedContracts.value, ...buildContracts(info.allContractList ?? info.contractList), ...contracts.value].map(entry => [entry.id, entry])).values()]
    wsUrlFromServer.value = info.wsUrl
    if (info.currentTimeMillis !== null) serverTimeOffset.value = info.currentTimeMillis - Date.now()
    const preferred = pickDefaultContract(contracts.value, selectedName.value)
    selectedName.value = preferred?.contractName ?? ''
    loaded.value = true
  }

  async function fetchAndApply(): Promise<void> {
    const info = await fetchFuturesPublicInfo({
      onRetry: (attempt) => {
        retry.value = attempt
      },
    })
    publicInfoFetchedAt = Date.now()
    applyInfo(info)
    error.value = null
  }

  /**
   * Contract list, deduped across callers (route prefetch, the view, the assets page). A cached
   * list renders at once and is revalidated in the background; transport failures are retried with
   * backoff before the error state (with its retry button) is shown.
   */
  async function loadPublicInfo(): Promise<void> {
    if (loaded.value) {
      // Already rendered: refresh quietly; a failed refresh keeps the contract list on screen.
      if (publicInfoPromise === null && Date.now() - publicInfoFetchedAt >= FUTURES_PUBLIC_INFO_FRESH_MS) revalidate()
      return
    }
    if (publicInfoPromise !== null) return publicInfoPromise
    const cached = readCachedFuturesPublicInfo()
    if (cached !== null) {
      applyInfo(cached.data)
      publicInfoFetchedAt = Date.now() - cached.age
      // Always revalidate: the cached copy carries no server clock for the funding countdown.
      revalidate()
      return
    }
    loading.value = true
    error.value = null
    retry.value = 0
    const run = fetchAndApply()
    publicInfoPromise = run
    try {
      await run
    } catch (error_) {
      if (publicInfoPromise === run) error.value = describe(error_)
      throw error_
    } finally {
      if (publicInfoPromise === run) {
        publicInfoPromise = null
        loading.value = false
        retry.value = 0
      }
    }
  }

  function revalidate(): void {
    const background = fetchAndApply().catch(() => undefined).finally(() => {
      if (publicInfoPromise === background) publicInfoPromise = null
    })
    publicInfoPromise = background
  }

  /** Revalidate transfer switches immediately before a money action; failures reject instead of using stale flags. */
  async function refreshPublicInfo(): Promise<void> {
    await fetchAndApply()
  }

  /** Server-corrected clock (for the funding countdown). */
  function now(): number {
    return Date.now() + serverTimeOffset.value
  }

  async function refreshMarketInfo(): Promise<void> {
    const contract = currentContract.value
    if (contract === undefined) return
    const id = (infoRequest += 1)
    try {
      const info = await fetchPublicMarketInfo(contract.id)
      if (id !== infoRequest || currentContract.value?.id !== contract.id) return
      marketInfo.value = info
      marketInfoError.value = null
    } catch (error_) {
      if (id !== infoRequest) return
      marketInfoError.value = describe(error_)
    }
  }

  function startMarketInfo(): void {
    stopMarketInfo()
    void refreshMarketInfo()
    infoTimer = setInterval(() => void refreshMarketInfo(), MARKET_INFO_INTERVAL_MS)
  }

  function stopMarketInfo(): void {
    if (infoTimer !== null) clearInterval(infoTimer)
    infoTimer = null
  }

  function multiplierFor(wsSymbol: string): string {
    return contracts.value.find((entry) => entry.wsSymbol === wsSymbol)?.multiplier ?? ''
  }

  /** `amount` is the true quote turnover (`ws amount * multiplier`, L43); `''` until the contract is known. */
  function toSnapshot(tick: TickerTick, wsSymbol: string): TickerSnapshot {
    const read = (value: unknown): string => canonicalDecimal(toDecString(value))
    return { close: read(tick.close), open: read(tick.open), high: read(tick.high), low: read(tick.low), vol: read(tick.vol), amount: futuresTurnover(read(tick.amount), multiplierFor(wsSymbol)), rose: read(tick.rose) }
  }

  /** Replaces the WS trade `amount` (`vol * price`) with `vol * multiplier * price` (L43). */
  function withValue(rows: TradeTick[]): TradeTick[] {
    const multiplier = currentContract.value?.multiplier ?? ''
    return rows.map((row) => ({ ...row, amount: multiplier === '' ? '' : futuresTradeValue(row, multiplier) }))
  }

  function publishDepth(): void {
    publishTimer = null
    lastPublishAt = Date.now()
    // Always grouped at the selected step (the first option is the tick): asks ceil, bids floor.
    const step = depthStep.value
    const extend = coarseLevel !== null
    asks.value = composeSide(fineLevels('ask'), extend ? coarseBook.levels('ask') : null, step, 'ask', MAX_DEPTH_ROWS)
    buys.value = composeSide(fineLevels('bid'), extend ? coarseBook.levels('bid') : null, step, 'bid', MAX_DEPTH_ROWS)
    bookTop.value = readBookTop()
    book.clearFlash()
    coarseBook.clearFlash()
  }

  /**
   * Live top of book (finest channel, never the grouped rows) read synchronously, so an order priced
   * by a best-price shortcut uses the book as it is at submit time, not the last 200 ms publish.
   */
  function readBookTop(levels = BOOK_TOP_LEVELS): BookTop {
    return {
      asks: fineLevels('ask').slice(0, levels).map((level) => level.price),
      bids: fineLevels('bid').slice(0, levels).map((level) => level.price),
    }
  }

  /** Finest book: the sequenced feed while live, else the step0 channel. */
  function fineLevels(side: 'ask' | 'bid'): RawLevel[] {
    if (depthFeed.value === 'seq') return side === 'ask' ? seqLevels.asks : seqLevels.bids
    return book.levels(side)
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
    if (symbol === '' || !isFuturesSeqDepthEnabled()) return
    seqDepth ??= new SeqDepthClient({
      wsUrl: FUTURES_SEQ_DEPTH_WS_URL,
      snapshotUrl: FUTURES_SEQ_DEPTH_SNAPSHOT_URL,
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

  function handleMessage(message: WsMessage): void {
    lastMessageAt.value = Date.now()
    const parsed = parseChannel(message.channel ?? '')
    const expected = currentSymbolName.value
    if (parsed.kind === 'review') {
      const payload = message.data ?? message.tick
      if (payload !== null && typeof payload === 'object') {
        const next = { ...tickers.value }
        Object.entries(payload as Record<string, TickerTick>).forEach(([key, tick]) => {
          if (tick !== null && typeof tick === 'object') next[key.toLowerCase()] = toSnapshot(tick, key.toLowerCase())
        })
        tickers.value = next
        const own = next[expected]
        if (own !== undefined) {
          ticker.value = own
          tickerReceived.value = true
        }
      }
      return
    }
    if (parsed.kind === 'unknown' || parsed.symbol !== expected) return
    if (parsed.kind === 'ticker' && message.tick !== undefined) {
      ticker.value = toSnapshot(message.tick as TickerTick, expected)
      tickerReceived.value = true
      tickers.value = { ...tickers.value, [expected]: ticker.value }
      return
    }
    if (parsed.kind === 'trade') {
      if (message.event_rep === 'rep') {
        if (Array.isArray(message.data)) {
          trades.value = withValue(message.data as TradeTick[]).sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, MAX_TRADES) // float-ok: timestamp ordering
        }
      } else {
        const tick = message.tick as { data?: TradeTick[] } | undefined
        if (Array.isArray(tick?.data)) trades.value = [...withValue([...tick.data].reverse()), ...trades.value].slice(0, MAX_TRADES)
      }
      return
    }
    if (parsed.kind === 'depth' && message.tick !== undefined) {
      const target = parsed.depthLevel === '0' ? book : coarseLevel !== null && parsed.depthLevel === String(coarseLevel) ? coarseBook : null
      if (target === null) return
      const tick = message.tick as DepthDelta & DepthSnapshot
      if (tick.side === 'asks' || tick.side === 'buys') target.applyDelta(tick)
      else target.applySnapshot(tick)
      // step0 is only kept warm while the sequenced feed drives the book.
      if (target !== book || depthFeed.value !== 'seq') schedulePublish()
    }
    // K-line frames are consumed by the chart datafeed on the same shared socket.
  }

  function ensureLease(): SocketLease | null {
    if (!wsConfigured.value) {
      connectionState.value = 'closed'
      return null
    }
    if (lease !== null && lease.url !== wsUrl.value) releaseLease()
    if (lease === null) {
      const next = sharedSockets.acquire(wsUrl.value)
      lease = next
      connectionState.value = next.state
      leaseOffs = [
        next.onStateChange((state) => {
          connectionState.value = state
          if (state !== 'open') {
            book.clear()
            coarseBook.clear()
            if (publishTimer !== null) clearTimeout(publishTimer)
            publishDepth()
          }
        }),
        next.onMessage(handleMessage),
      ]
    } else {
      lease.connect()
    }
    return lease
  }

  function releaseLease(): void {
    leaseOffs.forEach((off) => off())
    leaseOffs = []
    lease?.release()
    lease = null
  }

  /**
   * Route prefetch: opens the futures socket (with the fallback or cached URL) while the terminal
   * chunk is still downloading. Held for one grace period; `start` takes it over.
   */
  function warmUp(): void {
    if (lease !== null || started) return
    const active = ensureLease()
    if (active === null) return
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
    warmTimer = setTimeout(() => {
      warmTimer = null
      if (!started) releaseLease()
    }, SOCKET_RELEASE_GRACE_MS)
  }

  function resetStreams(): void {
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishTimer = null
    book.clear()
    coarseBook.clear()
    asks.value = []
    buys.value = []
    bookTop.value = { asks: [], bids: [] }
    trades.value = []
    ticker.value = tickers.value[currentSymbolName.value] ?? emptyTicker()
    tickerReceived.value = tickers.value[currentSymbolName.value] !== undefined
  }

  /** (Re)subscribes ticker, trades and book for the current contract. */
  function resubscribe(): void {
    resetStreams()
    const active = ensureLease()
    const symbol = currentSymbolName.value
    startSeqDepth(symbol)
    if (active === null || symbol === '') return
    active.unsubscribeAll()
    coarseLevel = coarseChannelForStep(depthStep.value, currentContract.value?.depthSteps ?? [])
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
    active.registerChannel(tickerChannel(symbol), buildTickerRequest('sub', symbol).params)
    active.registerChannel(tradeChannel(symbol), buildTradeRequest('req', symbol, MAX_TRADES).params, 'req')
    active.registerChannel(tradeChannel(symbol), buildTradeRequest('sub', symbol, MAX_TRADES).params)
    active.registerChannel(depthChannel(symbol, 0), buildDepthRequest('sub', symbol, 0).params)
    if (coarseLevel !== null) active.registerChannel(depthChannel(symbol, coarseLevel), buildDepthRequest('sub', symbol, coarseLevel).params)
  }

  function selectContract(name: string): void {
    if (name === selectedName.value || !contracts.value.some((entry) => entry.contractName === name)) return
    selectedName.value = name
    save(name)
    depthStepIndex.value = 0
    marketInfo.value = emptyMarketInfo()
    // Pages without live widgets (futures data) only switch the selection.
    if (!started) return
    resubscribe()
    startMarketInfo()
  }

  function setKlineScale(scale: string): void {
    if (scale !== klineScale.value && klineScales.value.includes(scale)) klineScale.value = scale
  }

  /**
   * Changes the grouping step. The fine channel stays subscribed (no reset, no blank book): the
   * book is regrouped at once and only the coarse channel is swapped.
   */
  function setDepthStepIndex(index: number): void {
    if (index === depthStepIndex.value || index < 0 || index >= bookSteps.value.length) return
    depthStepIndex.value = index
    const symbol = currentSymbolName.value
    const next = coarseChannelForStep(bookSteps.value[index] ?? '', currentContract.value?.depthSteps ?? [])
    if (lease !== null && symbol !== '' && next !== coarseLevel) {
      if (coarseLevel !== null) lease.unsubscribe(depthChannel(symbol, coarseLevel))
      coarseBook.clear()
      coarseLevel = next
      if (next !== null) lease.registerChannel(depthChannel(symbol, next), buildDepthRequest('sub', symbol, next).params)
    }
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishDepth()
  }

  function start(): void {
    started = true
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
    resubscribe()
    startMarketInfo()
  }

  /** Leaves the terminal; the shared socket closes after its grace period unless reused. */
  function disconnect(): void {
    started = false
    stopMarketInfo()
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishTimer = null
    stopSeqDepth()
    releaseLease()
    connectionState.value = 'closed'
  }

  /** The chart leases the same shared socket (same resolved URL). */
  function chartWsUrl(): string {
    return wsUrl.value
  }

  return {
    contracts,
    allContracts,
    loading,
    error,
    retry,
    loaded,
    selectedName,
    currentContract,
    currentSymbol,
    currentSymbolName,
    ticker,
    tickers,
    tickerReceived,
    trades,
    asks,
    buys,
    bookTop,
    readBookTop,
    depthStepIndex,
    bookSteps,
    depthStep,
    markPrice,
    klineScale,
    klineScales,
    connectionState,
    lastMessageAt,
    depthFeed,
    bookConnectionState: computed(() => depthFeed.value === 'seq' ? 'open' : connectionState.value),
    seqDepthStatus,
    marketInfo,
    marketInfoError,
    wsUrl,
    wsConfigured,
    serverTimeOffset,
    loadPublicInfo,
    refreshPublicInfo,
    refreshMarketInfo,
    now,
    selectContract,
    setKlineScale,
    setDepthStepIndex,
    resubscribe,
    start,
    warmUp,
    disconnect,
    chartWsUrl,
    chartChannelSymbol: futuresChartChannelSymbol,
    handleMessage,
  }
})

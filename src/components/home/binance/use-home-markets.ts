import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type ComputedRef, type ShallowRef } from 'vue'
import { canonicalDecimal, cmpSigned, groupDigits, isDecimalString, isSignedDecimalString, sum, toDecString } from '@/modules/finance/decimal'
import { percentView, type PercentView } from '@/modules/finance/display'
import type { FuturesContract } from '@/modules/futures/contracts'
import { REVIEW_CHANNEL, buildReviewRequest, parseChannel, type TickerTick, type WsMessage } from '@/modules/ws/protocol'
import { sharedSockets, type SocketLease } from '@/modules/ws/shared-socket'
import { useRouter } from 'vue-router'
import { useMarketStore, type TickerSnapshot } from '@/stores/market'

/**
 * Home market data for the Binance skin. Spot: the market store's `review` tickers (the home page starts the
 * overview stream). Futures: the contract list from the futures store plus this page's own lease of the shared
 * futures socket, subscribed to `review` only (all contracts in one stream) and released on unmount. Futures
 * turnover is corrected by the contract face value (`futuresTurnover`, the WS `amount` omits it). Every figure
 * is a decimal string from the stream; a market without a pushed ticker renders `--`.
 */

export type MarketKind = 'spot' | 'futures'
/** Asset class of the base: tokenised gold and US stocks are labelled so the page can group them. */
export type AssetClass = 'crypto' | 'gold' | 'stock'

export interface HomeMarketRow {
  key: string
  kind: MarketKind
  base: string
  quote: string
  /** `BTC/USDT` (spot) or `BTCUSDT` (perpetual). */
  label: string
  /** Coin long name when public info has one. */
  name: string
  icon: string
  assetClass: AssetClass
  pricePrecision: number
  /** Formatted last price or `--`. */
  last: string
  change: PercentView
  /** Raw ratio for sorting (`''` when unknown). */
  rose: string
  high: string
  low: string
  /** Quote-coin turnover as a decimal string (`''` when unknown). */
  turnover: string
  /** Spot pair flagged as a new listing in the admin (`newcoinFlag`). */
  isNew: boolean
  /** Leverage cap for perpetuals (`0` for spot). */
  maxLever: number
  /** Spot `BTC/USDT` or contract name `E-BTC-USDT`: what the trade action selects. */
  target: string
}

/** Tokenised real-world assets by base symbol (classification for labels only). */
const GOLD_BASES = new Set(['XAUT', 'PAXG'])
const STOCK_BASES = new Set(['NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'COIN', 'MSTR', 'SPY', 'QQQ'])

export function assetClassOf(base: string, longName = ''): AssetClass {
  const upper = base.toUpperCase()
  if (GOLD_BASES.has(upper)) return 'gold'
  if (STOCK_BASES.has(upper) || /tokenized stock/i.test(longName)) return 'stock'
  return 'crypto'
}

function priceText(value: string, precision: number): string {
  const normalized = canonicalDecimal(value)
  return isDecimalString(normalized) ? groupDigits(normalized, precision) : '--'
}

/**
 * Descending exact decimal sort; values that are not decimal strings (`''`, `--`) sink to the bottom.
 * Signed on purpose: 24h change ratios are negative on a red day (`cmp` only takes non-negative amounts and threw
 * on `"-0.0027"`, which crashed the gainers tabs — owner 10-22).
 */
export function byDecimalDesc<T>(pick: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = pick(a)
    const right = pick(b)
    const leftOk = isSignedDecimalString(left)
    const rightOk = isSignedDecimalString(right)
    if (!leftOk || !rightOk) return leftOk === rightOk ? 0 : leftOk ? -1 : 1
    return cmpSigned(right, left)
  }
}

export interface HomeMarkets {
  spotRows: ComputedRef<HomeMarketRow[]>
  futuresRows: ComputedRef<HomeMarketRow[]>
  futuresTickers: ShallowRef<Record<string, TickerSnapshot>>
  /** Sum of 24h USDT turnover over every spot pair and perpetual with a pushed ticker; `''` when none yet. */
  totalTurnover: ComputedRef<string>
  maxLever: ComputedRef<number>
}

export function useHomeMarkets(): HomeMarkets {
  const market = useMarketStore()
  const futuresTickers = shallowRef<Record<string, TickerSnapshot>>({})
  /**
   * The futures store and maths live in the terminal's `futures` chunk, so they are imported after the home has
   * rendered instead of delaying it; until then the perpetual rows are simply absent.
   */
  const contracts = shallowRef<FuturesContract[]>([])
  let turnoverOf: ((wsAmount: string, multiplier: string) => string) | null = null

  let lease: SocketLease | null = null
  let offs: (() => void)[] = []
  let disposed = false

  function multiplierFor(wsSymbol: string): string {
    return contracts.value.find((contract) => contract.wsSymbol === wsSymbol)?.multiplier ?? ''
  }

  function snapshotOf(tick: TickerTick, multiplier: string): TickerSnapshot {
    const read = (value: unknown): string => canonicalDecimal(toDecString(value))
    const amount = turnoverOf === null ? '' : turnoverOf(read(tick.amount), multiplier)
    return { close: read(tick.close), open: read(tick.open), high: read(tick.high), low: read(tick.low), vol: read(tick.vol), amount, rose: read(tick.rose) }
  }

  function onMessage(message: WsMessage): void {
    if (parseChannel(message.channel ?? '').kind !== 'review') return
    const payload = message.data ?? message.tick
    if (payload === null || typeof payload !== 'object') return
    const next = { ...futuresTickers.value }
    Object.entries(payload as Record<string, TickerTick>).forEach(([key, tick]) => {
      if (tick !== null && typeof tick === 'object') next[key.toLowerCase()] = snapshotOf(tick, multiplierFor(key.toLowerCase()))
    })
    futuresTickers.value = next
  }

  function connect(url: string): void {
    if (disposed || url === '' || lease?.url === url) return
    release()
    const next = sharedSockets.acquire(url)
    lease = next
    offs = [next.onMessage(onMessage)]
    next.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    next.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
    next.connect()
  }

  function release(): void {
    offs.forEach((off) => off())
    offs = []
    lease?.release()
    lease = null
  }

  let stopWatch: (() => void) | null = null
  onMounted(async () => {
    const [{ useFuturesMarketStore }, { futuresTurnover }] = await Promise.all([import('@/stores/futures-market'), import('@/modules/futures/math')])
    if (disposed) return
    turnoverOf = futuresTurnover
    const futures = useFuturesMarketStore()
    try {
      await futures.loadPublicInfo()
    } catch {
      // No contracts: the perpetual rows stay empty.
    }
    if (disposed) return
    // The server's socket URL arrives with the contract list (and may change on revalidation).
    stopWatch = watch(() => [futures.contracts, futures.wsConfigured ? futures.wsUrl : ''] as const, ([list, url]) => {
      contracts.value = list
      connect(url)
    }, { immediate: true })
  })
  onBeforeUnmount(() => {
    disposed = true
    stopWatch?.()
    release()
  })

  const coinList = computed(() => market.publicInfo?.market?.coinList ?? {})

  const newFlags = computed<Set<string>>(() => {
    const flags = new Set<string>()
    Object.values(market.publicInfo?.market?.market ?? {}).forEach((group) => {
      Object.values(group).forEach((info) => {
        if (String(info.newcoinFlag ?? '0') === '1') flags.add(info.symbol.toLowerCase())
      })
    })
    return flags
  })

  const spotRows = computed<HomeMarketRow[]>(() => market.symbols.map((entry) => {
    const ticker = market.tickers[entry.symbol]
    const longName = entry.coin?.showName ?? ''
    return {
      key: `spot:${entry.symbol}`,
      kind: 'spot',
      base: entry.base,
      quote: entry.quote,
      label: entry.showPair,
      name: longName,
      icon: entry.coin?.icon ?? '',
      assetClass: assetClassOf(entry.base, longName),
      pricePrecision: entry.pricePrecision,
      last: ticker === undefined ? '--' : priceText(ticker.close, entry.pricePrecision),
      change: ticker === undefined ? { text: '--', direction: 'flat' } : percentView(ticker.rose),
      rose: ticker?.rose ?? '',
      high: ticker === undefined ? '--' : priceText(ticker.high, entry.pricePrecision),
      low: ticker === undefined ? '--' : priceText(ticker.low, entry.pricePrecision),
      turnover: ticker !== undefined && isDecimalString(ticker.amount) ? ticker.amount : '',
      isNew: newFlags.value.has(entry.symbol),
      maxLever: 0,
      target: entry.pair,
    }
  }))

  const futuresRows = computed<HomeMarketRow[]>(() => contracts.value.map((contract) => {
    const ticker = futuresTickers.value[contract.wsSymbol]
    const coin = coinList.value[contract.base.toUpperCase()]
    const longName = typeof coin?.showName === 'string' ? coin.showName : ''
    return {
      key: `futures:${contract.contractName}`,
      kind: 'futures',
      base: contract.base,
      quote: contract.quote,
      label: contract.displayName,
      name: longName,
      icon: typeof coin?.icon === 'string' ? coin.icon : '',
      assetClass: assetClassOf(contract.base, longName),
      pricePrecision: contract.pricePrecision,
      last: ticker === undefined ? '--' : priceText(ticker.close, contract.pricePrecision),
      change: ticker === undefined ? { text: '--', direction: 'flat' } : percentView(ticker.rose),
      rose: ticker?.rose ?? '',
      high: ticker === undefined ? '--' : priceText(ticker.high, contract.pricePrecision),
      low: ticker === undefined ? '--' : priceText(ticker.low, contract.pricePrecision),
      turnover: ticker !== undefined && isDecimalString(ticker.amount) ? ticker.amount : '',
      isNew: false,
      maxLever: contract.maxLever,
      target: contract.contractName,
    }
  }))

  const totalTurnover = computed(() => {
    const values = [...spotRows.value, ...futuresRows.value]
      .filter((row) => row.quote.toUpperCase() === 'USDT' && row.turnover !== '')
      .map((row) => row.turnover)
    return values.length === 0 ? '' : sum(values)
  })

  const maxLever = computed(() => contracts.value.reduce((best, contract) => Math.max(best, contract.maxLever), 0))

  return { spotRows, futuresRows, futuresTickers, totalTurnover, maxLever }
}

/** Opens the right terminal for a row: spot pairs select the pair on /trade, perpetuals select the contract on /futures. */
export function useOpenMarket(): (row: HomeMarketRow) => void {
  const market = useMarketStore()
  const router = useRouter()
  return (row) => {
    if (row.kind === 'spot') {
      market.selectPair(row.target)
      void router.push('/trade')
    } else {
      // Perpetual rows exist only after the futures chunk loaded, so this import resolves from cache.
      void import('@/stores/futures-market').then(({ useFuturesMarketStore }) => {
        useFuturesMarketStore().selectContract(row.target)
        void router.push('/futures')
      })
    }
  }
}

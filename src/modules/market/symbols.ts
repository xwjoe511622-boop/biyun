import type { CoinBalanceEntry, CoinListItem, PublicInfoV4, SymbolInfo } from '@/modules/api/types'
import { canonicalDecimal, toDecString } from '@/modules/finance/decimal'
import { buildSymbolRules, type SymbolRules } from '@/modules/finance/precision'

/**
 * Market configuration projected from `/common/public_info_v4`:
 * `market.market[QUOTE]["BASE/QUOTE"]` plus `market.coinList[BASE]`.
 */

export interface MarketSymbol {
  /** `btcusdt` */
  symbol: string
  /** `BTC/USDT` (server `name`) */
  pair: string
  /** Display pair; falls back to `pair` when the server has no alias. */
  showPair: string
  base: string
  quote: string
  /** Quote market group key, e.g. `USDT`. */
  quoteGroup: string
  pricePrecision: number
  volumePrecision: number
  rules: SymbolRules
  /**
   * Depth WebSocket channel index per server step: `depth` "0.01,0.1,1" -> `market_<sym>_depth_step0/1/2`
   * (wsserver/spot-md stepN = config_symbol depthN_pre, legacy `depthClasses` "0" = finest). Not the decimal
   * places of the step (that subscribed step2 = the 1-unit book as the "0.01" book).
   */
  depthLevels: number[]
  coin: CoinListItem | undefined
  sort: number
}

export const DEFAULT_KLINE_SCALES = [
  '1min',
  '5min',
  '15min',
  '30min',
  '60min',
  '4h',
  '1day',
  '1week',
  '1month',
]

export function normalizeKlineScales(info: PublicInfoV4 | null): string[] {
  const raw = info?.market?.klineScale
  if (Array.isArray(raw)) {
    const cleaned = raw.map((scale) => String(scale).trim()).filter((scale) => scale !== '')
    return cleaned.length > 0 ? cleaned : [...DEFAULT_KLINE_SCALES]
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const cleaned = raw.split(',').map((scale) => scale.trim()).filter((scale) => scale !== '')
    return cleaned.length > 0 ? cleaned : [...DEFAULT_KLINE_SCALES]
  }
  return [...DEFAULT_KLINE_SCALES]
}

function toSymbol(quoteGroup: string, info: SymbolInfo, coinList: Record<string, CoinListItem>): MarketSymbol | null {
  const name = typeof info.name === 'string' ? info.name.trim().toUpperCase() : ''
  const parts = name.split('/')
  if (parts.length !== 2 || parts.some(part => !/^[A-Z0-9_-]+$/.test(part)) || parts[0] === parts[1]) {
    return null
  }
  const base = parts[0]
  const quote = parts[1]
  const rules = buildSymbolRules(info)
  return {
    symbol: typeof info.symbol === 'string' && info.symbol !== ''
      ? info.symbol.toLowerCase()
      : `${base}${quote}`.toLowerCase(),
    pair: `${base}/${quote}`,
    showPair: `${base}/${quote}`,
    base,
    quote,
    quoteGroup,
    pricePrecision: rules.pricePrecision,
    volumePrecision: rules.volumePrecision,
    rules,
    depthLevels: rules.depthSteps.map((_step, index) => index),
    coin: coinList[base],
    sort: typeof info.sort === 'number' ? info.sort : 0,
  }
}

export function buildMarketSymbols(info: PublicInfoV4 | null, options: { includeHidden?: boolean } = {}): MarketSymbol[] {
  const market = info?.market?.market
  if (market === undefined || market === null) {
    return []
  }
  const coinList = info?.market?.coinList ?? {}
  const symbols: MarketSymbol[] = []
  Object.keys(market).forEach((quoteGroup) => {
    const group = market[quoteGroup]
    Object.keys(group).forEach((pair) => {
      const entry: SymbolInfo | undefined = group[pair]
      if (entry === undefined || (!options.includeHidden && entry.isShow !== undefined && ![1, '1', true].includes(entry.isShow))) {
        return
      }
      const symbol = toSymbol(quoteGroup, entry, coinList)
      if (symbol !== null) {
        symbols.push(symbol)
      }
    })
  })
  return symbols.sort((left, right) => left.sort - right.sort)
}

export function findSymbolByPair(symbols: MarketSymbol[], pair: string): MarketSymbol | undefined {
  const wanted = pair.toUpperCase()
  return symbols.find((entry) => entry.pair === wanted)
}

/** First launch pair is BTC/USDT when the server lists it, otherwise the first available pair. */
export function pickDefaultSymbol(symbols: MarketSymbol[], preferred = 'BTC/USDT'): MarketSymbol | undefined {
  return findSymbolByPair(symbols, preferred) ?? symbols[0]
}

/** Accepts `BTC/USDT` or `btcusdt` and returns the server form (`btcusdt`). */
export function pairToSymbolName(pair: string): string {
  return pair.replace('/', '').toLowerCase()
}

/**
 * `allCoinMap` key casing differs between server builds (upper vs lower), so lookups are
 * case-insensitive.
 */
export function findCoinBalance(
  allCoinMap: Record<string, CoinBalanceEntry> | undefined,
  coin: string,
): CoinBalanceEntry | undefined {
  if (allCoinMap === undefined) {
    return undefined
  }
  const direct: CoinBalanceEntry | undefined = allCoinMap[coin]
  if (direct !== undefined) {
    return direct
  }
  const wanted = coin.toUpperCase()
  const key = Object.keys(allCoinMap).find((candidate) => candidate.toUpperCase() === wanted)
  return key === undefined ? undefined : allCoinMap[key]
}

/** Standard spot orders cannot spend the separate legacy overcharge-trading allocation. */
export function sellableBalance(entry: CoinBalanceEntry | undefined): string {
  return availableBalance(entry)
}

export function availableBalance(entry: CoinBalanceEntry | undefined): string {
  if (entry === undefined) {
    return ''
  }
  return canonicalDecimal(toDecString(entry.normal_balance))
}

export function lockedBalance(entry: CoinBalanceEntry | undefined): string {
  if (entry === undefined) {
    return ''
  }
  return canonicalDecimal(toDecString(entry.lock_balance))
}

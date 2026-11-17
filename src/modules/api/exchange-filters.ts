import { Decimal, decimalPlaces, isDecimalString, max as maxDecimal, toDecString } from '@/modules/finance/decimal'
import type { SymbolRules } from '@/modules/finance/precision'
import { request } from './http'

/**
 * Binance-style spot order filters published by the web-api guard (`GET /common/exchange_filters`, 2026-09-29).
 * Used only to pre-check / round the order ticket; the server stays authoritative (-1013 refusals).
 */
export interface SpotSymbolFilter {
  tickSize?: string
  minQty?: string
  maxQty?: string
  stepSize?: string
  minNotional?: string
  maxNotional?: string
  marketMaxQty?: string
  /** PRICE_FILTER bounds (published with the rule row when configured). */
  minPrice?: string
  maxPrice?: string
  /** PERCENT_PRICE_BY_SIDE multipliers around the last trade price (BUY: bid…, SELL: ask…). */
  bidMultiplierUp?: string
  bidMultiplierDown?: string
  askMultiplierUp?: string
  askMultiplierDown?: string
}

interface ExchangeFiltersData {
  filters?: { enabled?: boolean; symbols?: Record<string, SpotSymbolFilter> } | null
}

let cache: Promise<Record<string, SpotSymbolFilter>> | null = null

export function loadSpotFilters(): Promise<Record<string, SpotSymbolFilter>> {
  if (cache === null) {
    cache = request<ExchangeFiltersData>('common/exchange_filters', { method: 'GET', anonymous: true })
      .then((data) => (data?.filters?.enabled === false ? {} : (data?.filters?.symbols ?? {})))
      .catch(() => {
        cache = null // retry on the next ticket open; the server still enforces the rules
        return {}
      })
  }
  return cache
}

/** Test hook. */
export function resetSpotFiltersCache(): void {
  cache = null
}

/**
 * The ticket rules tightened by the filter: quantity decimals no finer than `stepSize`, minimum quantity at least
 * `minQty`. Everything else is left as configured.
 */
export function applySpotFilter(rules: SymbolRules, filter: SpotSymbolFilter | undefined): SymbolRules {
  if (filter === undefined) return rules
  const out = { ...rules }
  const stepDp = filter.stepSize ? decimalPlaces(filter.stepSize) : null
  if (stepDp !== null && stepDp < out.volumePrecision) out.volumePrecision = stepDp
  if (filter.minQty) {
    out.limitVolumeMin = maxDecimal(out.limitVolumeMin || '0', filter.minQty)
    out.marketSellMin = maxDecimal(out.marketSellMin || '0', filter.minQty)
  }
  if (filter.minNotional) {
    out.marketBuyMin = maxDecimal(out.marketBuyMin || '0', filter.minNotional)
  }
  return out
}

/** Futures contract filters (futures-web-api `GET /common/exchange_filters`), keyed by contract id. Quantities in coin. */
export interface FuturesContractFilter {
  name?: string
  multiplier?: string
  /** PRICE_FILTER (published with the rule row when configured). */
  tickSize?: string
  minPrice?: string
  maxPrice?: string
  minQty?: string
  maxQty?: string
  marketMaxQty?: string
  minNotional?: string
  multiplierUp?: string
  multiplierDown?: string
  marketTakeBound?: string
}

let futuresCache: Promise<Record<string, FuturesContractFilter>> | null = null

export function loadFuturesFilters(): Promise<Record<string, FuturesContractFilter>> {
  if (futuresCache === null) {
    futuresCache = request<{ filters?: { enabled?: boolean; contracts?: Record<string, FuturesContractFilter> } | null }>(
      'common/exchange_filters', { api: 'futures', method: 'GET', anonymous: true },
    )
      .then((data) => (data?.filters?.enabled === false ? {} : (data?.filters?.contracts ?? {})))
      .catch(() => {
        futuresCache = null
        return {}
      })
  }
  return futuresCache
}

export function resetFuturesFiltersCache(): void {
  futuresCache = null
}

/** A filter field (decimal string, JSON number or exponent form) as an exact Decimal; missing / malformed / negative -> 0. */
export function filterDecimal(value: unknown): Decimal {
  const text = toDecString(value)
  return isDecimalString(text) ? new Decimal(text) : new Decimal(0)
}

/**
 * Smallest opening order for a contract: max(minQty, minNotional / price) in coin, whole contracts, and its USDT value.
 * Example BTC at 83,000: minQty 0.001 BTC (10 contracts) beats 50 USDT (0.0006 BTC) -> 10 contracts ≈ 83 USDT.
 * Exact Decimal maths (money-precision rule): `coin` is contracts × multiplier exactly, `usdt` is rounded UP to 2 dp
 * (a minimum must never be shown below the real one). `price` is the reference price as a decimal string.
 */
export function minOpenOrder(filter: FuturesContractFilter | undefined, price: string): { contracts: number; coin: string; usdt: string } | null {
  if (filter === undefined) return null
  const multiplier = filterDecimal(filter.multiplier)
  if (!multiplier.greaterThan(0)) return null
  const reference = filterDecimal(price)
  const byQty = filterDecimal(filter.minQty).dividedBy(multiplier)
  const byNotional = reference.greaterThan(0) ? filterDecimal(filter.minNotional).dividedBy(reference.times(multiplier)) : new Decimal(0)
  const whole = Decimal.max(1, Decimal.max(byQty, byNotional).toDecimalPlaces(0, Decimal.ROUND_UP))
  const coin = whole.times(multiplier)
  const usdt = reference.greaterThan(0) ? coin.times(reference).toDecimalPlaces(2, Decimal.ROUND_UP) : new Decimal(0)
  // float-ok: whole-contract count (integer), not a money value
  return { contracts: whole.toNumber(), coin: coin.toFixed(), usdt: usdt.toFixed() }
}

/**
 * Smallest opening order VALUE exactly as the guard checks it: max(MIN_NOTIONAL, LOT_SIZE minQty × price), as an exact
 * decimal string — not the whole-contract rounding of `minOpenOrder` (that would refuse a valid 50 USDT order as 50.08).
 * `'0'` = unknown (no filter / no price for the minQty leg).
 */
export function minOpenValue(filter: FuturesContractFilter | undefined, price: string): string {
  if (filter === undefined) return '0'
  const reference = filterDecimal(price)
  const byQty = reference.greaterThan(0) ? filterDecimal(filter.minQty).times(reference) : new Decimal(0)
  return Decimal.max(filterDecimal(filter.minNotional), byQty).toFixed()
}

/** A minimum value for display: rounded UP to 2 dp, trailing zeros dropped (`"83.915"` -> `"83.92"`, `"50"` -> `"50"`). */
export function minValueText(value: string): string {
  return filterDecimal(value).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed()
}

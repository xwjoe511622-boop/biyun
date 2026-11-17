import { Decimal, canonicalDecimal, isDecimalString, isPositive } from '@/modules/finance/decimal'
import type { OrderSide } from '@/modules/finance/precision'
import { floorDp, floorToStep } from './spot-size-unit'

/**
 * 快捷买币 (owner 10-22: "其实就是市价单买币"): a spot MARKET order sized the simple way —
 *   BUY  : the user types the USDT to spend  → wire `volume` = that quote amount (quoteOrderQty)
 *   SELL : the user types the coin to sell   → wire `volume` = that base quantity
 * What the user receives is only an estimate: it walks the live order book (best ask upwards for a buy, best bid
 * downwards for a sell) and falls back to the last price when that side of the book is empty. Every figure is a
 * decimal string (decimal.js); nothing here uses floats. Rounding is always DOWN (never promise more than the book):
 *   buy  receive → floor to the pair's quantity step
 *   sell receive → floor to the quote precision
 */

export interface BookLevel {
  price: string
  amount: string
}

export type EstimateSource = 'book' | 'last' | 'none'

export interface QuickEstimate {
  /** Estimated coin (buy) / USDT (sell) received, rounded down; '' when nothing can be estimated. */
  receive: string
  /** Average execution price of the estimate (quote per coin), '' when unknown. */
  avgPrice: string
  /** Where the estimate came from: the order book, the last price (no book on that side) or nothing. */
  source: EstimateSource
  /** The visible book is shallower than the order: the part beyond it is priced at the worst visible level. */
  partial: boolean
}

export interface QuickMarket {
  /** Ask levels (any order). */
  asks: readonly BookLevel[]
  /** Bid levels (any order). */
  bids: readonly BookLevel[]
  /** Last traded price, '' when unknown. */
  lastPrice: string
  /** Quantity step of the pair (e.g. '0.00001'). */
  step: string
  /** Decimals of a quote (USDT) amount. */
  quotePrecision: number
}

const NONE: QuickEstimate = { receive: '', avgPrice: '', source: 'none', partial: false }

function usable(levels: readonly BookLevel[], ascending: boolean): { price: Decimal; amount: Decimal }[] {
  const rows: { price: Decimal; amount: Decimal }[] = []
  for (const level of levels) {
    const price = canonicalDecimal(level.price)
    const amount = canonicalDecimal(level.amount)
    if (!isDecimalString(price) || !isDecimalString(amount) || !isPositive(price) || !isPositive(amount)) continue
    rows.push({ price: new Decimal(price), amount: new Decimal(amount) })
  }
  rows.sort((a, b) => (ascending ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)))
  return rows
}

/** Best ask (lowest) for a buy / best bid (highest) for a sell, '' when that side is empty. */
export function bestPrice(side: OrderSide, market: Pick<QuickMarket, 'asks' | 'bids'>): string {
  const rows = side === 'BUY' ? usable(market.asks, true) : usable(market.bids, false)
  return rows.length === 0 ? '' : canonicalDecimal(rows[0].price.toFixed())
}

/** True when the side the order would take has at least one level (a buy needs asks, a sell needs bids). */
export function hasLiquidity(side: OrderSide, market: Pick<QuickMarket, 'asks' | 'bids'>): boolean {
  return bestPrice(side, market) !== ''
}

/**
 * Estimated receive for `amount` (USDT for a buy, coin for a sell). The book is swept level by level; whatever is
 * left beyond the visible book is priced at the last visible level and flagged `partial`. Without that side of the
 * book the last price is used (`source: 'last'`).
 */
export function quickEstimate(side: OrderSide, amount: string, market: QuickMarket): QuickEstimate {
  const typed = canonicalDecimal(amount)
  if (!isDecimalString(typed) || !isPositive(typed)) return { ...NONE }
  const rows = side === 'BUY' ? usable(market.asks, true) : usable(market.bids, false)
  if (rows.length === 0) {
    const last = canonicalDecimal(market.lastPrice)
    if (!isDecimalString(last) || !isPositive(last)) return { ...NONE }
    const receive = side === 'BUY'
      ? floorToStep(new Decimal(typed).dividedBy(last).toFixed(16, Decimal.ROUND_DOWN), market.step)
      : floorDp(new Decimal(typed).times(last).toFixed(), market.quotePrecision)
    return { receive, avgPrice: last, source: 'last', partial: false }
  }
  let left = new Decimal(typed)
  let base = new Decimal(0)
  let quote = new Decimal(0)
  for (const row of rows) {
    if (left.lessThanOrEqualTo(0)) break
    if (side === 'BUY') {
      const cost = row.price.times(row.amount)
      if (left.greaterThanOrEqualTo(cost)) {
        base = base.plus(row.amount)
        quote = quote.plus(cost)
        left = left.minus(cost)
      } else {
        base = base.plus(left.dividedBy(row.price).toDecimalPlaces(16, Decimal.ROUND_DOWN))
        quote = quote.plus(left)
        left = new Decimal(0)
      }
    } else {
      const take = Decimal.min(left, row.amount)
      base = base.plus(take)
      quote = quote.plus(take.times(row.price))
      left = left.minus(take)
    }
  }
  const partial = left.greaterThan(0)
  if (partial) {
    const worst = rows[rows.length - 1].price
    if (side === 'BUY') {
      base = base.plus(left.dividedBy(worst).toDecimalPlaces(16, Decimal.ROUND_DOWN))
      quote = quote.plus(left)
    } else {
      base = base.plus(left)
      quote = quote.plus(left.times(worst))
    }
  }
  if (base.lessThanOrEqualTo(0)) return { ...NONE }
  const avgPrice = canonicalDecimal(quote.dividedBy(base).toDecimalPlaces(16, Decimal.ROUND_HALF_UP).toFixed())
  const receive = side === 'BUY'
    ? floorToStep(base.toFixed(), market.step)
    : floorDp(quote.toFixed(), market.quotePrecision)
  return { receive, avgPrice, source: 'book', partial }
}

/**
 * The "max" shortcut: the whole available balance in the typed unit, rounded down — USDT to the quote precision
 * for a buy, coin to the quantity step for a sell. '' when the balance is unknown or not positive.
 */
export function maxAmount(side: OrderSide, available: string, market: Pick<QuickMarket, 'step' | 'quotePrecision'>): string {
  return ratioAmount(side, available, '1', market)
}

/** Shortcut ratios (Binance-style 25 / 50 / 75 / 100 %), decimal-string fractions. */
export const QUICK_RATIOS = ['0.25', '0.5', '0.75', '1'] as const
export type QuickRatio = (typeof QUICK_RATIOS)[number]

/**
 * `ratio` of the available balance in the typed unit, rounded down like {@link maxAmount} (建议-003). '' when the
 * balance is unknown / not positive or the share rounds to zero (QA-004: the caller explains why).
 */
export function ratioAmount(side: OrderSide, available: string, ratio: string, market: Pick<QuickMarket, 'step' | 'quotePrecision'>): string {
  const value = canonicalDecimal(available)
  const share = canonicalDecimal(ratio)
  if (!isDecimalString(value) || !isPositive(value) || !isDecimalString(share) || !isPositive(share)) return ''
  const part = new Decimal(value).times(share).toFixed()
  const out = side === 'BUY' ? floorDp(part, market.quotePrecision) : floorToStep(part, market.step)
  return isPositive(out) ? out : ''
}

/** Fee at `rate` (decimal fraction, '0.001' = 0.1 %) of `amount`, rounded UP to `dp` (never under-states a fee). */
export function feeOf(amount: string, rate: string, dp: number): string {
  const value = canonicalDecimal(amount)
  const fraction = canonicalDecimal(rate)
  if (!isDecimalString(value) || !isDecimalString(fraction) || !isPositive(value) || !isPositive(fraction)) return ''
  return canonicalDecimal(new Decimal(value).times(fraction).toDecimalPlaces(dp, Decimal.ROUND_UP).toFixed())
}

export interface FillSummary {
  /** Coin quantity filled. */
  baseQty: string
  /** USDT value filled. */
  quoteQty: string
  /** Average fill price, '' when nothing filled. */
  avgPrice: string
}

/** Sums fills (`price`, `volume` decimal strings) into quantity, value and average price. */
export function summarizeFills(fills: readonly { price: string; volume: string }[]): FillSummary {
  let base = new Decimal(0)
  let quote = new Decimal(0)
  for (const fill of fills) {
    const price = canonicalDecimal(fill.price)
    const volume = canonicalDecimal(fill.volume)
    if (!isDecimalString(price) || !isDecimalString(volume)) continue
    base = base.plus(volume)
    quote = quote.plus(new Decimal(volume).times(price))
  }
  return {
    baseQty: canonicalDecimal(base.toFixed()),
    quoteQty: canonicalDecimal(quote.toFixed()),
    avgPrice: base.greaterThan(0) ? canonicalDecimal(quote.dividedBy(base).toDecimalPlaces(16, Decimal.ROUND_HALF_UP).toFixed()) : '',
  }
}

/** Fill from an order's totals (`/api/v3` reply: `executedQty`, `cummulativeQuoteQty`). */
export function fillFromTotals(executedQty: string, quoteQty: string): FillSummary {
  const base = canonicalDecimal(executedQty)
  const quote = canonicalDecimal(quoteQty)
  if (!isDecimalString(base) || !isPositive(base)) return { baseQty: '', quoteQty: '', avgPrice: '' }
  if (!isDecimalString(quote) || !isPositive(quote)) return { baseQty: base, quoteQty: '', avgPrice: '' }
  return {
    baseQty: base,
    quoteQty: quote,
    avgPrice: canonicalDecimal(new Decimal(quote).dividedBy(base).toDecimalPlaces(16, Decimal.ROUND_HALF_UP).toFixed()),
  }
}

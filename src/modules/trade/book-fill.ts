/**
 * Order-book click-to-fill (Binance style): clicking a level fills the price and the cumulative
 * amount from the best level through the clicked level; clicking an ask (sell order) fills the BUY
 * side, clicking a bid fills the SELL side (Binance "Quick Switch Buy/Sell").
 */
import { Decimal, canonicalDecimal, cmp, div, isDecimalString, isPositive, mul } from '@/modules/finance/decimal'
import type { OrderSide } from '@/modules/finance/precision'
import { floorDp, floorToStep, type SpotUnit } from '@/modules/trade/spot-size-unit'

export type BookSide = 'ask' | 'bid'

export interface BookPick {
  book: BookSide
  index: number
}

export interface BookRows {
  asks: readonly { amount: string }[]
  bids: readonly { amount: string }[]
}

/** A price (and optionally side + cumulative amount in the book's raw unit) pushed from the order book into a ticket. */
export interface PriceSuggestion {
  price: string
  sequence: number
  side?: OrderSide
  amount?: string
}

/** 'ask' -> 'BUY' (clicking an ask fills a buy), 'bid' -> 'SELL'. */
export function takerSide(book: BookSide): OrderSide {
  return book === 'ask' ? 'BUY' : 'SELL'
}

/**
 * Canonical decimal sum of `rows[0..index]` inclusive amounts.
 * Returns `''` when the index is not an integer, out of range, or any summed amount is not a
 * non-negative decimal string.
 */
export function cumulativeThrough(rows: readonly { amount: string }[], index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return ''
  let sum = new Decimal(0)
  for (let i = 0; i <= index; i++) {
    const amount = canonicalDecimal(rows[i].amount)
    if (!isDecimalString(amount)) return ''
    sum = sum.plus(new Decimal(amount))
  }
  return canonicalDecimal(sum.toFixed())
}

/**
 * Builds the next `PriceSuggestion`. Always carries the new `price` and an incremented `sequence`;
 * when `pick`/`rows` are given and the cumulative amount through the picked level is a positive
 * decimal, it also carries the taker `side` and that cumulative `amount` (otherwise neither key).
 */
export function bookSuggestion(
  previous: PriceSuggestion | undefined,
  price: string,
  pick?: BookPick,
  rows?: BookRows,
): PriceSuggestion {
  const suggestion: PriceSuggestion = { price, sequence: (previous?.sequence ?? 0) + 1 }
  if (pick && rows) {
    const source = pick.book === 'ask' ? rows.asks : rows.bids
    const cumulative = cumulativeThrough(source, pick.index)
    if (isPositive(cumulative)) {
      suggestion.side = takerSide(pick.book)
      suggestion.amount = cumulative
    }
  }
  return suggestion
}

export interface SpotFillInput {
  side: OrderSide
  unit: SpotUnit
  baseQty: string
  price: string
  available: string
  step: string
  quotePrecision: number
}

/**
 * Amount to type into a spot ticket (in `unit`) for a cumulative base quantity `baseQty` at limit
 * `price`. Rounds down to the step, caps by the available balance when known, and converts to a
 * quote amount when `unit` is `'quote'`. All arithmetic is string decimal math (never floats).
 */
export function spotFillAmount(input: SpotFillInput): string {
  const { side, unit, baseQty, price, available, step, quotePrecision } = input

  if (!isPositive(price) || !isPositive(baseQty)) return ''

  let qty = floorToStep(baseQty, step)
  if (qty === '') return ''

  if (isDecimalString(available)) {
    const cap = side === 'BUY' ? floorToStep(div(available, price, 16), step) : floorToStep(available, step)
    if (cap !== '' && cmp(qty, cap) > 0) qty = cap
  }

  if (qty === '' || !isPositive(qty)) return ''

  if (unit === 'base') return qty

  const quote = floorDp(mul(qty, price), quotePrecision)
  return isPositive(quote) ? quote : ''
}

/**
 * Whole futures contracts: `floor(cumulative)`; when `max` is a decimal string, cap at `floor(max)`.
 * Returns a canonical integer string, or `''` when the result is not positive or `cumulative` is
 * not a decimal string.
 */
export function capContracts(cumulative: string, max: string): string {
  if (!isDecimalString(cumulative)) return ''
  let result = new Decimal(cumulative).floor()
  if (isDecimalString(max)) {
    const maxFloor = new Decimal(max).floor()
    if (result.greaterThan(maxFloor)) result = maxFloor
  }
  return result.greaterThan(0) ? result.toFixed() : ''
}

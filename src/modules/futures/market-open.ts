import { Decimal } from '@/modules/finance/decimal'

/**
 * Wire value of a market OPEN that should fill exactly `contracts` (Binance: a market order in BTC fills that quantity).
 *
 * The server sizes a market OPEN by value (margin coin): Rust rmatch sweeps the opposite book spending the budget
 * (`sweep_amount`, `price × contracts × multiplier` per fill) and cancels what is left. A value of exactly
 * `contracts × multiplier × reference` therefore fills one contract short whenever the book is worse than the
 * reference (09-30: 0.002 BTC = 20 contracts filled 19). So:
 *
 *   value = Σ (walk the opposite book for `contracts`) + ½ contract at the last price reached
 *
 * The walk prices the fills; the ½-contract pad absorbs a small move before the order arrives without buying an extra
 * contract (that needs another full contract of budget). Book shortfall is priced at the fallback (last / mark), the
 * worse of the two for the taker. `cap` (the largest affordable value) wins over the pad: then the fill may still be
 * short, which is reported as `capped`. Rounded down to `dp` (the pad is far larger than one unit of `dp`).
 */
export interface MarketOpenInput {
  side: 'BUY' | 'SELL'
  contracts: string
  multiplier: string
  /** Opposite side of the book in contracts (asks for a buy, bids for a sell), any order. */
  levels: ReadonlyArray<{ price: string; amount: string }>
  fallbackPrice: string
  dp: number
  cap?: string
}

const DEC = /^\d+(\.\d+)?$/

function dec(value: string | undefined): Decimal | null {
  const text = (value ?? '').trim()
  return DEC.test(text) ? new Decimal(text) : null
}

export function marketOpenValue(input: MarketOpenInput): { value: string; capped: boolean } {
  const contracts = dec(input.contracts)
  const multiplier = dec(input.multiplier)
  const fallback = dec(input.fallbackPrice)
  if (contracts === null || multiplier === null || contracts.lte(0) || multiplier.lte(0) || !contracts.isInteger()) return { value: '', capped: false }
  const buy = input.side === 'BUY'
  const levels = input.levels
    .map((level) => ({ price: dec(level.price), amount: dec(level.amount) }))
    .filter((level): level is { price: Decimal; amount: Decimal } => level.price !== null && level.amount !== null && level.price.gt(0) && level.amount.gt(0))
    .sort((a, b) => (buy ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)))
  let remaining = contracts
  let cost = new Decimal(0)
  let edge: Decimal | null = null
  for (const level of levels) {
    if (remaining.lte(0)) break
    const take = Decimal.min(remaining, level.amount)
    cost = cost.plus(take.times(level.price))
    remaining = remaining.minus(take)
    edge = level.price
  }
  if (remaining.gt(0)) {
    const worse = edge === null ? fallback : fallback === null ? edge : buy ? Decimal.max(edge, fallback) : Decimal.min(edge, fallback)
    if (worse === null) return { value: '', capped: false }
    cost = cost.plus(remaining.times(worse))
    edge = worse
  }
  if (edge === null) return { value: '', capped: false }
  const padded = cost.plus(edge.dividedBy(2)).times(multiplier)
  let value = padded.toFixed(Math.max(0, input.dp), Decimal.ROUND_DOWN)
  const cap = dec(input.cap)
  if (cap !== null && new Decimal(value).gt(cap)) return { value: cap.toFixed(Math.max(0, input.dp), Decimal.ROUND_DOWN), capped: true }
  return { value, capped: false }
}

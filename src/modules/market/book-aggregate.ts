import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'
import type { DepthLevel } from '@/stores/market'

/**
 * Client-side order-book price grouping (Binance "0.01 / 0.1 / 1 / 10" selector).
 *
 * The exchange pushes one depth channel per configured step, each capped at a fixed number of
 * levels (futures 30, spot 80). A coarse channel is aggregated by the server from its own capped
 * snapshot, so it is often no wider than the finest one, and steps coarser than the configured
 * ones have no channel at all. The stores therefore always keep the finest channel and group it
 * here; the selected (or coarsest) server channel only extends the book beyond the fine range.
 *
 * Asks round UP to the step and bids round DOWN (a grouped level never shows a better price than
 * any order inside it), amounts are summed and running totals recomputed.
 */
export interface RawLevel {
  price: string
  amount: string
  /** Flash marker from the last publish: 1 grew, 2 shrank, 0 unchanged. */
  diff?: 0 | 1 | 2
}

export type BookSide = 'ask' | 'bid'

/** Server steps plus `extra` coarser decades (`['0.01','0.1','1']` -> `[... ,'10']`). */
export function extendDepthSteps(steps: readonly string[], extra = 1): string[] {
  const valid = steps.filter((step) => isDecimalString(step) && new Decimal(step).greaterThan(0))
  if (valid.length === 0) return []
  const result = [...valid]
  let coarsest = valid.reduce((acc, step) => (new Decimal(step).greaterThan(acc) ? step : acc), valid[0])
  for (let index = 0; index < extra; index += 1) {
    coarsest = canonicalDecimal(new Decimal(coarsest).times(10).toFixed())
    if (!result.includes(coarsest)) result.push(coarsest)
  }
  return result
}

/** Price tick from a price precision: `2` -> `0.01`, `1` -> `0.1`, `0` -> `1`; `''` when unusable. */
export function tickFromPrecision(precision: number | null | undefined): string {
  if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > 18) return ''
  return precision === 0 ? '1' : `0.${'0'.repeat(precision - 1)}1`
}

/**
 * Book grouping options from the market's real price tick, Binance style: `[tick, tick×10, tick×100, tick×1000]`
 * (BTC perp tick 0.1 -> 0.1 / 1 / 10 / 100). Never finer than the finest server depth channel (a step below the
 * data's own granularity would look identical to the next one). Without a usable tick the server steps plus one
 * coarser decade are used as before.
 */
export function tickDepthSteps(tick: string, serverSteps: readonly string[], count = 4): string[] {
  const valid = serverSteps.filter((step) => isDecimalString(step) && new Decimal(step).greaterThan(0))
  if (!isDecimalString(tick) || !new Decimal(tick).greaterThan(0)) return extendDepthSteps(valid)
  const finest = valid.reduce<Decimal | null>((acc, step) => (acc === null || new Decimal(step).lessThan(acc) ? new Decimal(step) : acc), null)
  let step = finest !== null && finest.greaterThan(tick) ? finest : new Decimal(tick)
  const result: string[] = []
  for (let index = 0; index < count; index += 1) {
    result.push(canonicalDecimal(step.toFixed()))
    step = step.times(10)
  }
  return result
}

/**
 * Server depth channel (index into `serverSteps`) that extends the book at display step `step`: the coarsest
 * channel whose step is not coarser than the display step; `null` when that is the finest channel (always
 * subscribed) or no channel qualifies.
 */
export function coarseChannelForStep(step: string, serverSteps: readonly string[]): number | null {
  if (!isDecimalString(step)) return null
  let best: number | null = null
  let bestStep: Decimal | null = null
  serverSteps.forEach((entry, index) => {
    if (!isDecimalString(entry)) return
    const value = new Decimal(entry)
    if (value.greaterThan(step)) return
    if (bestStep === null || value.greaterThan(bestStep)) {
      best = index
      bestStep = value
    }
  })
  return best === null || best === 0 ? null : best
}

/** Bucket price of `price` at `step`: asks ceil, bids floor. */
export function bucketPrice(price: string, step: string, side: BookSide): string {
  const value = new Decimal(price)
  const size = new Decimal(step)
  if (size.lessThanOrEqualTo(0)) return canonicalDecimal(price)
  const units = value.dividedBy(size)
  const whole = side === 'ask' ? units.ceil() : units.floor()
  return canonicalDecimal(whole.times(size).toFixed())
}

function better(side: BookSide, left: Decimal, right: Decimal): boolean {
  return side === 'ask' ? left.lessThan(right) : left.greaterThan(right)
}

/** Groups levels into `step` buckets (nearest the spread first). `step` '' keeps prices as they are. */
export function groupLevels(levels: readonly RawLevel[], step: string, side: BookSide): RawLevel[] {
  const buckets = new Map<string, { amount: Decimal; diff: 0 | 1 | 2 }>()
  for (const level of levels) {
    if (!isDecimalString(level.price) || !isDecimalString(level.amount)) continue
    const amount = new Decimal(level.amount)
    if (amount.lessThanOrEqualTo(0)) continue
    const key = step === '' ? canonicalDecimal(level.price) : bucketPrice(level.price, step, side)
    const current = buckets.get(key)
    const diff = level.diff ?? 0
    if (current === undefined) buckets.set(key, { amount, diff })
    else buckets.set(key, { amount: current.amount.plus(amount), diff: current.diff !== 0 ? current.diff : diff })
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => (better(side, new Decimal(left), new Decimal(right)) ? -1 : left === right ? 0 : 1))
    .map(([price, entry]) => ({ price, amount: canonicalDecimal(entry.amount.toFixed()), diff: entry.diff }))
}

/**
 * One side of the displayed book: the fine levels grouped at `step`, extended with coarse levels
 * that lie strictly beyond the fine range, capped at `maxRows`, with running totals.
 */
export function composeSide(
  fine: readonly RawLevel[],
  coarse: readonly RawLevel[] | null,
  step: string,
  side: BookSide,
  maxRows: number,
): DepthLevel[] {
  const grouped = groupLevels(fine, step, side)
  if (coarse !== null && coarse.length > 0 && grouped.length < maxRows) {
    const edge = grouped.length > 0 ? new Decimal(grouped[grouped.length - 1].price) : null
    for (const level of groupLevels(coarse, step, side)) {
      if (grouped.length >= maxRows) break
      if (edge === null || better(side, edge, new Decimal(level.price))) grouped.push(level)
    }
  }
  let running = new Decimal(0)
  return grouped.slice(0, maxRows).map((level) => {
    running = running.plus(level.amount)
    return { price: level.price, amount: level.amount, total: canonicalDecimal(running.toFixed()), diff: level.diff ?? 0 }
  })
}

/**
 * Index of the server depth channel to use as the coarse source for display step `index`:
 * the matching channel when it exists, otherwise the coarsest one; `null` for the finest step.
 */
export function coarseChannelIndex(index: number, serverSteps: number): number | null {
  if (index <= 0 || serverSteps <= 1) return null
  return Math.min(index, serverSteps - 1)
}

export interface SweepStats {
  /** Volume-weighted average price of the swept levels (quote per base unit). */
  avgPrice: string
  /** Sum of the level amounts, in the book's display unit. */
  sumAmount: string
  /** Quote value of the swept levels. */
  sumValue: string
}

/**
 * What a taker sweeping `rows` (nearest the spread first) would trade: average price, amount and
 * quote value. `multiplier` = quote value of one amount unit per unit of price (1 for spot, the
 * contract face value for futures in contracts); `amountIsValue` = the amounts already are quote
 * values (futures shown in USDT).
 */
export function sweepStats(rows: readonly DepthLevel[], multiplier = '1', amountIsValue = false): SweepStats | null {
  let amount = new Decimal(0)
  let value = new Decimal(0)
  let base = new Decimal(0)
  const factor = isDecimalString(multiplier) && new Decimal(multiplier).greaterThan(0) ? new Decimal(multiplier) : new Decimal(1)
  for (const row of rows) {
    if (!isDecimalString(row.price) || !isDecimalString(row.amount)) continue
    const price = new Decimal(row.price)
    if (price.lessThanOrEqualTo(0)) continue
    const rowAmount = new Decimal(row.amount)
    const rowValue = amountIsValue ? rowAmount : rowAmount.times(factor).times(price)
    amount = amount.plus(rowAmount)
    value = value.plus(rowValue)
    base = base.plus(rowValue.dividedBy(price))
  }
  if (base.lessThanOrEqualTo(0)) return null
  return {
    avgPrice: value.dividedBy(base).toFixed(),
    sumAmount: canonicalDecimal(amount.toFixed()),
    sumValue: value.toFixed(),
  }
}

/**
 * Best ask minus best bid and its share of the ask in percent; `null` when either side is empty or
 * the book is locked/crossed (a transient delta ordering, never rendered as a negative spread).
 */
export function bookSpread(bestAsk: string | undefined, bestBid: string | undefined): { value: string; pct: string } | null {
  if (bestAsk === undefined || bestBid === undefined || !isDecimalString(bestAsk) || !isDecimalString(bestBid)) return null
  const ask = new Decimal(bestAsk)
  const bid = new Decimal(bestBid)
  if (ask.lessThanOrEqualTo(bid) || ask.lessThanOrEqualTo(0)) return null
  const value = ask.minus(bid)
  return { value: canonicalDecimal(value.toFixed()), pct: canonicalDecimal(value.times(100).dividedBy(ask).toFixed(4)) }
}

/** Bid share of the listed book amounts in percent (2 dp), `null` for an empty book. */
export function bidShare(asks: readonly DepthLevel[], bids: readonly DepthLevel[]): { bidPct: string; askPct: string } | null {
  const total = (rows: readonly DepthLevel[]): Decimal =>
    rows.reduce((acc, row) => (isDecimalString(row.amount) ? acc.plus(row.amount) : acc), new Decimal(0))
  const bidTotal = total(bids)
  const all = bidTotal.plus(total(asks))
  if (all.lessThanOrEqualTo(0)) return null
  const bidPct = bidTotal.times(100).dividedBy(all).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  return { bidPct: canonicalDecimal(bidPct.toFixed(2)), askPct: canonicalDecimal(new Decimal(100).minus(bidPct).toFixed(2)) }
}

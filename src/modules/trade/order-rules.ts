import { Decimal, canonicalDecimal, isDecimalString, isPositive, toDecString } from '@/modules/finance/decimal'
import type { OrderSide } from '@/modules/finance/precision'

/**
 * Pre-submit order rules (QA 10-26 建议-020 / 建议-028): the same checks the servers run, so the ticket names the rule,
 * the allowed range and its unit before sending instead of a refusal code afterwards.
 *
 *   spot     user-api guard / futures-gw `/api/v3` `check_spot` (filters.rs): PRICE_FILTER (tick, min, max), then
 *            PERCENT_PRICE_BY_SIDE against the LAST TRADE price (BUY: bidMultiplierDown/Up, SELL: askMultiplierDown/Up;
 *            low bound rounded UP to the tick, high bound DOWN), then LOT_SIZE, then NOTIONAL (price × qty).
 *   futures  futures-gw `lbguard.rs` `check_futures`: PRICE_FILTER, then PERCENT_PRICE against the MARK price (rounded to
 *            the tick's scale, half away from zero): BUY ≤ round_down(mark × multiplierUp), SELL ≥ round_up(mark ×
 *            multiplierDown); closes skip the size / value rules.
 *
 * Exact decimal maths only (money-precision rule); every bound is a decimal string. The servers stay authoritative.
 */

/** Positive decimal from a filter / price field, else null. */
function pos(value: unknown): Decimal | null {
  // Filter fields may arrive as JSON numbers (exponent form included): `toDecString` keeps them exact.
  const text = canonicalDecimal(toDecString(value))
  return isDecimalString(text) && isPositive(text) ? new Decimal(text) : null
}

function plain(value: Decimal): string {
  return canonicalDecimal(value.toFixed())
}

/** `OrderFilters.roundUp` / `roundDown`: to a multiple of `tick` (no tick = unchanged). */
export function roundToTick(value: Decimal, tick: Decimal | null, direction: 'up' | 'down'): Decimal {
  if (tick === null) return value
  const steps = value.dividedBy(tick)
  return (direction === 'up' ? steps.ceil() : steps.floor()).times(tick)
}

/** A refusal the ticket can explain: i18n key under `trade.rule.*` / `fut.err.*` plus its parameters. */
export interface RuleError {
  key: 'priceTick' | 'priceRange' | 'priceMin' | 'priceMax' | 'priceBand' | 'priceBandMax' | 'priceBandMin' | 'qtyMax'
  params: Record<string, string>
}

/* ------------------------------------------------------------------ spot */

export interface SpotPriceRules {
  tickSize?: string
  minPrice?: string
  maxPrice?: string
  bidMultiplierUp?: string
  bidMultiplierDown?: string
  askMultiplierUp?: string
  askMultiplierDown?: string
}

export interface PriceRange {
  /** Lowest allowed price (`''` = no lower bound). */
  min: string
  /** Highest allowed price (`''` = no upper bound). */
  max: string
}

/** PERCENT_PRICE_BY_SIDE band for `side` around the last trade price, exactly as the guard rounds it; null = no band. */
export function spotPriceBand(side: OrderSide, reference: string, rules: SpotPriceRules | undefined): (PriceRange & { up: string; down: string }) | null {
  if (rules === undefined) return null
  const ref = pos(reference)
  if (ref === null) return null
  const up = pos(side === 'BUY' ? rules.bidMultiplierUp : rules.askMultiplierUp)
  const down = pos(side === 'BUY' ? rules.bidMultiplierDown : rules.askMultiplierDown)
  if (up === null && down === null) return null
  const tick = pos(rules.tickSize)
  return {
    min: down === null ? '' : plain(roundToTick(ref.times(down), tick, 'up')),
    max: up === null ? '' : plain(roundToTick(ref.times(up), tick, 'down')),
    up: up === null ? '' : plain(up.times(100)),
    down: down === null ? '' : plain(down.times(100)),
  }
}

/** The allowed limit-price range for `side`: PRICE_FILTER min/max intersected with the band. */
export function spotPriceRange(side: OrderSide, reference: string, rules: SpotPriceRules | undefined): PriceRange {
  const min = pos(rules?.minPrice)
  const max = pos(rules?.maxPrice)
  const band = spotPriceBand(side, reference, rules)
  const lo = [min, band !== null && band.min !== '' ? new Decimal(band.min) : null].filter((x): x is Decimal => x !== null)
  const hi = [max, band !== null && band.max !== '' ? new Decimal(band.max) : null].filter((x): x is Decimal => x !== null)
  return {
    min: lo.length === 0 ? '' : plain(Decimal.max(...lo)),
    max: hi.length === 0 ? '' : plain(Decimal.min(...hi)),
  }
}

/** First spot price rule the limit `price` breaks, in the guard's order (PRICE_FILTER, then PERCENT_PRICE_BY_SIDE). */
export function checkSpotPrice(side: OrderSide, price: string, reference: string, rules: SpotPriceRules | undefined): RuleError | null {
  if (rules === undefined) return null
  const p = pos(price)
  if (p === null) return null
  const tick = pos(rules.tickSize)
  if (tick !== null && !p.mod(tick).isZero()) return { key: 'priceTick', params: { tick: plain(tick) } }
  const min = pos(rules.minPrice)
  const max = pos(rules.maxPrice)
  if ((min !== null && p.lessThan(min)) || (max !== null && p.greaterThan(max))) {
    if (min !== null && max !== null) return { key: 'priceRange', params: { min: plain(min), max: plain(max) } }
    return min !== null && p.lessThan(min) ? { key: 'priceMin', params: { min: plain(min) } } : { key: 'priceMax', params: { max: plain(max as Decimal) } }
  }
  const band = spotPriceBand(side, reference, rules)
  if (band !== null) {
    const ref0 = pos(reference)
    if (ref0 !== null) {
      const up = pos(side === 'BUY' ? rules.bidMultiplierUp : rules.askMultiplierUp)
      const down = pos(side === 'BUY' ? rules.bidMultiplierDown : rules.askMultiplierDown)
      // The guard compares with the UNROUNDED band (price > ref × up), and reports the tick-rounded bounds.
      const high = up !== null && p.greaterThan(ref0.times(up))
      const low = down !== null && p.lessThan(ref0.times(down))
      if (high || low) {
        return {
          key: 'priceBand',
          params: { min: band.min || '-', max: band.max || '-', ref: plain(ref0), down: band.down === '' ? '-' : `${band.down}%`, up: band.up === '' ? '-' : `${band.up}%` },
        }
      }
    }
  }
  return null
}

/**
 * Smallest limit order that passes LOT_SIZE (minQty, step) and NOTIONAL (minNotional) at `price`: the quantity is the
 * smallest multiple of `step` with qty ≥ minQty and qty × price ≥ minNotional; the total is exactly qty × price.
 * XAUT at 4000, step 0.0001, minNotional 5 → 0.0013 XAUT = 5.2 USDT (0.0012 = 4.8 is too little). Null = unknown.
 */
export function spotMinOrder(price: string, step: string, minQty: string | undefined, minNotional: string | undefined): { qty: string; total: string } | null {
  const p = pos(price)
  const s = pos(step)
  if (p === null || s === null) return null
  const byQty = pos(minQty) ?? new Decimal(0)
  const byNotional = pos(minNotional)?.dividedBy(p) ?? new Decimal(0)
  const need = Decimal.max(byQty, byNotional)
  if (need.isZero()) return null
  const qty = Decimal.max(s, need.dividedBy(s).ceil().times(s))
  return { qty: plain(qty), total: plain(qty.times(p)) }
}

/* ------------------------------------------------------------------ futures */

export interface FuturesPriceRules {
  tickSize?: string
  minPrice?: string
  maxPrice?: string
  multiplierUp?: string
  multiplierDown?: string
}

/** The mark price as the guard uses it: rounded to the tick's scale, half away from zero. */
function guardMark(mark: string, tick: Decimal | null): Decimal | null {
  const m = pos(mark)
  if (m === null || tick === null) return m
  return m.toDecimalPlaces(tick.decimalPlaces(), Decimal.ROUND_HALF_UP)
}

/** First futures price rule the limit `price` breaks (PRICE_FILTER, then PERCENT_PRICE vs the mark price). */
export function checkFuturesPrice(side: OrderSide, price: string, mark: string, rules: FuturesPriceRules | undefined): RuleError | null {
  if (rules === undefined) return null
  const p = pos(price)
  if (p === null) return null
  const tick = pos(rules.tickSize)
  if (tick !== null && !p.mod(tick).isZero()) return { key: 'priceTick', params: { tick: plain(tick) } }
  const min = pos(rules.minPrice)
  const max = pos(rules.maxPrice)
  if ((min !== null && p.lessThan(min)) || (max !== null && p.greaterThan(max))) {
    if (min !== null && max !== null) return { key: 'priceRange', params: { min: plain(min), max: plain(max) } }
    return min !== null && p.lessThan(min) ? { key: 'priceMin', params: { min: plain(min) } } : { key: 'priceMax', params: { max: plain(max as Decimal) } }
  }
  const m = guardMark(mark, tick)
  if (m === null) return null
  if (side === 'BUY') {
    const up = pos(rules.multiplierUp)
    if (up !== null && p.greaterThan(m.times(up))) {
      return { key: 'priceBandMax', params: { max: plain(roundToTick(m.times(up), tick, 'down')), mark: plain(m), pct: `${plain(up.times(100))}%` } }
    }
  } else {
    const down = pos(rules.multiplierDown)
    if (down !== null && p.lessThan(m.times(down))) {
      return { key: 'priceBandMin', params: { min: plain(roundToTick(m.times(down), tick, 'up')), mark: plain(m), pct: `${plain(down.times(100))}%` } }
    }
  }
  return null
}

/** LOT_SIZE maxQty for an opening order of `contracts` × `multiplier` coin; the largest whole-contract count is named. */
export function checkFuturesMaxQty(contracts: string, multiplier: string, maxQty: string | undefined): RuleError | null {
  const c = pos(contracts)
  const mult = pos(multiplier)
  const max = pos(maxQty)
  if (c === null || mult === null || max === null) return null
  if (!c.times(mult).greaterThan(max)) return null
  return { key: 'qtyMax', params: { max: plain(max), contracts: plain(max.dividedBy(mult).floor()) } }
}

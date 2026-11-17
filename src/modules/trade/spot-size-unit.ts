import { Decimal, canonicalDecimal, cmp, decimalPlaces, div, isDecimalString, isPositive, mul } from '@/modules/finance/decimal'
import type { OrderSide, OrderType } from '@/modules/finance/precision'

/**
 * Spot 「货币单位」 (Binance style): the order size is typed either in the base coin (数量, BTC) or in the quote
 * coin (成交额, USDT). The wire format of `POST /order/create` never changes (docs/03-reference/spot-matching-contract.md):
 *   limit (buy/sell)  volume = base quantity, price = limit price
 *   market SELL       volume = base quantity
 *   market BUY        volume = QUOTE amount (quoteOrderQty semantics: the engine spends up to that amount maker by maker)
 * so the typed amount is converted here, always rounding DOWN (never above what the user typed):
 *   limit, USDT        qty = floor(total / price, stepSize)          exact total = qty × price
 *   market BUY, USDT   volume = total                                (native, nothing estimated)
 *   market BUY, coin   volume = floor(qty × best ask, quote dp)      estimated fill ≈ qty
 *   market SELL, USDT  qty = floor(total / best bid, stepSize)       estimated proceeds ≈ total
 * All arithmetic uses the decimal helpers (decimal.js), never floats.
 */
export type SpotUnit = 'base' | 'quote'

export const SPOT_UNIT_KEY = 'picat.spot.sizeUnit'

type UnitSlot = `${'limit' | 'market'}:${OrderSide}`

function slot(type: OrderType, side: OrderSide): UnitSlot {
  return `${type === '2' ? 'market' : 'limit'}:${side}`
}

/** Defaults keep the pre-selector behaviour: coin quantity everywhere, USDT amount for a market buy. */
export function defaultSpotUnit(type: OrderType, side: OrderSide): SpotUnit {
  return type === '2' && side === 'BUY' ? 'quote' : 'base'
}

function readAll(): Partial<Record<UnitSlot, SpotUnit>> {
  try {
    const raw = localStorage.getItem(SPOT_UNIT_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Partial<Record<UnitSlot, SpotUnit>> : {}
  } catch {
    return {}
  }
}

/** Remembered per order type and side (limit buy, market buy, …), per browser. */
export function readSpotUnit(type: OrderType, side: OrderSide): SpotUnit {
  const saved = readAll()[slot(type, side)]
  return saved === 'base' || saved === 'quote' ? saved : defaultSpotUnit(type, side)
}

export function saveSpotUnit(type: OrderType, side: OrderSide, unit: SpotUnit): void {
  try {
    localStorage.setItem(SPOT_UNIT_KEY, JSON.stringify({ ...readAll(), [slot(type, side)]: unit }))
  } catch {
    // Private mode: the choice simply is not remembered.
  }
}

/* ------------------------------------------------------------------ rounding */

/** Quantity step: the filter `stepSize` when known, else 10^-volumePrecision. */
export function effectiveStep(stepSize: string | undefined, volumePrecision: number): string {
  if (stepSize !== undefined && isPositive(canonicalDecimal(stepSize))) return canonicalDecimal(stepSize)
  return new Decimal(1).dividedBy(new Decimal(10).pow(volumePrecision)).toFixed()
}

/** Largest multiple of `step` that is ≤ `value` (non-negative inputs). */
export function floorToStep(value: string, step: string): string {
  if (!isDecimalString(value) || !isPositive(step)) return ''
  const steps = new Decimal(value).dividedBy(step).floor()
  return canonicalDecimal(steps.times(step).toFixed())
}

export function isMultipleOf(value: string, step: string): boolean {
  if (!isDecimalString(value) || !isPositive(step)) return true
  return new Decimal(value).mod(step).isZero()
}

/** Rounds down to `dp` decimals. */
export function floorDp(value: string, dp: number): string {
  if (!isDecimalString(value)) return ''
  return canonicalDecimal(new Decimal(value).toFixed(dp, Decimal.ROUND_DOWN))
}

/* ------------------------------------------------------------------ conversion */

export interface SpotEntryMarket {
  /** Quantity step (see `effectiveStep`). */
  step: string
  /** Decimals of a quote amount (market buy volume / totals). */
  quotePrecision: number
  /**
   * Reference price for a conversion: the limit price for limit orders; for market orders the best ask (buy) /
   * best bid (sell), falling back to the last price. `''` when unknown.
   */
  refPrice: string
}

export interface SpotWire {
  /** `volume` sent to `order/create` (`''` when it cannot be computed yet). */
  volume: string
  /** Base quantity the order is for (exact, or estimated for a market order sized in the other unit). */
  baseQty: string
  /** Quote amount (exact for limit / market buy by USDT, estimated otherwise). */
  quoteTotal: string
  /** True when `baseQty` / `quoteTotal` are estimates from the order book (market orders). */
  estimated: boolean
  /** A conversion needed a reference price that is not available yet. */
  needsPrice: boolean
}

const EMPTY: SpotWire = { volume: '', baseQty: '', quoteTotal: '', estimated: false, needsPrice: false }

/** Typed amount (in `unit`) → wire volume + the implied quantity / total. */
export function toSpotWire(type: OrderType, side: OrderSide, unit: SpotUnit, amount: string, market: SpotEntryMarket): SpotWire {
  const value = canonicalDecimal(amount)
  if (!isDecimalString(value) || !isPositive(value)) return { ...EMPTY }
  const ref = canonicalDecimal(market.refPrice)
  const hasRef = isDecimalString(ref) && isPositive(ref)
  const isMarket = type === '2'

  if (!isMarket) {
    if (unit === 'base') return { volume: value, baseQty: value, quoteTotal: hasRef ? mul(value, ref) : '', estimated: false, needsPrice: false }
    if (!hasRef) return { ...EMPTY, needsPrice: true }
    const qty = floorToStep(div(value, ref, 16), market.step)
    return { volume: qty, baseQty: qty, quoteTotal: mul(qty, ref), estimated: false, needsPrice: false }
  }
  if (side === 'BUY') {
    if (unit === 'quote') {
      return { volume: value, baseQty: hasRef ? floorToStep(div(value, ref, 16), market.step) : '', quoteTotal: value, estimated: hasRef, needsPrice: false }
    }
    if (!hasRef) return { ...EMPTY, needsPrice: true }
    const quote = floorDp(mul(value, ref), market.quotePrecision)
    return { volume: quote, baseQty: value, quoteTotal: quote, estimated: true, needsPrice: false }
  }
  if (unit === 'base') {
    return { volume: value, baseQty: value, quoteTotal: hasRef ? mul(value, ref) : '', estimated: hasRef, needsPrice: false }
  }
  if (!hasRef) return { ...EMPTY, needsPrice: true }
  const qty = floorToStep(div(value, ref, 16), market.step)
  return { volume: qty, baseQty: qty, quoteTotal: mul(qty, ref), estimated: true, needsPrice: false }
}

/** Decimals the typed amount may have in `unit`. */
export function unitInputDp(unit: SpotUnit, market: Pick<SpotEntryMarket, 'step' | 'quotePrecision'>): number {
  return unit === 'quote' ? market.quotePrecision : decimalPlaces(market.step) ?? 8
}

/** Percent of the available balance → typed amount in `unit` (buy: quote balance, sell: base balance). */
export function percentToAmount(
  percent: number, side: OrderSide, unit: SpotUnit, available: string, market: SpotEntryMarket,
): string {
  if (percent <= 0 || !isDecimalString(available) || !isPositive(available)) return ''
  const share = div(mul(available, String(Math.min(100, percent))), '100', 16)
  const ref = canonicalDecimal(market.refPrice)
  const hasRef = isDecimalString(ref) && isPositive(ref)
  if (side === 'BUY') {
    if (unit === 'quote') return floorDp(share, market.quotePrecision)
    return hasRef ? floorToStep(div(share, ref, 16), market.step) : ''
  }
  const qty = floorToStep(share, market.step)
  if (unit === 'base') return qty
  return hasRef ? floorDp(mul(qty, ref), market.quotePrecision) : ''
}

/** Share (0–100, whole number) of the available balance used by a wire order. Display only. */
export function wireToPercent(side: OrderSide, wire: SpotWire, available: string): number {
  const spend = side === 'BUY' ? wire.quoteTotal : wire.baseQty
  if (!isDecimalString(spend) || !isPositive(spend) || !isDecimalString(available) || !isPositive(available)) return 0
  const ratio = new Decimal(spend).times(100).dividedBy(available).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
  return ratio.greaterThan(100) ? 100 : ratio.toNumber()
}

/** 可买 / 可卖 in the selected unit (`''` when a needed price is missing). */
export function maxInUnit(side: OrderSide, unit: SpotUnit, available: string, market: SpotEntryMarket): string {
  if (!isDecimalString(available)) return ''
  return percentToAmount(100, side, unit, available, market) || (isPositive(available) ? '' : '0')
}

/* ------------------------------------------------------------------ filters */

export interface SpotFilterRules {
  tickSize?: string
  minQty?: string
  maxQty?: string
  stepSize?: string
  minNotional?: string
  marketMaxQty?: string
}

export interface SpotFilterError {
  /** i18n key under `trade.unit.error.*`. */
  key: 'step' | 'minQty' | 'maxQty' | 'marketMaxQty' | 'minNotional' | 'tick' | 'roundsToZero' | 'needsPrice'
  params?: Record<string, string>
}

/**
 * Binance-style spot filters on the converted order (web-api guard, -1013): LOT_SIZE / MARKET_LOT_SIZE step and bounds,
 * NOTIONAL minimum (a market buy's USDT amount, a market sell's quantity × reference price), PRICE_FILTER tick.
 * The server stays authoritative; this only explains refusals before sending.
 */
export function checkSpotFilters(
  type: OrderType, side: OrderSide, unit: SpotUnit, amount: string, price: string, wire: SpotWire, filter: SpotFilterRules | undefined,
): SpotFilterError[] {
  const errors: SpotFilterError[] = []
  const typed = canonicalDecimal(amount)
  if (wire.needsPrice) return [{ key: 'needsPrice' }]
  if (!isDecimalString(typed) || !isPositive(typed)) return errors
  const qty = wire.baseQty
  if (wire.volume === '' || (isDecimalString(wire.volume) && !isPositive(wire.volume))) {
    return [{ key: 'roundsToZero' }]
  }
  if (filter === undefined) return errors
  const isMarket = type === '2'
  const limitPrice = canonicalDecimal(price)
  if (!isMarket && filter.tickSize && isDecimalString(limitPrice) && isPositive(limitPrice) && !isMultipleOf(limitPrice, filter.tickSize)) {
    errors.push({ key: 'tick', params: { tick: canonicalDecimal(filter.tickSize) } })
  }
  const baseTyped = unit === 'base' && !(isMarket && side === 'BUY')
  if (baseTyped && filter.stepSize && !isMultipleOf(typed, filter.stepSize)) {
    errors.push({ key: 'step', params: { step: canonicalDecimal(filter.stepSize) } })
  }
  // A market buy by USDT has no quantity on the wire: LOT_SIZE does not apply (Binance quoteOrderQty).
  const qtyKnown = isDecimalString(qty) && isPositive(qty) && !(isMarket && side === 'BUY')
  if (qtyKnown && filter.minQty && cmp(qty, filter.minQty) < 0) errors.push({ key: 'minQty', params: { min: canonicalDecimal(filter.minQty) } })
  if (qtyKnown && !isMarket && filter.maxQty && cmp(qty, filter.maxQty) > 0) errors.push({ key: 'maxQty', params: { max: canonicalDecimal(filter.maxQty) } })
  if (qtyKnown && isMarket && filter.marketMaxQty && cmp(qty, filter.marketMaxQty) > 0) errors.push({ key: 'marketMaxQty', params: { max: canonicalDecimal(filter.marketMaxQty) } })
  const notional = isMarket && side === 'BUY' ? wire.volume : wire.quoteTotal
  if (filter.minNotional && isDecimalString(notional) && isPositive(notional) && cmp(notional, filter.minNotional) < 0) {
    errors.push({ key: 'minNotional', params: { min: canonicalDecimal(filter.minNotional) } })
  }
  return errors
}

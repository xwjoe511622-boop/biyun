import { Decimal, canonicalDecimal, decimalPlaces, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { normalizeInput } from './math'
import { contractsToUnit, unitDp, unitToContracts, type SizeMarket, type SizeUnit } from './size-unit'
import type { CreateOrderPayload } from './api'
import type { FuturesPosition } from './types'
import type { BookTop } from './order-entry'

/**
 * Binance-style per-position close (限价平仓 / 市价平仓) for the futures positions table.
 * Position volumes are whole contracts (张); the close side is the opposite of the position side.
 * Every amount is a decimal string; no floating point is used for money.
 */

export type CloseKind = 'limit' | 'market'

export type CloseSide = 'BUY' | 'SELL'

/** The side of a close order: a BUY position closes with a SELL, a SELL closes with a BUY. */
export function closeSideFor(orderSide: 'BUY' | 'SELL'): CloseSide {
  return orderSide === 'BUY' ? 'SELL' : 'BUY'
}

/** Rounds `price` to `dp` decimals (HALF_UP / DOWN / UP), canonical; `''` for invalid or ≤ 0. */
export function roundToTick(price: string, dp: number, mode: 'half' | 'down' | 'up'): string {
  const text = canonicalDecimal(price)
  if (!isDecimalString(text) || !isPositive(text)) return ''
  const rounding = mode === 'half' ? Decimal.ROUND_HALF_UP : mode === 'down' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP
  return canonicalDecimal(new Decimal(text).toFixed(Math.max(0, dp), rounding))
}

export interface PriceBand {
  /** `''` = no lower bound. */
  min: string
  /** `''` = no upper bound. */
  max: string
  /** Mark price rounded HALF_UP to `dp`. */
  mark: string
}

/** The server PERCENT_PRICE band for a close: only the bound for `side` is set, the other stays `''`. */
export function closePriceBand(input: {
  mark: string
  dp: number
  side: CloseSide
  filter?: { multiplierUp?: string; multiplierDown?: string }
}): PriceBand {
  const mark = roundToTick(input.mark, input.dp, 'half')
  const band: PriceBand = { min: '', max: '', mark }
  if (mark === '' || input.filter === undefined) return band
  if (input.side === 'BUY') {
    const up = positiveDecimal(input.filter.multiplierUp ?? '')
    if (up !== '') band.max = roundToTick(new Decimal(mark).times(up).toFixed(), input.dp, 'down')
  } else {
    const down = positiveDecimal(input.filter.multiplierDown ?? '')
    if (down !== '') band.min = roundToTick(new Decimal(mark).times(down).toFixed(), input.dp, 'up')
  }
  return band
}

/** Best opposite price: a BUY close takes asks[0], a SELL close takes bids[0]; `''` when none. */
export function bestOppositePrice(side: CloseSide, top: BookTop): string {
  const levels = side === 'BUY' ? top.asks : top.bids
  for (const price of levels) {
    const text = positiveDecimal(price)
    if (text !== '') return text
  }
  return ''
}

/** Default close price: `last` if positive, else `mark`, else `''`; kept at `dp` (trailing zeros). */
export function defaultClosePrice(last: string, mark: string, dp: number): string {
  const source = firstPositive(last, mark)
  if (source === '') return ''
  return new Decimal(source).toFixed(Math.max(0, dp))
}

/** `percent`% of the closable contracts, floored to whole contracts; 100 returns `canClose` itself. */
export function percentContracts(canClose: string, percent: 25 | 50 | 75 | 100): string {
  const value = positiveDecimal(canClose)
  if (value === '') return '0'
  if (percent === 100) return value
  return new Decimal(value).times(percent).dividedBy(100).toFixed(0, Decimal.ROUND_DOWN)
}

/** `contracts` expressed in the entry unit, rounded down. */
export function contractsToEntry(contracts: string, unit: SizeUnit, market: SizeMarket): string {
  return contractsToUnit(contracts, unit, market, 'down')
}

export interface CloseFieldError {
  field: 'price' | 'qty'
  key: string
  params?: Record<string, string | number>
}

export interface CloseValidationInput {
  kind: CloseKind
  side: CloseSide
  /** Ignored for a market close. */
  rawPrice: string
  /** Amount in `unit`. */
  rawQty: string
  unit: SizeUnit
  /** Contracts chosen by a quick pick and not edited since: bypasses unit parsing when set. */
  presetContracts?: string
  /** Coin per contract, e.g. `'0.0001'`. */
  multiplier: string
  /** Tick = 10^-pricePrecision. */
  pricePrecision: number
  /** Decimals of a USDT amount. */
  coinDp: number
  /** Closable contracts (already excludes resting close orders). */
  canClose: string
  /** Total position contracts. */
  positionVolume: string
  /** Live mark price (`''` unknown). */
  mark: string
  /** Last price (`''` unknown). */
  last: string
  filter?: { multiplierUp?: string; multiplierDown?: string }
  /** Max contracts per limit order (`''` / undefined = none). */
  maxLimitVolume?: string
  /** Max contracts per market order. */
  maxMarketVolume?: string
}

export interface CloseValidation {
  ok: boolean
  errors: CloseFieldError[]
  price: string
  contracts: string
  full: boolean
  band: PriceBand
}

/** Validates a close: price band for limits, unit → whole contracts, closable / per-order limits. */
export function validateClose(input: CloseValidationInput): CloseValidation {
  const { kind, side, unit, multiplier, pricePrecision, coinDp, canClose, positionVolume, mark, last } = input

  const band = closePriceBand({ mark, dp: pricePrecision, side, filter: input.filter })
  const errors: CloseFieldError[] = []

  let price = ''
  if (kind === 'limit') {
    const value = normalizeInput(input.rawPrice)
    if (value === '') {
      errors.push({ field: 'price', key: 'priceRequired' })
    } else if (!isDecimalString(value)) {
      errors.push({ field: 'price', key: 'invalidNumber' })
    } else if (!isPositive(value)) {
      errors.push({ field: 'price', key: 'mustBePositive' })
    } else if ((decimalPlaces(value) ?? 0) > pricePrecision) {
      errors.push({ field: 'price', key: 'pricePrecision', params: { dp: pricePrecision } })
    } else if (side === 'BUY' && band.max !== '' && new Decimal(value).gt(band.max)) {
      errors.push({ field: 'price', key: 'bandMax', params: { max: band.max, mark: band.mark } })
    } else if (side === 'SELL' && band.min !== '' && new Decimal(value).lt(band.min)) {
      errors.push({ field: 'price', key: 'bandMin', params: { min: band.min, mark: band.mark } })
    } else {
      price = value
    }
  }

  const reference = kind === 'limit' ? (price !== '' ? price : firstPositive(last, mark)) : firstPositive(mark, last)
  const market: SizeMarket = { multiplier, price: reference, coinDp }

  let contracts = ''
  const uDp = unitDp(unit, { multiplier, coinDp })
  const preset = input.presetContracts
  let qtyError: CloseFieldError | null = null
  if (preset !== undefined && isWholePositive(preset)) {
    contracts = canonicalDecimal(preset)
  } else {
    const qty = normalizeInput(input.rawQty)
    if (qty === '') {
      qtyError = { field: 'qty', key: 'qtyRequired' }
    } else if (!isDecimalString(qty)) {
      qtyError = { field: 'qty', key: 'invalidNumber' }
    } else if (!isPositive(qty)) {
      qtyError = { field: 'qty', key: 'mustBePositive' }
    } else if ((decimalPlaces(qty) ?? 0) > uDp) {
      qtyError = { field: 'qty', key: 'qtyPrecision', params: { dp: uDp } }
    } else if (unit === 'quote' && reference === '') {
      qtyError = { field: 'qty', key: 'needPrice' }
    } else {
      contracts = unitToContracts(qty, unit, market)
      if (contracts === '') qtyError = { field: 'qty', key: 'needPrice' }
    }
  }

  if (qtyError === null) {
    const c = dec(contracts)
    const can = dec(canClose)
    const maxRaw = kind === 'limit' ? input.maxLimitVolume : input.maxMarketVolume
    const max = maxRaw !== undefined ? dec(maxRaw) : null
    if (can === null || !can.gt(0)) {
      qtyError = { field: 'qty', key: 'nothingToClose', params: { held: heldContracts(positionVolume, canClose) } }
    } else if (c !== null && c.lt(1)) {
      qtyError = { field: 'qty', key: 'belowOneContract', params: { amount: contractsToUnit('1', unit, market, 'up') } }
    } else if (c !== null && c.gt(can)) {
      qtyError = { field: 'qty', key: 'aboveCanClose', params: { amount: contractsToEntry(canClose, unit, market), contracts: canClose } }
    } else if (c !== null && max !== null && max.gt(0) && c.gt(max)) {
      qtyError = { field: 'qty', key: 'aboveMaxVolume', params: { max: canonicalDecimal(max.toFixed()) } }
    }
  }
  if (qtyError !== null) errors.push(qtyError)

  const c = dec(contracts)
  const can = dec(canClose)
  const pos = dec(positionVolume)
  const full = c !== null && can !== null && pos !== null && c.eq(can) && can.eq(pos)

  return { ok: errors.length === 0, errors, price, contracts, full, band }
}

/** Builds the wire payload for a close order (limit → GTC 1, market → 2). */
export function closeOrderPayload(input: {
  position: Pick<FuturesPosition, 'contractId' | 'orderSide' | 'positionType' | 'leverageLevel'>
  kind: CloseKind
  price: string
  contracts: string
  /** 市价 only: `marketCloseWire` (an IOC inside the liquidation price when needed); default a plain MARKET order. */
  wire?: MarketCloseWire
}): CreateOrderPayload {
  const { position } = input
  if (position.orderSide === '') throw new Error('close order needs a position side')
  const wire = input.wire ?? { type: 2, price: '' }
  return {
    contractId: position.contractId,
    positionType: position.positionType ?? 1,
    side: closeSideFor(position.orderSide),
    open: 'CLOSE',
    type: input.kind === 'limit' ? 1 : wire.type,
    volume: input.contracts,
    price: input.kind === 'limit' ? input.price : wire.price,
    leverageLevel: position.leverageLevel ?? 1,
    isConditionOrder: false,
  }
}

/**
 * Market close route: the whole position → `closeWhole` (a MARKET CLOSE of the whole position, cancelling its resting
 * close orders first; never light_close, which is a LIMIT refused past the liquidation price), otherwise one CLOSE
 * market order for the chosen contracts. Both are real MARKET orders.
 */
export function marketCloseRoute(v: Pick<CloseValidation, 'full'>): 'closeWhole' | 'order' {
  return v.full ? 'closeWhole' : 'order'
}

/* ------------------------------------------------------------------ helpers */

function dec(value: string): Decimal | null {
  const text = canonicalDecimal(value)
  return isDecimalString(text) ? new Decimal(text) : null
}

function positiveDecimal(value: string): string {
  const text = canonicalDecimal(value)
  return isDecimalString(text) && isPositive(text) ? text : ''
}

function firstPositive(...values: string[]): string {
  for (const value of values) {
    const text = positiveDecimal(value)
    if (text !== '') return text
  }
  return ''
}

function isWholePositive(value: string): boolean {
  const text = canonicalDecimal(value)
  return isDecimalString(text) && /^\d+$/.test(text) && new Decimal(text).gt(0)
}

function heldContracts(positionVolume: string, canClose: string): string {
  const pv = dec(positionVolume)
  if (pv === null || !pv.gt(0)) return ''
  const cv = dec(canClose)
  if (cv === null || cv.lt(0)) return canonicalDecimal(pv.toFixed(0, Decimal.ROUND_DOWN))
  const held = pv.minus(cv)
  return canonicalDecimal(held.lt(0) ? '0' : held.toFixed(0, Decimal.ROUND_DOWN))
}

/* ------------------------------------------------------------------ 市价平仓 wire (liquidation-aware) */

/** How a 市价 close goes on the wire: a plain MARKET order, or an IOC limit just inside the liquidation price. */
export type MarketCloseWire = { type: 2; price: '' } | { type: 3; price: string }

/**
 * 市价平仓 on the wire: always a plain MARKET order (10-03).
 *
 * History: on 09-30 (owner bug 10058 「预计成交价格低于强平价格，无法下单」) the guard turned a MARKET close into an IOC limit
 * at mark × (1 ∓ marketTakeBound) and the order service refused any non-MARKET close priced past the liquidation price,
 * so this sent its own IOC one tick inside the liquidation price for high-leverage positions. Since 10-01 the server
 * handles that case itself: IOC / FOK closes skip the liquidation-price check (L670, `closeioc-20261001`, core precheck)
 * and the core caps a user's MARKET close at the bankruptcy price (docs/03-reference/futures-pnl.md). A client-side IOC
 * made the order an "IOC" in every list (10-03 owner bug: 全部平仓 shown as IOC); a MARKET order is recorded as MARKET
 * and listed as 市价. The parameters stay for the callers.
 */
export function marketCloseWire(input: {
  /** Side of the POSITION being closed. */
  positionSide: 'BUY' | 'SELL'
  liquidationPrice: string
  mark: string
  /** Guard `marketTakeBound` for the contract (e.g. 0.05). */
  takeBound: string
  pricePrecision: number
}): MarketCloseWire {
  void input
  return { type: 2, price: '' }
}

import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'

/**
 * 最大可开 exactly as the order service decides it (`ValidateServiceImpl`, 2026-10-01 owner scenarios: 「开多后再开空，
 * 滑块 100% 开不出来」 — the vendor adds the EXISTING position value on BOTH sides to the new order).
 *
 * Tier cap (`checkPosition` + `checkOrder`, 10013 「超出当前杠杆最大持仓总量限制」):
 *   Σ positions of this contract, both sides: volume × avg_price × multiplier
 *   + Σ resting OPEN orders of this contract: unfilled volume × price × multiplier (market: volume − deal money)
 *   + the new opening order's value
 *   ≤ maxHoldAmount of the leverage tier (`ContractConfigLever.getMaxPositionBalance`).
 *   When the positions alone already exceed it, NO opening order is accepted (checkPosition refuses first).
 * Margin (`checkPosition` / `checkOrder`, ORDER_ACCOUNT_ENOUGH): new value ÷ leverage ≤ balance − cross occupancy, which
 *   is the server's 可用 (`canUseAmount` = accountNormal − totalCost); the ticket also keeps the opening taker fee.
 *
 * avg_price is not in the positions answer: it is `open_price` moved by the per-minute settlement, and the answer gives
 * that move as `settleProfit` = (avg − open) × volume × multiplier × direction, so avg = open + direction × settleProfit ÷
 * (volume × multiplier).
 */

export interface LimitPosition {
  orderSide: 'BUY' | 'SELL' | ''
  positionVolume: string
  openAvgPrice: string
  settleProfit: string
}

export interface LimitOrder {
  open: 'OPEN' | 'CLOSE' | ''
  type: number | null
  price: string
  volume: string
  dealVolume: string
}

function dec(value: string | null | undefined): Decimal | null {
  const text = canonicalDecimal(String(value ?? ''))
  return isDecimalString(text) ? new Decimal(text) : null
}

function signedDec(value: string | null | undefined): Decimal | null {
  const text = String(value ?? '').trim()
  return /^-?\d+(\.\d+)?$/.test(text) ? new Decimal(text) : null
}

/** The server's avg_price of a position (open price moved by the settled PnL); the open price when unknown. */
export function positionAvgPrice(position: LimitPosition, multiplier: string): string {
  const open = dec(position.openAvgPrice)
  const volume = dec(position.positionVolume)
  const mult = dec(multiplier)
  if (open === null) return ''
  const settled = signedDec(position.settleProfit)
  if (settled === null || volume === null || mult === null || volume.lte(0) || mult.lte(0) || position.orderSide === '') return open.toFixed()
  const direction = position.orderSide === 'BUY' ? 1 : -1
  return open.plus(settled.times(direction).dividedBy(volume.times(mult))).toFixed()
}

/** Value the server already counts against the tier cap on this contract (positions both sides + resting OPEN orders). */
export function tierUsedValue(input: { positions: readonly LimitPosition[]; orders: readonly LimitOrder[]; multiplier: string }): string {
  const mult = dec(input.multiplier)
  if (mult === null) return '0'
  let used = new Decimal(0)
  for (const position of input.positions) {
    const volume = dec(position.positionVolume)
    const avg = dec(positionAvgPrice(position, input.multiplier))
    if (volume !== null && avg !== null) used = used.plus(volume.times(avg).times(mult))
  }
  for (const order of input.orders) {
    if (order.open !== 'OPEN') continue
    const volume = dec(order.volume)
    const dealt = dec(order.dealVolume) ?? new Decimal(0)
    const price = dec(order.price)
    if (volume === null) continue
    if (order.type === 2) {
      // Resting market OPEN (transient): its volume is the USDT value; count it whole (deal money is not in the list).
      used = used.plus(volume)
      continue
    }
    const left = volume.minus(dealt)
    if (left.gt(0) && price !== null) used = used.plus(left.times(price).times(mult))
  }
  return used.toFixed()
}

/** Tier room for a new opening order (`''` = cap unknown → no tier limit applied; never below 0). */
export function tierRoomFor(cap: string, used: string): string {
  const c = dec(cap)
  if (c === null) return ''
  const u = dec(used) ?? new Decimal(0)
  const room = c.minus(u)
  return room.gt(0) ? room.toFixed() : '0'
}

/** Largest opening value: the margin-based maximum capped by the tier room, rounded down to `dp`. */
export function maxOpenValue(byMargin: string, tierRoom: string, dp: number): string {
  const margin = dec(byMargin)
  if (margin === null) return ''
  const room = dec(tierRoom)
  const value = room === null || margin.lte(room) ? margin : room
  return value.toDecimalPlaces(Math.max(0, dp), Decimal.ROUND_DOWN).toFixed(Math.max(0, dp))
}

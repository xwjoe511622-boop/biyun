import { Decimal } from '@/modules/finance/decimal'
import { isSignedDecimal } from './signed'

/**
 * What changing the leverage of one contract will do, computed before `user/level_edit` is sent, so the
 * dialog can show it and refuse what mainstream exchanges refuse. Backend (docs「调整杠杆的规则」; guards
 * `levguard-20260929` since 2026-09-29 04:47, `CoPositionServiceImpl.changeLeverChecked` + `LeverChangeRules`):
 *
 * - Always range-checked: [minLever, min(maxLever, userMaxLevel)], else 10069 (also without a position).
 * - Any resting order of the contract: 10067 (with or without a position).
 * - Cross: initial margin = position value / leverage, so lowering takes that much more from 可用; the
 *   server refuses (10068) when 可用 is not enough. The liquidation price does not move (cross
 *   liquidation only uses maintenance margin).
 * - Isolated: lowering moves the missing margin (value / new leverage, losses counted, profits not) from
 *   可用 into the position in the same transaction, or refuses (10070). Raising keeps the margin. The
 *   browser only adds the margin itself when an older server answers without `isolatedTopUps`.
 *
 * All amounts are decimal strings in the margin coin. Estimates use the mark-price position value the
 * server returns; the server re-checks everything.
 */

export interface LeveragePosition {
  id: number
  positionType: 1 | 2 | null
  orderSide: 'BUY' | 'SELL' | ''
  positionVolume: string
  /** Position value at the mark price (`positionBalance`). */
  positionBalance: string
  /** Isolated: margin + realized + unrealized (`PositionUtils.getHoldAmount`); cross: account equity. */
  holdAmount: string
  realizedAmount: string
  unRealizedAmount: string
  /** Mark vs open_price PnL; with `settleProfit` gives the server's internal PnL since the last settlement. */
  openRealizedAmount?: string
  settleProfit?: string
  reducePrice: string
  keepRate: string
  maxFeeRate?: string
  leverageLevel: number | null
}

export interface LeverageChangeInput {
  current: number
  next: number
  /** Open positions of this contract only. */
  positions: LeveragePosition[]
  /** Account `canUseAmount`; `''` when not loaded. */
  available: string
  /** Resting (non-conditional) orders of this contract; `null` when unknown. */
  restingOrders: number | null
  /** Contract face value (`multiplier`), e.g. `0.0001` BTC. */
  multiplier: string
  /** `leverOriginCeiling`: tier upper-bound leverage -> max position value at that leverage. */
  ceiling: Record<string, string>
  /** Margin-coin decimals used to round top-ups up. */
  precision: number
}

export type LeverageBlock =
  | { key: 'restingOrders'; params: { n: number } }
  | { key: 'tierLimit'; params: { lever: number; limit: string; value: string } }
  | { key: 'insufficientCross'; params: { lever: number; need: string; available: string; minLever: number | null } }
  | { key: 'insufficientIsolated'; params: { lever: number; need: string; available: string; minLever: number | null } }

export interface IsolatedTopUp {
  positionId: number
  side: 'BUY' | 'SELL' | ''
  amount: string
  liqBefore: string
  liqAfter: string
}

export interface LeverageChangePlan {
  direction: 'up' | 'down' | 'same'
  hasPositions: boolean
  hasCross: boolean
  hasIsolated: boolean
  block: LeverageBlock | null
  /** Extra cross initial margin taken from 可用 (negative when raising frees margin). */
  crossMarginDelta: string
  isolatedTopUps: IsolatedTopUp[]
  topUpTotal: string
  /** 可用 after the change (never below 0 in the UI, but the raw value tells how short it is). */
  availableAfter: string
  /** Cross liquidation prices of this contract, unchanged by the leverage (for display). */
  crossLiq: { side: 'BUY' | 'SELL' | ''; price: string }[]
}

function num(value: string | undefined): Decimal | null {
  return value !== undefined && isSignedDecimal(value) ? new Decimal(value) : null
}

const ZERO = new Decimal(0)
const pos = (value: Decimal): Decimal => (value.isNegative() ? ZERO : value)

/** Max position value allowed at `lever`: the smallest tier whose upper-bound leverage is >= lever. */
export function tierCeiling(ceiling: Record<string, string>, lever: number): string {
  const keys = Object.keys(ceiling).map(Number).filter((k) => Number.isInteger(k)).sort((a, b) => a - b)
  const key = keys.find((k) => k >= lever)
  return key === undefined ? '' : ceiling[String(key)] ?? ''
}

/**
 * Margin an isolated position must hold at `lever` minus what it holds, the same way the server counts
 * the removable margin (`PositionUtils.getCanSubMarginAmount`: profits are not counted, losses are).
 */
export function isolatedShortfall(position: LeveragePosition, lever: number): Decimal | null {
  const value = num(position.positionBalance)
  const hold = num(position.holdAmount)
  const realized = num(position.realizedAmount) ?? ZERO
  // The server counts its internal PnL since the last per-minute settlement (mark vs avg_price). From 2026-09-29 the
  // API `unRealizedAmount` is the Binance value (mark vs open_price), so derive the internal one when both parts exist.
  const open = num(position.openRealizedAmount ?? '')
  const settled = num(position.settleProfit ?? '')
  const unrealized = (open !== null && settled !== null ? open.minus(settled) : num(position.unRealizedAmount)) ?? ZERO
  if (value === null || hold === null || lever <= 0) return null
  const base = hold.minus(Decimal.max(realized, 0)).minus(Decimal.max(unrealized, 0))
  return pos(value.dividedBy(lever).minus(base))
}

/** Isolated liquidation price after adding `amount` margin (`PublicServiceImpl.reducePrice`, linear contract). */
export function isolatedLiqAfterTopUp(position: LeveragePosition, amount: Decimal, multiplier: string): string {
  const liq = num(position.reducePrice)
  const volume = num(position.positionVolume)
  const face = num(multiplier)
  if (liq === null || volume === null || face === null || volume.isZero() || face.isZero()) return ''
  if (amount.isZero()) return liq.toFixed()
  const k = (num(position.keepRate) ?? ZERO).plus(num(position.maxFeeRate) ?? ZERO)
  const qty = volume.times(face)
  if (position.orderSide === 'BUY') return liq.minus(amount.dividedBy(qty.times(new Decimal(1).minus(k)))).toFixed()
  if (position.orderSide === 'SELL') return liq.plus(amount.dividedBy(qty.times(new Decimal(1).plus(k)))).toFixed()
  return ''
}

function levelOf(position: LeveragePosition, fallback: number): number {
  return position.leverageLevel !== null && position.leverageLevel > 0 ? position.leverageLevel : fallback
}

/** Cross extra initial margin and isolated top-ups needed at `lever`. */
function needAt(input: LeverageChangeInput, lever: number): { cross: Decimal; topUps: IsolatedTopUp[]; topUpTotal: Decimal } {
  let cross = ZERO
  const topUps: IsolatedTopUp[] = []
  let topUpTotal = ZERO
  for (const position of input.positions) {
    const value = num(position.positionBalance)
    if (value === null) continue
    if (position.positionType === 1) {
      cross = cross.plus(value.dividedBy(lever)).minus(value.dividedBy(levelOf(position, input.current)))
    } else if (position.positionType === 2 && lever < levelOf(position, input.current)) {
      const shortfall = isolatedShortfall(position, lever)
      if (shortfall === null || shortfall.isZero()) continue
      const amount = shortfall.toDecimalPlaces(input.precision, Decimal.ROUND_UP)
      topUps.push({
        positionId: position.id,
        side: position.orderSide,
        amount: amount.toFixed(),
        liqBefore: position.reducePrice,
        liqAfter: isolatedLiqAfterTopUp(position, amount, input.multiplier),
      })
      topUpTotal = topUpTotal.plus(amount)
    }
  }
  return { cross, topUps, topUpTotal }
}

/** Lowest leverage between next and current (exclusive) that 可用 can carry; null when none. */
function minFeasible(input: LeverageChangeInput, available: Decimal): number | null {
  for (let lever = input.next + 1; lever < input.current; lever += 1) {
    const need = needAt(input, lever)
    if (pos(need.cross).plus(need.topUpTotal).lte(available)) return lever
  }
  return null
}

export function planLeverageChange(input: LeverageChangeInput): LeverageChangePlan {
  const { current, next } = input
  const direction = next > current ? 'up' : next < current ? 'down' : 'same'
  const positions = input.positions.filter((position) => (num(position.positionVolume) ?? ZERO).gt(0))
  const scoped = { ...input, positions }
  const hasCross = positions.some((position) => position.positionType === 1)
  const hasIsolated = positions.some((position) => position.positionType === 2)
  const need = needAt(scoped, next)
  const available = num(input.available)
  const availableAfter = available === null ? '' : available.minus(need.cross).minus(need.topUpTotal).toFixed()
  const plan: LeverageChangePlan = {
    direction,
    hasPositions: positions.length > 0,
    hasCross,
    hasIsolated,
    block: null,
    crossMarginDelta: need.cross.toFixed(),
    isolatedTopUps: need.topUps,
    topUpTotal: need.topUpTotal.toFixed(),
    availableAfter,
    crossLiq: positions.filter((position) => position.positionType === 1).map((position) => ({ side: position.orderSide, price: position.reducePrice })),
  }
  if (direction === 'same') return plan

  // Resting orders: with a position the server refuses (10023); without one it accepts, but the resting orders keep their
  // old leverage and every new order silently inherits it until they are gone. Either way: cancel them first.
  if (input.restingOrders !== null && input.restingOrders > 0) {
    plan.block = { key: 'restingOrders', params: { n: input.restingOrders } }
    return plan
  }
  if (positions.length === 0) return plan

  if (direction === 'up') {
    const limit = tierCeiling(input.ceiling, next)
    const biggest = positions.map((position) => num(position.positionBalance) ?? ZERO).reduce((a, b) => Decimal.max(a, b), ZERO)
    if (limit !== '' && biggest.gt(limit)) plan.block = { key: 'tierLimit', params: { lever: next, limit, value: biggest.toFixed() } }
    return plan
  }

  if (available === null) return plan
  const cost = pos(need.cross).plus(need.topUpTotal)
  if (cost.gt(available)) {
    const params = { lever: next, need: cost.toFixed(), available: available.toFixed(), minLever: minFeasible(scoped, available) }
    plan.block = need.topUpTotal.gt(0) && need.cross.lte(0) ? { key: 'insufficientIsolated', params } : { key: 'insufficientCross', params }
  }
  return plan
}

/**
 * Chinese/English message key for server codes met on `user/level_edit`, or null to keep the server text.
 * 10067–10070: backend guards since 2026-09-29 (open orders / cross margin short / out of range / isolated margin short);
 * 10023 stays for any other failure, 10012 is the order-side range check.
 */
const LEVERAGE_ERROR_CODES = new Set(['10023', '10012', '10067', '10068', '10069', '10070'])
export function leverageErrorKey(code: string): string | null {
  return LEVERAGE_ERROR_CODES.has(code) ? `fut.lev.err${code}` : null
}

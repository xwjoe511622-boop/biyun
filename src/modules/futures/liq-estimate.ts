import { Decimal } from '@/modules/finance/decimal'

/**
 * 下单前预估强平价 (Binance order panel "Liq Price"), U-margined linear contracts only, using the vendor's own formula
 * (`PublicServiceImpl.reducePrice`, back-futures futures-order-service) so the estimate becomes the position row's
 * `reducePrice` once filled:
 *
 *   long  liq = (E − V) ÷ (Q × (k + f − 1))        short liq = (E + V) ÷ (Q × (k + f + 1))
 *
 *   Q  base quantity = contracts × multiplier (merged with an existing same-side position of the same margin mode)
 *   V  position value (existing position at the mark `positionBalance` + new contracts × multiplier × order price)
 *   k  maintenance rate of the ladder tier holding the merged value (`common/get_ladder_info`, min < value ≤ max)
 *   f  max(close maker, close taker) fee rate
 *   E  cross:    account `totalMargin` (cross wallet + cross unrealized) − open fee − Σ other cross positions
 *                value × (k + f + k_other)  (the vendor charges this position's k and f on the others' value too)
 *      isolated: new initial margin (value ÷ leverage) − open fee + existing position `holdAmount`
 *
 * Checked on 2026-09-30 against live `reducePrice` of synthetic account B (cross long / cross short / isolated long,
 * BTC 20 contracts; see docs/03-reference/futures-pnl.md). Returns `''` when an input is missing and `'none'` when the
 * price is ≤ 0 (no liquidation even at 0 / no upper bound).
 */

export interface LadderTier {
  min: string
  max: string
  rate: string
}

export interface LiqOtherPosition {
  /** Mark-price value (`positionBalance`). */
  value: string
  keepRate: string
}

export interface LiqEstimateInput {
  side: 'BUY' | 'SELL'
  /** New contracts being opened (whole contracts). */
  contracts: string
  /** Order price (limit) or the reference price (market). */
  price: string
  multiplier: string
  leverage: number
  marginModel: 1 | 2
  openFeeRate: string
  closeFeeRate: string
  ladder: LadderTier[]
  /** Same contract, same side, same margin mode, if any. */
  existing?: { contracts: string; value: string; holdAmount: string } | null
  /** Cross only: account `totalMargin`. */
  crossEquity?: string
  /** Cross only: every other cross position (other contracts / the opposite side). */
  others?: LiqOtherPosition[]
  dp: number
}

function dec(value: string | undefined | null): Decimal | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(text)) return null
  return new Decimal(text)
}

export function normalizeLadder(data: unknown): LadderTier[] {
  const root = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const holder = root.ladderList !== null && typeof root.ladderList === 'object' ? (root.ladderList as Record<string, unknown>) : root
  const rows = Array.isArray(holder.ladderList) ? holder.ladderList : Array.isArray(root.ladderList) ? root.ladderList : []
  const out: LadderTier[] = []
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const tier = { min: String(entry.minPositionValue ?? ''), max: String(entry.maxPositionValue ?? ''), rate: String(entry.minMarginRate ?? '') }
    if (dec(tier.min) !== null && dec(tier.max) !== null && dec(tier.rate) !== null) out.push(tier)
  }
  return out
}

/** Maintenance rate of the tier holding `value` (vendor: min < value ≤ max; `''` when no tier matches). */
export function keepRateFor(ladder: LadderTier[], value: Decimal): string {
  const tier = ladder.find((entry) => value.gt(new Decimal(entry.min)) && value.lte(new Decimal(entry.max)))
  return tier?.rate ?? ''
}

export function estimateLiqPrice(input: LiqEstimateInput): string {
  const contracts = dec(input.contracts)
  const price = dec(input.price)
  const multiplier = dec(input.multiplier)
  const openFee = dec(input.openFeeRate)
  const closeFee = dec(input.closeFeeRate)
  if (contracts === null || price === null || multiplier === null || openFee === null || closeFee === null) return ''
  if (contracts.lte(0) || price.lte(0) || multiplier.lte(0) || !(input.leverage > 0) || input.ladder.length === 0) return ''

  const newQty = contracts.times(multiplier)
  const newValue = newQty.times(price)
  const fee = newValue.times(openFee)
  let qty = newQty
  let value = newValue
  let hold = new Decimal(0)
  const existing = input.existing ?? null
  if (existing !== null) {
    const oldContracts = dec(existing.contracts)
    const oldValue = dec(existing.value)
    if (oldContracts === null || oldValue === null || oldContracts.lt(0) || oldValue.lt(0)) return ''
    qty = qty.plus(oldContracts.times(multiplier))
    value = value.plus(oldValue)
    if (input.marginModel === 2) {
      const oldHold = dec(existing.holdAmount)
      if (oldHold === null) return ''
      hold = oldHold
    }
  }
  const keep = dec(keepRateFor(input.ladder, value))
  if (keep === null) return ''

  let equity: Decimal
  if (input.marginModel === 2) {
    equity = newValue.dividedBy(input.leverage).minus(fee).plus(hold)
  } else {
    const cross = dec(input.crossEquity)
    if (cross === null) return ''
    equity = cross.minus(fee)
    for (const other of input.others ?? []) {
      const otherValue = dec(other.value)
      const otherKeep = dec(other.keepRate) ?? new Decimal(0)
      if (otherValue === null) continue
      equity = equity.minus(otherValue.times(keep.plus(closeFee).plus(otherKeep)))
    }
  }

  const one = new Decimal(1)
  const result = input.side === 'BUY'
    ? equity.minus(value).dividedBy(qty.times(keep.plus(closeFee).minus(one)))
    : equity.plus(value).dividedBy(qty.times(keep.plus(closeFee).plus(one)))
  if (result.lte(0)) return 'none'
  return result.toFixed(Math.max(0, input.dp), input.side === 'BUY' ? Decimal.ROUND_UP : Decimal.ROUND_DOWN)
}

import { Decimal, canonicalDecimal, isDecimalString, toDecString } from '@/modules/finance/decimal'
import { toNumberForDisplay } from '@/modules/finance/display'

/**
 * Quote value of `vol` at `price`: `vol * multiplier * price`. `multiplier` is `1` for spot (volume
 * in base coin) and the contract face value for futures (volume in contracts, L43). `''` when any
 * input is not a decimal.
 */
export function quoteValue(vol: string | number, price: string | number, multiplier = '1'): string {
  const v = canonicalDecimal(toDecString(vol))
  const p = canonicalDecimal(toDecString(price))
  const m = canonicalDecimal(multiplier)
  if (!isDecimalString(v) || !isDecimalString(p) || !isDecimalString(m)) return ''
  return new Decimal(v).times(m).times(p).toFixed()
}

export interface DepthPoint { price: number; total: number; notional: number }

/** Depth-chart points: cumulative volume and cumulative quote value (`Σ price * amount * multiplier`). */
export function depthPoints(rows: readonly { price: string; amount: string; total: string }[], multiplier = '1', volumeIsValue = false): DepthPoint[] {
  const factor = toNumberForDisplay(canonicalDecimal(multiplier)) ?? 1
  let notional = 0
  const points: DepthPoint[] = []
  rows.forEach((row) => {
    const price = toNumberForDisplay(canonicalDecimal(row.price))
    const amount = toNumberForDisplay(canonicalDecimal(row.amount))
    const total = toNumberForDisplay(canonicalDecimal(row.total))
    if (price === null || amount === null || total === null) return
    notional += volumeIsValue ? amount : price * amount * factor // float-ok: chart notional for display only (toNumberForDisplay)
    points.push({ price, total, notional })
  })
  return points
}

import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'
import { isSignedDecimal } from './signed'

/**
 * Binance position-table extras (PC, 2026-09-30).
 *
 * 损益两平价 (break-even): the price at which closing returns exactly the fees paid — opening at `entry` with the
 * open taker fee and closing with the close taker fee:
 *   long  BE = entry × (1 + fOpen) / (1 − fClose)
 *   short BE = entry × (1 − fOpen) / (1 + fClose)
 * Funding already paid is not included (our position record has no funding total).
 *
 * 预估资金费用 (next funding for this position, user's sign): long pays when the rate is positive, short receives:
 *   amount = −direction × volume × multiplier × mark × rate      (direction long = 1, short = −1)
 */

function dec(value: string): Decimal | null {
  const text = canonicalDecimal(value)
  return isDecimalString(text) ? new Decimal(text) : null
}

export function breakEvenPrice(input: { side: 'BUY' | 'SELL'; entry: string; openFee: string; closeFee: string; dp: number }): string {
  const entry = dec(input.entry)
  const fo = dec(input.openFee)
  const fc = dec(input.closeFee)
  if (entry === null || entry.lte(0) || fo === null || fc === null || fo.lt(0) || fc.lt(0) || fc.gte(1)) return ''
  const one = new Decimal(1)
  const value = input.side === 'BUY' ? entry.times(one.plus(fo)).dividedBy(one.minus(fc)) : entry.times(one.minus(fo)).dividedBy(one.plus(fc))
  return value.toFixed(Math.max(0, input.dp), Decimal.ROUND_HALF_UP)
}

export function estimatedFunding(input: { side: 'BUY' | 'SELL'; volume: string; multiplier: string; mark: string; rate: string; dp: number }): string {
  const volume = dec(input.volume)
  const multiplier = dec(input.multiplier)
  const mark = dec(input.mark)
  const rate = isSignedDecimal(input.rate.trim()) ? new Decimal(input.rate.trim()) : null
  if (volume === null || multiplier === null || mark === null || rate === null || volume.lte(0) || mark.lte(0)) return ''
  const direction = input.side === 'BUY' ? 1 : -1
  return volume.times(multiplier).times(mark).times(rate).times(-direction).toFixed(Math.max(0, input.dp), Decimal.ROUND_HALF_UP)
}

/**
 * Binance 保证金比率 box: 维持保证金 = Σ volume × multiplier × mark × maintenance rate (`keepRate`), 保证金比率 =
 * 维持保证金 ÷ 保证金余额 (account equity incl. unrealized PnL). `''` parts when unknown.
 */
export function accountMarginRatio(input: {
  positions: ReadonlyArray<{ volume: string; multiplier: string; mark: string; keepRate: string; maintenanceMargin?: string }>
  balance: string
  dp: number
}): { maintenance: string; ratio: string } {
  let total = new Decimal(0)
  for (const entry of input.positions) {
    if (entry.maintenanceMargin !== undefined) {
      const maintenance = dec(entry.maintenanceMargin)
      if (maintenance === null) return { maintenance: '', ratio: '' }
      total = total.plus(maintenance)
      continue
    }
    const volume = dec(entry.volume)
    const multiplier = dec(entry.multiplier)
    const mark = dec(entry.mark)
    const keep = dec(entry.keepRate)
    if (volume === null || multiplier === null || mark === null || keep === null) return { maintenance: '', ratio: '' }
    total = total.plus(volume.times(multiplier).times(mark).times(keep))
  }
  const maintenance = total.toFixed(Math.max(0, input.dp), Decimal.ROUND_HALF_UP)
  const balance = dec(input.balance)
  const ratio = balance === null || balance.lte(0) ? '' : total.dividedBy(balance).toFixed()
  return { maintenance, ratio }
}

export type RatioStyle = 'binance' | 'okx'

/**
 * Position-table 保证金 / 保证金比率 columns (owner 10-23: the old legacy fields showed the whole cross account
 * margin as every row's 保证金 and `holdAmount ÷ notional` as its ratio, e.g. 101.29%, which reads as "liquidated").
 *
 * 保证金: isolated = the position's isolated margin (`holdAmount`); cross = initial margin = notional ÷ leverage
 * (Binance / OKX both show the position's own margin, never the account balance).
 *
 * 保证金比率, Binance (www): maintenance ÷ margin balance — rises toward 100% = liquidation. Cross rows share the
 * account value (Σ cross maintenance ÷ cross margin balance); an isolated row uses its own maintenance ÷ its margin.
 * 保证金率, OKX (pro): the inverse (margin ÷ maintenance) — falls toward 100% = liquidation.
 *
 * Maintenance = notional × keepRate. `''` parts when unknown.
 */
export function positionMarginColumns(input: {
  isolated: boolean
  notional: string
  leverage: number | null
  keepRate: string
  /** Prefer the exact server maintenance to reconstructing it from a rounded display rate. */
  maintenanceMargin?: string
  holdAmount: string
  /** Cross: Σ notional × keepRate over the cross positions in this margin coin. */
  crossMaintenance: string
  /** Cross: margin balance available to cross positions (equity − isolated margins). */
  crossBalance: string
  style: RatioStyle
  dp: number
}): { margin: string; ratio: string; risk: 'safe' | 'warn' | 'danger' | 'unknown' } {
  const none = { margin: '', ratio: '', risk: 'unknown' as const }
  const notional = dec(input.notional)
  if (notional === null) return none
  const value = notional.abs()
  const keep = dec(input.keepRate)
  let margin: Decimal | null
  let maintenance: Decimal | null
  let balance: Decimal | null
  if (input.isolated) {
    margin = dec(input.holdAmount)
    maintenance = input.maintenanceMargin !== undefined ? dec(input.maintenanceMargin) : keep === null ? null : value.times(keep)
    balance = margin
  } else {
    margin = input.leverage !== null && input.leverage > 0 ? value.dividedBy(input.leverage) : null
    maintenance = dec(input.crossMaintenance)
    balance = dec(input.crossBalance)
  }
  const marginText = margin === null ? '' : margin.toFixed(Math.max(0, input.dp), Decimal.ROUND_HALF_UP)
  if (maintenance === null || balance === null || maintenance.lte(0) || balance.lte(0)) {
    return { margin: marginText, ratio: '', risk: 'unknown' }
  }
  const ratio = input.style === 'okx' ? balance.dividedBy(maintenance) : maintenance.dividedBy(balance)
  let risk: 'safe' | 'warn' | 'danger'
  if (input.style === 'okx') risk = ratio.lte('1.5') ? 'danger' : ratio.lte('3') ? 'warn' : 'safe'
  else risk = ratio.gte('0.8') ? 'danger' : ratio.gte('0.5') ? 'warn' : 'safe'
  return { margin: marginText, ratio: ratio.toFixed(), risk }
}

/** Σ notional × keepRate over cross positions (`''` when any part is unknown). */
export function crossMaintenance(rows: ReadonlyArray<{ notional: string; keepRate: string; maintenanceMargin?: string }>): string {
  let total = new Decimal(0)
  for (const row of rows) {
    if (row.maintenanceMargin !== undefined) {
      const maintenance = dec(row.maintenanceMargin)
      if (maintenance === null) return ''
      total = total.plus(maintenance)
      continue
    }
    const notional = dec(row.notional)
    const keep = dec(row.keepRate === '' ? '0' : row.keepRate)
    if (notional === null || keep === null) return ''
    total = total.plus(notional.abs().times(keep))
  }
  return total.toFixed()
}

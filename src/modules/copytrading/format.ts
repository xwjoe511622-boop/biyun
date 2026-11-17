import { Decimal, canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { fractionPercent } from './copytrading.api'

/** Signed display helpers for trader stats. Values stay strings; '' / invalid render as `--`. */

/**
 * `profitRatio` / `totalRatio` arrive ALREADY in percent (`-12.27` = -12.27 %): futures-trader writes them that way
 * (vendor `allReturnRate * 100`; Longbit 2026-10-01 `PnL / MaxBaseBalance * 100`). Treating them as a fraction showed
 * -1067 % for a -10.67 % trader (2026-10-01).
 */
export function signedPercent(value: string): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return { text: '--', tone: 'flat' }
  const percent = new Decimal(value).toFixed(2, Decimal.ROUND_HALF_UP)
  const negative = percent.startsWith('-')
  const zero = /^-?0(\.0+)?$/.test(percent)
  return { text: `${negative || zero ? '' : '+'}${zero ? '0.00' : percent}%`, tone: zero ? 'flat' : negative ? 'down' : 'up' }
}

export function signedPercentFromFraction(value: string): { text: string; tone: 'up' | 'down' | 'flat' } {
  const percent = fractionPercent(value)
  if (percent === '') return { text: '--', tone: 'flat' }
  const negative = percent.startsWith('-')
  const zero = /^-?0(\.0+)?$/.test(percent)
  return { text: `${negative || zero ? '' : '+'}${percent}%`, tone: zero ? 'flat' : negative ? 'down' : 'up' }
}

export function plainPercent(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return '--'
  return `${canonicalDecimal(value)}%`
}

export function signedAmount(value: string): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return { text: '--', tone: 'flat' }
  const negative = value.startsWith('-')
  const abs = canonicalDecimal(negative ? value.slice(1) : value)
  if (!isDecimalString(abs)) return { text: '--', tone: 'flat' }
  const zero = /^0(\.0+)?$/.test(abs)
  return { text: `${negative && !zero ? '-' : zero ? '' : '+'}${groupDigits(abs, 2)}`, tone: zero ? 'flat' : negative ? 'down' : 'up' }
}

export function amountText(value: string, dp: number | null = 2): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return '--'
  const negative = value.startsWith('-')
  const abs = canonicalDecimal(negative ? value.slice(1) : value)
  return isDecimalString(abs) ? `${negative ? '-' : ''}${groupDigits(abs, dp)}` : '--'
}

/** Server uses -1 for "not set". */
export function isUnset(value: string): boolean {
  return value === '' || value === '-1' || /^-1(\.0+)?$/.test(value)
}

import { Decimal, groupDigits, toDecString } from '@/modules/finance/decimal'

/**
 * Signed decimal helpers. `modules/finance/decimal.ts` only accepts non-negative strings (spot
 * balances and prices); futures PnL, funding rates and margin changes can be negative, so these
 * helpers accept an optional leading `-`. Everything stays a decimal string.
 */

const SIGNED_PATTERN = /^-?\d+(\.\d+)?$/

export function isSignedDecimal(value: string): boolean {
  return SIGNED_PATTERN.test(value)
}

/** JSON number/string -> canonical signed decimal string (`''` when unusable). */
export function signedDec(value: unknown): string {
  const text = toDecString(value)
  if (!isSignedDecimal(text)) {
    return ''
  }
  const decimal = new Decimal(text)
  return decimal.isZero() ? '0' : decimal.toFixed()
}

function d(value: string): Decimal {
  if (!isSignedDecimal(value)) {
    throw new Error(`not a signed decimal: "${value}"`)
  }
  return new Decimal(value)
}

export function sAdd(a: string, b: string): string {
  return d(a).plus(d(b)).toFixed()
}

export function sSub(a: string, b: string): string {
  return d(a).minus(d(b)).toFixed()
}

export function sMul(a: string, b: string): string {
  return d(a).times(d(b)).toFixed()
}

/** Rounds toward zero at `dp` decimals. */
export function sDiv(a: string, b: string, dp = 8): string {
  const divisor = d(b)
  if (divisor.isZero()) {
    throw new Error('division by zero')
  }
  return d(a).dividedBy(divisor).toFixed(dp, Decimal.ROUND_DOWN)
}

export function sCmp(a: string, b: string): -1 | 0 | 1 {
  const result = d(a).comparedTo(d(b))
  return result < 0 ? -1 : result > 0 ? 1 : 0
}

export function sign(value: string): -1 | 0 | 1 {
  if (!isSignedDecimal(value)) {
    return 0
  }
  const decimal = new Decimal(value)
  return decimal.isZero() ? 0 : decimal.isNegative() ? -1 : 1
}

export function sAbs(value: string): string {
  return d(value).abs().toFixed()
}

/** Rounds toward zero to `dp` places (display). */
export function sFixed(value: string, dp: number): string {
  return d(value).toFixed(Math.max(0, dp), Decimal.ROUND_DOWN)
}

/** Grouped display with an explicit sign for non-zero values: `-1,234.50`, `+12.00`. */
export function signedDisplay(value: string, dp: number, withPlus = true): string {
  if (!isSignedDecimal(value)) {
    return '--'
  }
  const fixed = sFixed(value, dp)
  const negative = fixed.startsWith('-')
  const body = groupDigits(negative ? fixed.slice(1) : fixed, dp)
  if (new Decimal(fixed).isZero()) {
    return body
  }
  return negative ? `-${body}` : withPlus ? `+${body}` : body
}

/** Ratio (`0.0123`) -> percent string with sign (`+1.23%`). */
export function signedPercent(ratio: string, dp = 2, withPlus = true): string {
  if (!isSignedDecimal(ratio)) {
    return '--'
  }
  const percent = new Decimal(ratio).times(100).toFixed(dp, Decimal.ROUND_HALF_UP)
  const zero = new Decimal(percent).isZero()
  const text = zero ? new Decimal(0).toFixed(dp) : percent
  return `${!zero && withPlus && !text.startsWith('-') ? '+' : ''}${text}%`
}

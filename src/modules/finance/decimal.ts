import Decimal from 'decimal.js'

/**
 * All money math goes through Decimal.js on decimal strings.
 * `Number` / `parseFloat` are never used for amounts; server payloads that arrive as JSON
 * numbers are stringified first (`toDecString`) so the arithmetic stays exact.
 */

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -60,
  toExpPos: 60,
})

export { Decimal }

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/

/** JSON numbers/strings (and Decimal) -> plain decimal string. `null`/`undefined`/`''` -> `''`. */
export function toDecString(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (value instanceof Decimal) {
    return value.toFixed()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return ''
    }
    return new Decimal(value).toFixed()
  }
  if (typeof value === 'string') {
    const text = value.trim()
    return /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(text) ? new Decimal(text).toFixed() : text
  }
  return ''
}

/** `true` for plain non-negative decimal strings such as `"0"`, `"12"`, `"0.0001"`. */
export function isDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value)
}

/**
 * Number of digits after the decimal point, taken from the string.
 * Important: the server validates BigDecimal scale, so `"1.2300"` counts as 4 decimals.
 */
export function decimalPlaces(value: string): number | null {
  if (!isDecimalString(value)) {
    return null
  }
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

/** Removes trailing zeros (and a trailing dot) without changing the value: `"1.2300"` -> `"1.23"`. */
export function canonicalDecimal(value: string): string {
  const trimmed = value.trim()
  if (!isDecimalString(trimmed)) {
    return trimmed
  }
  if (trimmed.indexOf('.') === -1) {
    return trimmed
  }
  const withoutZeros = trimmed.replace(/0+$/, '')
  return withoutZeros.endsWith('.') ? withoutZeros.slice(0, -1) : withoutZeros
}

function dec(value: string): Decimal {
  if (!isDecimalString(value)) {
    throw new Error(`not a decimal string: "${value}"`)
  }
  return new Decimal(value)
}

export function add(a: string, b: string): string {
  return dec(a).plus(dec(b)).toFixed()
}

export function sub(a: string, b: string): string {
  return dec(a).minus(dec(b)).toFixed()
}

export function mul(a: string, b: string): string {
  return dec(a).times(dec(b)).toFixed()
}

/** Division rounds down to `dp` decimals (exchange convention for order budgets). */
export function div(a: string, b: string, dp = 8): string {
  const divisor = dec(b)
  if (divisor.isZero()) {
    throw new Error('division by zero')
  }
  return dec(a).dividedBy(divisor).toFixed(dp, Decimal.ROUND_DOWN)
}

export function cmp(a: string, b: string): -1 | 0 | 1 {
  const result = dec(a).comparedTo(dec(b))
  if (result < 0) {
    return -1
  }
  return result > 0 ? 1 : 0
}

const SIGNED_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

/** `true` for plain decimal strings that may carry a leading minus, such as a 24h change ratio `"-0.0027"`. */
export function isSignedDecimalString(value: string): boolean {
  return SIGNED_DECIMAL_PATTERN.test(value)
}

/**
 * Exact comparison of signed decimal strings (24h change ratios, PnL). `cmp` stays non-negative only, because
 * amounts, prices and sizes must never be negative there; this one is for values that legitimately are.
 */
export function cmpSigned(a: string, b: string): -1 | 0 | 1 {
  if (!isSignedDecimalString(a) || !isSignedDecimalString(b)) {
    throw new Error(`not a signed decimal string: "${isSignedDecimalString(a) ? b : a}"`)
  }
  const result = new Decimal(a).comparedTo(new Decimal(b))
  if (result < 0) {
    return -1
  }
  return result > 0 ? 1 : 0
}

export function gt(a: string, b: string): boolean {
  return cmp(a, b) > 0
}

export function gte(a: string, b: string): boolean {
  return cmp(a, b) >= 0
}

export function lt(a: string, b: string): boolean {
  return cmp(a, b) < 0
}

export function lte(a: string, b: string): boolean {
  return cmp(a, b) <= 0
}

export function isZero(value: string): boolean {
  return isDecimalString(value) && dec(value).isZero()
}

export function isPositive(value: string): boolean {
  return isDecimalString(value) && dec(value).greaterThan(0)
}

export function max(a: string, b: string): string {
  return dec(a).greaterThanOrEqualTo(dec(b)) ? dec(a).toFixed() : dec(b).toFixed()
}

export function min(a: string, b: string): string {
  return dec(a).lessThanOrEqualTo(dec(b)) ? dec(a).toFixed() : dec(b).toFixed()
}

export function sum(values: string[]): string {
  let accumulator = new Decimal(0)
  values.forEach((value) => {
    accumulator = accumulator.plus(dec(value))
  })
  return accumulator.toFixed()
}

/** Rounds down to `dp` decimals and returns a fixed-point string (display / padding only). */
export function toFixedString(value: string, dp: number): string {
  if (!isDecimalString(value)) {
    return value
  }
  return dec(value).toFixed(dp, Decimal.ROUND_DOWN)
}

/** `ratio` (e.g. `0.0123` from the ticker) rendered as a percent string without the `%` sign. */
export function ratioToPercent(ratio: string, dp = 2): string {
  if (!/^-?\d+(\.\d+)?$/.test(ratio)) {
    return ''
  }
  return new Decimal(ratio).times(100).toFixed(dp, Decimal.ROUND_HALF_UP)
}

/** Formats a `0-9` decimal for display: `"1234567.5"` -> `"1,234,567.5"`. */
export function groupDigits(value: string, dp: number | null = null): string {
  if (!isDecimalString(value)) {
    return value
  }
  const normalized = dp === null ? canonicalDecimal(value) : toFixedString(value, dp)
  const [integerPart, fractionPart] = normalized.split('.')
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`
}

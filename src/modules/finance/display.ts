import { Decimal, canonicalDecimal, isDecimalString, ratioToPercent } from './decimal'

/**
 * Presentation-only helpers.
 *
 * Canvas/CSS need JavaScript numbers, so these functions convert with Decimal.js
 * (`Decimal.toNumber()`); no `Number()` / `parseFloat` parsing is used and no arithmetic
 * happens on these values afterwards.
 */

export function toNumberForDisplay(value: string): number | null {
  if (!isDecimalString(value)) {
    return null
  }
  return new Decimal(value).toNumber()
}

/** UNIX seconds for the charting library (K-line bar ids are seconds). */
export function toChartSeconds(value: string | number): number | null {
  const text = typeof value === 'number' ? String(value) : value
  const seconds = toNumberForDisplay(canonicalDecimal(text))
  return seconds === null || !Number.isFinite(seconds) ? null : seconds
}

/** UTC `HH:MM:SS` from a millisecond timestamp. Returns `--` when the value is unusable. */
export function formatClock(timestamp: string | number | undefined | null): string {
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return '--'
  }
  const text = typeof timestamp === 'number' ? String(timestamp) : canonicalDecimal(timestamp)
  const millis = toNumberForDisplay(text)
  if (millis === null || !Number.isFinite(millis) || millis <= 0) {
    return '--'
  }
  const date = new Date(millis)
  const pad = (part: number): string => (part < 10 ? `0${part}` : String(part))
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

export interface PercentView {
  text: string
  direction: 'up' | 'down' | 'flat'
}

/** Ticker `rose` is a ratio (`0.0123` -> `+1.23%`). */
export function percentView(ratio: string): PercentView {
  if (!/^-?\d+(\.\d+)?$/.test(ratio)) {
    return { text: '--', direction: 'flat' }
  }
  const percent = ratioToPercent(ratio, 2)
  const value = new Decimal(percent)
  if (value.isZero()) {
    return { text: '0.00%', direction: 'flat' }
  }
  return {
    text: value.isPositive() ? `+${percent}%` : `${percent}%`,
    direction: value.isPositive() ? 'up' : 'down',
  }
}

/** Width in percent for a cumulative depth bar: `total / max`. */
export function depthBarWidth(total: string, max: string): string {
  const totalValue = toNumberForDisplay(total)
  const maxValue = toNumberForDisplay(max)
  if (totalValue === null || maxValue === null || maxValue <= 0) {
    return '0%'
  }
  const width = Math.min(100, Math.max(0, (totalValue / maxValue) * 100)) // float-ok: bar width percent, UI layout
  return `${width.toFixed(2)}%`
}

export function maxDecimal(values: string[]): string {
  let result = '0'
  values.forEach((value) => {
    if (!isDecimalString(value)) {
      return
    }
    result = new Decimal(value).greaterThan(result) ? value : result
  })
  return result
}

/** `12345678` -> `1234…5678` for id columns. */
export function shortenId(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 1) {
    return id
  }
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

/**
 * Compact human figure for large volumes (`12,345.6` -> `12.35K`). Display only; returns `--` for
 * non-decimal input so missing data never renders as zero.
 */
export function compactDecimal(value: string, dp = 2): string {
  const normalized = canonicalDecimal(value)
  if (!isDecimalString(normalized)) {
    return '--'
  }
  const number = new Decimal(normalized)
  const abs = number.abs()
  const units: [string, string][] = [['1e12', 'T'], ['1e9', 'B'], ['1e6', 'M'], ['1e3', 'K']]
  for (const [threshold, suffix] of units) {
    if (abs.gte(threshold)) {
      return `${number.div(threshold).toFixed(dp)}${suffix}`
    }
  }
  return number.toDecimalPlaces(abs.lt(1) ? 6 : 4).toString()
}

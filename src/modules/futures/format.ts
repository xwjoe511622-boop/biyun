import { canonicalDecimal, groupDigits, isDecimalString, toFixedString } from '@/modules/finance/decimal'

/** `YYYY-MM-DD HH:mm:ss` (UTC) from epoch milliseconds; `--` when missing. */
export function formatDateTime(ms: number | null | undefined, withYear = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '--'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  return withYear ? `${date.getUTCFullYear()}-${day} ${time}` : `${day} ${time}`
}

/** Grouped non-negative decimal at `dp` places (or as-is when `dp` is null); `--` when missing. */
export function amountText(value: string, dp: number | null = null): string {
  const normalized = canonicalDecimal(value)
  if (!isDecimalString(normalized)) return '--'
  return dp === null ? groupDigits(normalized) : groupDigits(toFixedString(normalized, dp), dp)
}

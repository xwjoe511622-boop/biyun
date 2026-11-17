import type { AccountBalanceData, CoinBalanceEntry } from '@/modules/api/types'
import { Decimal, canonicalDecimal } from '@/modules/finance/decimal'

/** Exact input coefficients are bounded; addition needs no intermediate rounding. */
const Exact = Decimal.clone({ precision: 128, rounding: Decimal.ROUND_DOWN, toExpNeg: -128, toExpPos: 128 })
const MESSAGE = 'Trading account snapshot is unavailable. Refresh to retry.'
function invalid(): never { throw new Error(MESSAGE) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function coin(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) return invalid()
  return value.toUpperCase()
}
function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.replace('.', '').length > 64) return invalid()
  return canonicalDecimal(value)
}

/**
 * Raw 201/202/207/221 quantities come from ONE core-backed classic response.
 * Never recover other buckets by subtracting independently rounded old fields,
 * or combine these with another REST/WS snapshot. 203 was not in this classic
 * total and is not silently added. Unknown/malformed members fail the whole read.
 */
export function exactTradingSnapshot(metadata: AccountBalanceData): AccountBalanceData {
  const base = record(metadata) as AccountBalanceData
  const original = record(base.allCoinMap)
  if (Object.keys(original).length > 10_000) return invalid()
  const seen = new Set<string>()
  const map: Record<string, CoinBalanceEntry> = {}
  for (const [key, raw] of Object.entries(original)) {
    const asset = coin(key)
    const entry = record(raw) as CoinBalanceEntry
    if (entry.coinName !== undefined && coin(entry.coinName) !== asset) return invalid()
    if (seen.has(asset)) return invalid()
    seen.add(asset)
    const free = amount(entry.normalBalanceExact)
    const locked = amount(entry.lockBalanceExact)
    const other = amount(entry.nonTradingBalance)
    if (typeof entry.overchargeRestricted !== 'boolean') return invalid()
    const total = new Exact(free).plus(locked).plus(other).toFixed()
    map[key] = {
      ...entry,
      normal_balance: entry.overchargeRestricted ? '0' : free,
      overcharge_balance: entry.overchargeRestricted ? free : entry.overcharge_balance === '' ? '' : '0',
      lock_balance: locked,
      total_balance: total,
      // Old BTC valuations priced projected quantities. Only BTC has an
      // identity conversion; other assets require their current own-market quote.
      btcValuatin: asset === 'BTC' ? total : '',
    }
  }
  return { ...base, allCoinMap: map, totalBalance: '' }
}

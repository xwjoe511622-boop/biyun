import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'

/**
 * Leverage tiers (杠杆档位): the largest position value a leverage allows (`common/get_ladder_info` →
 * `leverList.leverConfig`, a JSON string of `{ minLever, maxLever, maxHoldAmount }`). The order service refuses an
 * opening order when this contract's positions + open orders + the new order exceed it (`ValidateServiceImpl.checkOrder`
 * → 10013 「超出当前杠杆最大持仓总量限制」; `ContractConfigLever.getMaxPositionBalance`: minLever < lever ≤ maxLever).
 * 10-01 owner bug: 125x BTC, 123,615.8 USDT against a 50,000 cap, and the panel still showed 可开 107,282.5.
 */
export interface LeverTier {
  minLever: number
  maxLever: number
  /** Largest position value (USDT) at a leverage in (minLever, maxLever]. */
  maxHoldAmount: string
}

export function normalizeLeverTiers(data: unknown): LeverTier[] {
  const root = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const holder = root.leverList !== null && typeof root.leverList === 'object' ? (root.leverList as Record<string, unknown>) : {}
  let rows: unknown = holder.leverConfig
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows) } catch { rows = [] }
  }
  const out: LeverTier[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const minLever = Number(entry.minLever) // float-ok: integer leverage
    const maxLever = Number(entry.maxLever) // float-ok: integer leverage
    const maxHoldAmount = canonicalDecimal(String(entry.maxHoldAmount ?? ''))
    if (Number.isFinite(minLever) && Number.isFinite(maxLever) && isDecimalString(maxHoldAmount)) out.push({ minLever, maxLever, maxHoldAmount })
  }
  return out
}

/** Largest position value at `lever` (`''` when no tier matches or the tiers are unknown). */
export function maxPositionValue(tiers: readonly LeverTier[], lever: number): string {
  const tier = tiers.find((entry) => lever > entry.minLever && lever <= entry.maxLever)
  return tier === undefined ? '' : tier.maxHoldAmount
}

/**
 * Room left under the tier cap for a new opening order: cap − (this contract's position value + open-order value),
 * never below 0. `''` when the cap is unknown (no limit applied).
 */
export function tierRoom(cap: string, used: string): string {
  if (!isDecimalString(cap)) return ''
  const spent = isDecimalString(canonicalDecimal(used)) ? new Decimal(canonicalDecimal(used)) : new Decimal(0)
  const room = new Decimal(cap).minus(spent)
  return room.gt(0) ? room.toFixed() : '0'
}

import type { PublicInfoV4 } from '@/modules/api/types'
import { canonicalDecimal, isDecimalString, isPositive } from '@/modules/finance/decimal'
import type { MarketSymbol } from '@/modules/market/symbols'

/**
 * Margin availability from `/common/public_info_v4`:
 *   switch.lever_open (PublicAct.java:573, default "1")           — global lever switch
 *   market.market[QUOTE][PAIR].is_open_lever (PublicAct.java:1187) — per pair (ConfigSymbol.isOpenLever)
 *   market.market[QUOTE][PAIR].multiple (PublicAct.java:1188)      — configured BorrowRule.multiple; absent rules are marked unconfigured
 * Mirrors the legacy client (vuex/baseData.js:279-298): pairs are margin pairs only when the global
 * switch is "1" and the pair flag is truthy.
 */
export function isLeverSwitchOpen(info: PublicInfoV4 | null): boolean {
  const raw = info?.switch?.lever_open
  return raw !== undefined && String(raw).trim() === '1'
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return value.trim() === '1' || value.trim().toLowerCase() === 'true'
  return false
}

export interface MarginMarket {
  symbol: MarketSymbol
  /** Max leverage as configured (decimal string) or `''` when absent. */
  multiple: string
}

/** Margin pairs = spot pairs whose public-info entry has `is_open_lever` set (and the switch is on). */
export function buildMarginMarkets(info: PublicInfoV4 | null, symbols: MarketSymbol[]): MarginMarket[] {
  if (!isLeverSwitchOpen(info)) return []
  const market = info?.market?.market ?? {}
  const flags = new Map<string, { open: boolean; multiple: string }>()
  Object.values(market).forEach((group) => {
    Object.values(group ?? {}).forEach((entry) => {
      const name = typeof entry?.name === 'string' ? entry.name.trim().toUpperCase() : ''
      if (name === '') return
      const multiple = canonicalDecimal(String(entry.multiple ?? ''))
      flags.set(name, { open: truthyFlag(entry.is_open_lever), multiple: entry.borrowRuleConfigured !== false && isDecimalString(multiple) && isPositive(multiple) ? multiple : '' })
    })
  })
  return symbols
    .filter(symbol => flags.get(symbol.pair)?.open === true)
    .map(symbol => ({ symbol, multiple: flags.get(symbol.pair)?.multiple ?? '' }))
}

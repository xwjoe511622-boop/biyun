import { Decimal } from '@/modules/finance/decimal'
import type { TpslRow } from './types'

/**
 * The TP / SL prices a position row shows (Binance 「止盈/止损」 column). `get_assets_list` only fills
 * `takeProfitPrice` / `stopLossPrice` for copy-trading follower positions (`CoPositionServiceImpl`, follower branch), so
 * for everyone else the row reads the position's open TP/SL orders (`order/take_profit_stop_loss`) and shows the one
 * that fires first, the same rule the server uses for followers: long TP = lowest, long SL = highest; short TP =
 * highest, short SL = lowest. `''` when none.
 */
export function nearestTpsl(rows: { takeProfit: TpslRow[]; stopLoss: TpslRow[] }, side: 'BUY' | 'SELL'): { tp: string; sl: string } {
  const prices = (list: TpslRow[]): Decimal[] => list
    .map((row) => row.triggerPrice.trim())
    .filter((value) => /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) // float-ok: "> 0" check on a validated decimal string, boolean only
    .map((value) => new Decimal(value))
  const pick = (values: Decimal[], lowest: boolean): string => {
    if (values.length === 0) return ''
    return values.reduce((best, value) => (lowest ? (value.lt(best) ? value : best) : (value.gt(best) ? value : best))).toFixed()
  }
  const long = side === 'BUY'
  return { tp: pick(prices(rows.takeProfit), long), sl: pick(prices(rows.stopLoss), !long) }
}

/**
 * Binance keeps ONE take-profit and ONE stop-loss for the entire position ("TP/SL for entire position": setting a new
 * one replaces the old); partial-size TP/SL can stack. The server accepts any number, so the dialog does the
 * replacement: a new leg sized at the whole closable volume replaces the existing legs of the same kind that also
 * cover the whole position (`volume ≥ canClose`). Returns the rows to cancel after the new legs are placed.
 */
export function fullPositionReplacements(
  existing: { takeProfit: TpslRow[]; stopLoss: TpslRow[] } | null,
  next: { tp: boolean; sl: boolean; contracts: string },
  canClose: string,
): { takeProfit: TpslRow[]; stopLoss: TpslRow[] } {
  const none = { takeProfit: [] as TpslRow[], stopLoss: [] as TpslRow[] }
  const whole = (value: string): boolean => /^\d+(\.\d+)?$/.test(value.trim()) && /^\d+(\.\d+)?$/.test(canClose.trim()) && Number(canClose) > 0 && new Decimal(value.trim()).gte(canClose.trim()) // float-ok: "> 0" check on a validated decimal string, boolean only; comparison is Decimal
  if (existing === null || !whole(next.contracts)) return none
  return {
    takeProfit: next.tp ? existing.takeProfit.filter((row) => whole(row.volume)) : [],
    stopLoss: next.sl ? existing.stopLoss.filter((row) => whole(row.volume)) : [],
  }
}

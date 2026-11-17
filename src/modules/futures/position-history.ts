import { signedDec } from './signed'
import { int, isObj, list, udec } from './types'

/**
 * 仓位历史 (Binance "Position History"): closed positions from `position/history_position_list`
 * (`PositionController.historyPositionList`, rows with status Unwind, one contract per call, `count` for paging).
 * Field meanings, checked against live rows of synthetic account B on 2026-09-30:
 *   openPrice / closePrice   average open / close price
 *   volume                   closed contracts (the position's largest size)
 *   closeProfit              price PnL of the closes
 *   tradeFee / capitalFee    open + close fees / funding (signed, negative = paid)
 *   shareAmount              copy-trading profit share paid (signed)
 *   historyRealizedAmount    net realized PnL = closeProfit + tradeFee + capitalFee (+ shareAmount)
 *   ctime / mtime            opened / closed (epoch ms)
 */
export interface ClosedPosition {
  id: number
  contractId: number
  side: 'BUY' | 'SELL' | ''
  positionType: 1 | 2 | null
  leverageLevel: number | null
  volume: string
  openPrice: string
  closePrice: string
  closeProfit: string
  tradeFee: string
  capitalFee: string
  shareAmount: string
  realized: string
  openedAt: number | null
  closedAt: number | null
}

export function normalizeClosedPositions(data: unknown): { rows: ClosedPosition[]; count: number } {
  const root = isObj(data) ? data : {}
  const rows: ClosedPosition[] = []
  for (const row of list(root.positionList)) {
    const id = int(row.id)
    const contractId = int(row.contractId)
    if (id === null || contractId === null) continue
    const side = String(row.side ?? '').toUpperCase()
    const type = int(row.positionType)
    rows.push({
      id,
      contractId,
      side: side === 'BUY' || side === 'SELL' ? side : '',
      positionType: type === 1 || type === 2 ? type : null,
      leverageLevel: int(row.leverageLevel),
      volume: udec(row.volume) || udec(row.positionVolume),
      openPrice: udec(row.openPrice),
      closePrice: udec(row.closePrice),
      closeProfit: signedDec(row.closeProfit),
      tradeFee: signedDec(row.tradeFee),
      capitalFee: signedDec(row.capitalFee),
      shareAmount: signedDec(row.shareAmount),
      realized: signedDec(row.historyRealizedAmount),
      openedAt: int(row.ctime),
      closedAt: int(row.mtime),
    })
  }
  return { rows, count: int(root.count) ?? rows.length }
}

/**
 * 仓位历史 across contracts (Binance lists every symbol with a symbol filter). The vendor endpoint answers one contract
 * per call, so page `page` of the merged list is built from each contract's first `page × size` rows (the newest
 * `page × size` overall are always among them), newest close first; `count` is the sum of the per-contract counts.
 */
export function mergeClosedPositions(parts: ReadonlyArray<{ rows: ClosedPosition[]; count: number }>, page: number, size: number): { rows: ClosedPosition[]; count: number } {
  const all = parts.flatMap((part) => part.rows)
  all.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || b.id - a.id)
  const start = (Math.max(1, page) - 1) * size
  return { rows: all.slice(start, start + size), count: parts.reduce((sum, part) => sum + part.count, 0) }
}

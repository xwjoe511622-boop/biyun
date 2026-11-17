import type { SpotV3Order } from '@/modules/spot/spot-api'
import { isDecimalString, isPositive } from '@/modules/finance/decimal'
import { fillFromTotals, type FillSummary } from './quick-buy'

const STATUSES = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'] as const
export function isFinalQuickOrderStatus(status: string): boolean {
  return ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(status)
}
export interface QuickOrderSnapshot { status: string; fill: FillSummary | null }
/** Trust a server status for this exact order only. Fills/spend never infer a terminal state. */
export function quickOrderSnapshot(order: SpotV3Order | null, orderId: string, symbol: string): QuickOrderSnapshot | null {
  if (typeof order !== 'object' || order === null || String(order.orderId) !== orderId || order.symbol !== symbol.toUpperCase()) return null
  if (!STATUSES.some(status => status === order.status)) return null
  if (typeof order.executedQty !== 'string' || !isDecimalString(order.executedQty)
    || typeof order.cummulativeQuoteQty !== 'string' || !isDecimalString(order.cummulativeQuoteQty)) return null
  if (order.status === 'FILLED' && !isPositive(order.executedQty)) return null
  return { status: order.status, fill: isPositive(order.executedQty) ? fillFromTotals(order.executedQty, order.cummulativeQuoteQty) : null }
}

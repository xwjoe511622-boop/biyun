import type { OrderItem } from '@/modules/api/types'
import { formatCoinAmount } from '@/modules/wallet/valuation'

/** Market BUY is a quote-amount order; its returned volume is filled base quantity, not the submitted amount. */
export function orderAmountText(item: OrderItem, units: { base: string; quote: string; baseDp: number; quoteDp: number }): string {
  const quoteOrder = item.type === 2 && item.side.toUpperCase() === 'BUY'
  const value = quoteOrder ? item.total_price : item.volume
  const coin = quoteOrder ? units.quote : units.base
  const text = formatCoinAmount(value ?? '', quoteOrder ? units.quoteDp : units.baseDp)
  return text === '--' ? text : `${text} ${coin}`.trim()
}

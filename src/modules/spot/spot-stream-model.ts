import { utcTimestamp } from '@/core/swr'
import type { OrderItem } from '@/modules/api/types'
import { canonicalDecimal, div, isDecimalString } from '@/modules/finance/decimal'
import type { SpotV3Balance, SpotV3Order } from './spot-api'

/**
 * Binance spot shapes (`/api/v3` order objects, `executionReport`, `outboundAccountPosition`) → the classic spot
 * shapes the trade page renders (`OrderItem`, balance rows). Classic conventions kept: `type` 1 limit / 2 market,
 * `status` 0 INIT 1 NEW 2 FILLED 3 PART_FILLED 4 CANCELED 5 PENDING_CANCEL 6 EXPIRED, a market BUY's `volume` is the
 * quote amount (the core's `q` / `origQuoteOrderQty`).
 */

/** Classic symbol `btcusdt` → Binance `BTCUSDT`. */
export function v3Symbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

const STATUS: Record<string, number> = { NEW: 1, PARTIALLY_FILLED: 3, FILLED: 2, CANCELED: 4, PENDING_CANCEL: 5, EXPIRED: 6, REJECTED: 6, EXPIRED_IN_MATCH: 6 }

export function statusNumber(status: string): number {
  return STATUS[status.toUpperCase()] ?? 6
}

/** Open = can still fill and be cancelled. PENDING_CANCEL leaves 当前委托 at once (the cancel was accepted). */
export function isOpenStatus(status: number): boolean {
  return status === 0 || status === 1 || status === 3
}

function decimal(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  const canonical = canonicalDecimal(text)
  return isDecimalString(canonical) ? canonical : ''
}

function timeOf(ms: unknown): { created_at?: string; time_long?: number } {
  const n = typeof ms === 'number' ? ms : typeof ms === 'string' && /^\d+$/.test(ms) ? Number(ms) : NaN // float-ok: epoch timestamp
  return Number.isFinite(n) && n > 0 ? { created_at: utcTimestamp(new Date(n)), time_long: n } : {}
}

export interface SpotOrderRow extends OrderItem {
  /** Binance symbol (`BTCUSDT`). */
  v3Symbol: string
  clientOrderId?: string
  timeInForce?: string
}

/** True for a margin (lever) order when the gateway says so (`orderType` 2); such rows never enter spot lists. */
export function isMarginOrder(value: { orderType?: unknown }): boolean {
  return value.orderType === 2 || value.orderType === '2'
}

/** `/api/v3` order object → classic row. */
export function orderFromV3(order: SpotV3Order): SpotOrderRow {
  const market = order.type.toUpperCase() === 'MARKET'
  const buy = order.side.toUpperCase() === 'BUY'
  const quote = decimal(order.origQuoteOrderQty)
  const volume = market && buy && quote !== '' && quote !== '0' ? quote : decimal(order.origQty)
  const dealt = decimal(order.executedQty)
  const money = decimal(order.cummulativeQuoteQty)
  return {
    id: String(order.orderId),
    v3Symbol: order.symbol.toUpperCase(),
    side: buy ? 'BUY' : 'SELL',
    type: market ? 2 : 1,
    status: statusNumber(order.status),
    price: market ? '' : decimal(order.price),
    volume,
    deal_volume: dealt === '' ? '0' : dealt,
    deal_money: money === '' ? '0' : money,
    avg_price: dealt !== '' && dealt !== '0' && money !== '' ? canonicalDecimal(div(money, dealt)) : '',
    clientOrderId: order.clientOrderId,
    timeInForce: order.timeInForce,
    ...timeOf(order.time),
  }
}

export interface ExecutionReport {
  e: 'executionReport'
  E?: number
  s: string
  c?: string
  S: string
  o: string
  f?: string
  q: string
  p: string
  x: string
  X: string
  i: string | number
  l?: string
  z: string
  L?: string
  n?: string
  N?: string | null
  T?: number
  t?: string | number
  O?: number
  Z?: string
  orderType?: number
}

/** `executionReport` → classic row (the order's state after this event). */
export function orderFromEvent(event: ExecutionReport): SpotOrderRow {
  const market = String(event.o).toUpperCase() === 'MARKET'
  const dealt = decimal(event.z)
  const money = decimal(event.Z)
  return {
    id: String(event.i),
    v3Symbol: String(event.s).toUpperCase(),
    side: String(event.S).toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    type: market ? 2 : 1,
    status: statusNumber(String(event.X)),
    price: market ? '' : decimal(event.p),
    volume: decimal(event.q),
    deal_volume: dealt === '' ? '0' : dealt,
    deal_money: money === '' ? '0' : money,
    avg_price: dealt !== '' && dealt !== '0' && money !== '' ? canonicalDecimal(div(money, dealt)) : '',
    clientOrderId: typeof event.c === 'string' ? event.c : undefined,
    timeInForce: typeof event.f === 'string' ? event.f : undefined,
    ...timeOf(event.O),
  }
}

/** Newest first (the classic 当前委托 order); same millisecond → larger id first. */
export function compareOpenRows(left: OrderItem, right: OrderItem): number {
  const lt = left.time_long ?? 0
  const rt = right.time_long ?? 0
  if (lt !== rt) return rt - lt
  if (left.id.length !== right.id.length) return right.id.length - left.id.length
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0
}

export interface SpotFillNotice {
  orderId: string
  v3Symbol: string
  side: 'BUY' | 'SELL'
  market: boolean
  /** Cumulative filled base quantity. */
  filled: string
  /** Average fill price (`Z / z`), '' when unknown. */
  avgPrice: string
  complete: boolean
}

/** A `TRADE` execution → fill notice; null for every other event. */
export function fillNotice(event: ExecutionReport): SpotFillNotice | null {
  if (String(event.x).toUpperCase() !== 'TRADE') return null
  const row = orderFromEvent(event)
  if (row.deal_volume === '0' || row.deal_volume === '') return null
  return {
    orderId: row.id,
    v3Symbol: row.v3Symbol,
    side: row.side as 'BUY' | 'SELL',
    market: row.type === 2,
    filled: row.deal_volume ?? '',
    avgPrice: row.avg_price ?? '',
    complete: row.status === 2,
  }
}

export interface BalanceUpdate {
  asset: string
  free: string
  locked: string
}

/** `outboundAccountPosition.B` (`{a,f,l}`) or `/api/v3/account.balances` → balance rows (asset upper case). */
export function balanceUpdates(rows: unknown): BalanceUpdate[] {
  if (!Array.isArray(rows)) return []
  const out: BalanceUpdate[] = []
  for (const row of rows as Array<Record<string, unknown> | SpotV3Balance>) {
    const record = row as Record<string, unknown>
    const asset = String(record.a ?? record.asset ?? '').toUpperCase()
    const free = decimal(record.f ?? record.free)
    const locked = decimal(record.l ?? record.locked)
    if (asset === '' || asset.startsWith('COIN') || free === '' || locked === '') continue
    out.push({ asset, free, locked })
  }
  return out
}

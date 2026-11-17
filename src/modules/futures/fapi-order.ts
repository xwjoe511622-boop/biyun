import { Decimal } from '@/modules/finance/decimal'
import type { CreateOrderPayload } from './api'
import type { FuturesContract } from './contracts'
import { fapiRequest } from './fapi'
import { fapiSymbol } from './stream-model'

/**
 * Binance-style order entry (`/futures-api/fapi/v1/order`, fgw 0.4.0, 2026-10-01): the panel's `CreateOrderPayload`
 * (contracts, legacy type codes) → Binance parameters (symbol `BTCUSDT`, `positionSide`, `type` + `timeInForce`,
 * `quantity` in COIN). The server answers `-4000` for what must stay on the classic `order/order_create` path
 * (copy-trading lead traders, followers' closes); conditional / TP-SL orders are never sent here (`fapiOrderParams`
 * returns null). A user's first order on a new symbol is moved to the classic path by the server itself (`NEED_JAVA`).
 *
 * Hedge mode only (the server is DOUBLE; the panel's One-way mode is emulated on top of it, see `position-mode.ts`).
 * MARKET = IOC at mark ± the market take bound (server side); the fill arrives on the user stream.
 */

/**
 * Build-time switch `VITE_FUTURES_FAPI_ORDERS` ('0' / 'false' / 'off' → classic only). Default on in the app; off under
 * vitest so the classic-path suites keep testing the fallback (`setFapiOrdersEnabled` turns it on in a test).
 */
let fapiOrders: boolean = (() => {
  const raw = import.meta.env.VITE_FUTURES_FAPI_ORDERS
  if (typeof raw === 'string' && ['0', 'false', 'off'].includes(raw.trim().toLowerCase())) return false
  return import.meta.env.MODE !== 'test'
})()

export function fapiOrdersEnabled(): boolean {
  return fapiOrders
}

/** Tests / emergency switch. */
export function setFapiOrdersEnabled(on: boolean): void {
  fapiOrders = on
}

/** Order requests wait as long as the classic path (15 s, "result unconfirmed" after that). */
export const FAPI_ORDER_TIMEOUT_MS = 15_000

/** `-4000`: this account / order must use the classic entry. */
export const FAPI_CODE_USE_CLASSIC = '-4000'

export interface FapiOrderContext {
  contract: FuturesContract
  /**
   * Market OPEN sized by value (USDT): the opposite book (contracts) and a fallback price convert the value into whole
   * contracts the way the classic server spends it (sweep the book until the value is used up).
   */
  levels?: ReadonlyArray<{ price: string; amount: string }>
  fallbackPrice?: string
}

const DEC = /^\d+(\.\d+)?$/

function dec(value: string | undefined): Decimal | null {
  const text = (value ?? '').trim()
  return DEC.test(text) ? new Decimal(text) : null
}

/**
 * Whole contracts a market OPEN of `value` (margin coin) buys: walk the opposite book, each level costing
 * `price × amount × multiplier`; what the book does not cover is priced at the fallback (the worse of the last level and
 * the fallback). Rounded down. `''` when nothing is affordable or inputs are missing.
 */
export function contractsForValue(input: { side: 'BUY' | 'SELL'; value: string; multiplier: string; levels: ReadonlyArray<{ price: string; amount: string }>; fallbackPrice: string }): string {
  const budget = dec(input.value)
  const multiplier = dec(input.multiplier)
  const fallback = dec(input.fallbackPrice)
  if (budget === null || multiplier === null || budget.lte(0) || multiplier.lte(0)) return ''
  const buy = input.side === 'BUY'
  const levels = input.levels
    .map((level) => ({ price: dec(level.price), amount: dec(level.amount) }))
    .filter((level): level is { price: Decimal; amount: Decimal } => level.price !== null && level.amount !== null && level.price.gt(0) && level.amount.gt(0))
    .sort((a, b) => (buy ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)))
  let left = budget
  let contracts = new Decimal(0)
  let edge: Decimal | null = null
  for (const level of levels) {
    const unit = level.price.times(multiplier)
    const affordable = Decimal.min(level.amount, left.dividedBy(unit).floor())
    contracts = contracts.plus(affordable)
    left = left.minus(affordable.times(unit))
    edge = level.price
    if (affordable.lt(level.amount)) {
      left = new Decimal(0)
      break
    }
  }
  if (left.gt(0)) {
    const worse = edge === null ? fallback : fallback === null ? edge : buy ? Decimal.max(edge, fallback) : Decimal.min(edge, fallback)
    if (worse !== null && worse.gt(0)) contracts = contracts.plus(left.dividedBy(worse.times(multiplier)).floor())
  }
  return contracts.gt(0) ? contracts.toFixed(0) : ''
}

let clientSeq = 0
/** `web` + time + counter + random (≤ 32 chars, `[A-Za-z0-9._:/-]`); lets a timed-out order be found again. */
export function newClientOrderId(now = Date.now()): string {
  clientSeq = (clientSeq + 1) % 1296
  const random = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0')
  return `web${now.toString(36)}${clientSeq.toString(36).padStart(2, '0')}${random}`
}

export type FapiOrderParams = Record<string, string>

/**
 * `/fapi/v1/order` parameters for a classic payload, or null when the order must use another entry (conditional:
 * `fapi-conditional.ts`; unknown type, a market open whose value cannot be turned into contracts: classic). Attached
 * TP/SL become `tpStopPrice` / `slStopPrice` (+ `tpslWorkingType`) on the entry (OTO, fgw 0.6.12).
 * `payload.contracts` (exact contracts of a market OPEN, when the ticket knows them) wins over the value.
 */
export function fapiOrderParams(payload: CreateOrderPayload, context: FapiOrderContext, clientId = newClientOrderId()): FapiOrderParams | null {
  if (payload.isConditionOrder) return null
  const { contract } = context
  const multiplier = dec(contract.multiplier)
  if (multiplier === null || multiplier.lte(0)) return null
  const long = (payload.open === 'OPEN') === (payload.side === 'BUY')
  let contracts: string
  if (payload.type === 2 && payload.open === 'OPEN') {
    const exact = dec(payload.contracts)
    contracts = exact !== null && exact.gt(0) && exact.isInteger()
      ? exact.toFixed(0)
      : contractsForValue({ side: payload.side, value: payload.volume, multiplier: contract.multiplier, levels: context.levels ?? [], fallbackPrice: context.fallbackPrice ?? '' })
  } else {
    const volume = dec(payload.volume)
    contracts = volume !== null && volume.gt(0) && volume.isInteger() ? volume.toFixed(0) : ''
  }
  if (contracts === '') return null
  const params: FapiOrderParams = {
    symbol: fapiSymbol(contract),
    side: payload.side,
    positionSide: long ? 'LONG' : 'SHORT',
    quantity: new Decimal(contracts).times(multiplier).toFixed(),
    newClientOrderId: clientId,
  }
  const tif: Record<number, string> = { 1: 'GTC', 3: 'IOC', 4: 'FOK', 5: 'GTX' }
  if (payload.type === 2) {
    params.type = 'MARKET'
  } else if (tif[payload.type] !== undefined && dec(payload.price) !== null) {
    params.type = 'LIMIT'
    params.timeInForce = tif[payload.type] as string
    params.price = payload.price
  } else {
    return null
  }
  // Attached TP/SL (OTO, fgw 0.6.12): legs armed by the core once the entry fills; market legs unless a price is given.
  const tpsl = payload.tpsl
  if (tpsl !== undefined && payload.open === 'OPEN') {
    const tp = (tpsl.takerProfitTrigger ?? '').trim()
    const sl = (tpsl.stopLossTrigger ?? '').trim()
    if (tp !== '') {
      params.tpStopPrice = tp
      if ((tpsl.takerProfitPrice ?? '') !== '') { params.tpOrderType = 'TAKE_PROFIT'; params.tpPrice = tpsl.takerProfitPrice as string }
    }
    if (sl !== '') {
      params.slStopPrice = sl
      if ((tpsl.stopLossPrice ?? '') !== '') { params.slOrderType = 'STOP'; params.slPrice = tpsl.stopLossPrice as string }
    }
    if (tp !== '' || sl !== '') params.tpslWorkingType = payload.tpslWorkingType ?? 'CONTRACT_PRICE'
  }
  return params
}

/** One attached TP/SL leg in the order reply: a conditional (`otoPending`) or `{leg, status: REJECTED, code, msg}`. */
export interface FapiAttachedOrder {
  leg?: string
  status?: string
  code?: number | string
  msg?: string
  orderId?: string | number
  type?: string
}

interface FapiOrderReply {
  orderId?: string | number
  clientOrderId?: string
  status?: string
  attachedOrders?: FapiAttachedOrder[]
}

/** Attached legs the server refused (the entry itself WAS placed). */
export function rejectedLegs(reply: { attachedOrders?: FapiAttachedOrder[] } | null | undefined): FapiAttachedOrder[] {
  return (reply?.attachedOrders ?? []).filter((leg) => String(leg.status ?? '').toUpperCase() === 'REJECTED')
}

/** Refused legs of the last order this tab placed (read by the account store right after `placeFapiOrder`). */
let lastRejected: FapiAttachedOrder[] = []
export function takeRejectedLegs(): FapiAttachedOrder[] {
  const legs = lastRejected
  lastRejected = []
  return legs
}

/** `POST /fapi/v1/order` → the new order id (lossless string). */
export async function placeFapiOrder(params: FapiOrderParams): Promise<string[]> {
  lastRejected = []
  const reply = await fapiRequest<FapiOrderReply>('POST', 'fapi/v1/order', { params, timeoutMs: FAPI_ORDER_TIMEOUT_MS })
  lastRejected = rejectedLegs(reply)
  const id = reply?.orderId
  return id === undefined || id === null || String(id) === '0' ? [] : [String(id)]
}

/** `POST /fapi/v1/order/test`: every check, nothing placed. */
export async function testFapiOrder(params: FapiOrderParams): Promise<void> {
  await fapiRequest<unknown>('POST', 'fapi/v1/order/test', { params })
}

/** `DELETE /fapi/v1/order` (one open order). */
export async function cancelFapiOrder(contract: FuturesContract, orderId: string): Promise<void> {
  await fapiRequest<unknown>('DELETE', 'fapi/v1/order', { params: { symbol: fapiSymbol(contract), orderId } })
}

/** `DELETE /fapi/v1/allOpenOrders` (every open order of the symbol; conditional orders are not included). */
export async function cancelAllFapiOrders(contract: FuturesContract): Promise<void> {
  await fapiRequest<unknown>('DELETE', 'fapi/v1/allOpenOrders', { params: { symbol: fapiSymbol(contract) } })
}

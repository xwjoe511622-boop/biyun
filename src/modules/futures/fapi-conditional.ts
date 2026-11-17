import { Decimal } from '@/modules/finance/decimal'
import type { CreateOrderPayload } from './api'
import type { FuturesContract } from './contracts'
import type { FapiOpenOrder } from './fapi'
import { newClientOrderId, type FapiOrderParams } from './fapi-order'
import { coinToContracts, contractsToCoin, fapiSymbol, openKindOf } from './stream-model'
import type { FuturesPosition, FuturesTriggerOrder, TpslRow } from './types'

/**
 * Binance conditional orders on `/fapi/v1/order` (fgw 0.6.9+, core trigger engine since 10-02 08:12; runbook
 * futures-gw §1.4, design docs/04-design/rust-trigger-plan.md):
 *   STOP / TAKE_PROFIT (limit once triggered: `price`, `stopPrice`, GTC) and STOP_MARKET / TAKE_PROFIT_MARKET
 *   (`stopPrice` only), `workingType` MARK_PRICE | CONTRACT_PRICE (last trade), `closePosition=true` = the whole
 *   position (close direction, no `quantity`). Ids are 8e18 + trigger row id (normal orders are < 4.7e18).
 * Trigger direction (Binance): BUY STOP fires at price ≥ stopPrice, SELL STOP at ≤; TAKE_PROFIT the opposite.
 */

export type WorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE'
export const WORKING_TYPES: readonly WorkingType[] = ['CONTRACT_PRICE', 'MARK_PRICE']
const CONDITIONAL_TYPES = new Set(['STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'])
const ID_BASE = 8_000_000_000_000_000_000n

const DEC = /^\d+(\.\d+)?$/

export function isConditionalType(type: unknown): boolean {
  return CONDITIONAL_TYPES.has(String(type ?? '').toUpperCase())
}

/** Conditional order id (≥ 8e18) — also recognised without the row. */
export function isConditionalId(id: string): boolean {
  return /^\d{19,}$/.test(id) && BigInt(id) >= ID_BASE
}

/** An `/fapi` open order that is a waiting conditional (by type, or by id range). */
export function isConditionalOrder(order: Pick<FapiOpenOrder, 'type' | 'origType' | 'orderId'>): boolean {
  return isConditionalType(order.origType ?? order.type) || isConditionalType(order.type) || isConditionalId(String(order.orderId))
}

/** Direction a STOP / TAKE_PROFIT of `side` fires in. */
export function directionOf(type: string, side: string): 'up' | 'down' {
  const stop = type.toUpperCase().startsWith('STOP')
  const buy = side.toUpperCase() === 'BUY'
  return stop === buy ? 'up' : 'down'
}

/**
 * The Binance type for a trigger at `stopPrice` relative to the watched price `reference`: the order fires when the
 * price moves TO the trigger, so a trigger above the reference fires upward (BUY → STOP, SELL → TAKE_PROFIT) and one
 * below fires downward (BUY → TAKE_PROFIT, SELL → STOP). null when the reference is unknown or equal (it would fire
 * at once: the server answers -2021).
 */
export function conditionalType(side: 'BUY' | 'SELL', stopPrice: string, reference: string, market: boolean): string | null {
  if (!DEC.test(stopPrice) || !DEC.test(reference) || Number(reference) <= 0) return null // float-ok: "> 0" check on a validated decimal string, boolean only
  const stop = new Decimal(stopPrice)
  const ref = new Decimal(reference)
  if (stop.eq(ref)) return null
  const up = stop.gt(ref)
  const base = (side === 'BUY') === up ? 'STOP' : 'TAKE_PROFIT'
  return market ? `${base}_MARKET` : base
}

/**
 * 条件委托 from the order panel → `/fapi/v1/order` parameters, or null when it cannot be expressed (then the classic
 * entry). Market OPEN by value (USDT): whole contracts the value buys at the trigger price (rounded down), unless the
 * ticket knows the exact contracts.
 */
export function conditionalOrderParams(
  payload: CreateOrderPayload,
  context: { contract: FuturesContract; workingType: WorkingType; reference: string },
  clientId = newClientOrderId(),
): FapiOrderParams | null {
  const { contract } = context
  const stopPrice = (payload.triggerPrice ?? '').trim()
  if (!payload.isConditionOrder || !DEC.test(stopPrice) || !DEC.test(contract.multiplier) || Number(contract.multiplier) <= 0) return null // float-ok: "> 0" check on a validated decimal string, boolean only
  const market = payload.type === 2
  const type = conditionalType(payload.side, stopPrice, context.reference, market)
  if (type === null) return null
  let contracts = ''
  if (market && payload.open === 'OPEN') {
    const exact = (payload.contracts ?? '').trim()
    if (DEC.test(exact) && Number(exact) > 0 && new Decimal(exact).isInteger()) contracts = new Decimal(exact).toFixed(0) // float-ok: "> 0" check on a validated decimal string, boolean only; maths is Decimal
    else if (DEC.test(payload.volume) && Number(stopPrice) > 0) contracts = new Decimal(payload.volume).dividedBy(new Decimal(stopPrice).times(contract.multiplier)).floor().toFixed(0) // float-ok: "> 0" check on a validated decimal string, boolean only; maths is Decimal
  } else if (DEC.test(payload.volume) && new Decimal(payload.volume).isInteger()) {
    contracts = new Decimal(payload.volume).toFixed(0)
  }
  if (contracts === '' || Number(contracts) <= 0) return null // float-ok: "<= 0" check on a whole-contract string, boolean only
  const long = (payload.open === 'OPEN') === (payload.side === 'BUY')
  const params: FapiOrderParams = {
    symbol: fapiSymbol(contract),
    side: payload.side,
    positionSide: long ? 'LONG' : 'SHORT',
    type,
    stopPrice,
    workingType: context.workingType,
    quantity: new Decimal(contracts).times(contract.multiplier).toFixed(),
    newClientOrderId: clientId,
  }
  if (!market) {
    if (!DEC.test(payload.price)) return null
    params.price = payload.price
    params.timeInForce = 'GTC'
  }
  return params
}

/**
 * One TP or SL leg of a position (Binance 「止盈止损」): a *_MARKET close order in the close direction. `closePosition`
 * (entire position, Binance default) sends no quantity — the core closes whatever is held when it fires.
 */
export function tpslLegParams(input: {
  contract: FuturesContract
  positionSide: 'BUY' | 'SELL'
  kind: 'tp' | 'sl'
  stopPrice: string
  workingType: WorkingType
  closePosition: boolean
  contracts: string
}, clientId = newClientOrderId()): FapiOrderParams {
  const long = input.positionSide === 'BUY'
  const params: FapiOrderParams = {
    symbol: fapiSymbol(input.contract),
    side: long ? 'SELL' : 'BUY',
    positionSide: long ? 'LONG' : 'SHORT',
    type: input.kind === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
    stopPrice: input.stopPrice,
    workingType: input.workingType,
    newClientOrderId: clientId,
  }
  if (input.closePosition) params.closePosition = 'true'
  else params.quantity = contractsToCoin(input.contracts, input.contract.multiplier)
  return params
}

function udecText(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return DEC.test(text) && Number(text) > 0 ? text : '' // float-ok: "> 0" check on a validated decimal string, boolean only
}

/** `/fapi` conditional → the 条件委托 row (classic `FuturesTriggerOrder` shape + workingType / direction). */
export function triggerOrderFromFapi(order: FapiOpenOrder, contract: FuturesContract): FuturesTriggerOrder {
  const type = String(order.origType ?? order.type).toUpperCase()
  const side = String(order.side).toUpperCase() === 'BUY' ? 'BUY' : 'SELL'
  const open = openKindOf(order.side, order.positionSide, order.reduceOnly)
  const direction = directionOf(type, side)
  const market = type.endsWith('_MARKET')
  const takeProfit = type.startsWith('TAKE_PROFIT')
  const quote = udecText(order.origQuoteQty)
  const qty = udecText(order.origQty)
  // classic triggerType: 1 SL, 2 TP (closing); 3 breakout (up) / 4 breakdown (down) when opening
  const triggerType = open === 'CLOSE' ? (takeProfit ? 2 : 1) : direction === 'up' ? 3 : 4
  const time = Number(order.time ?? 0) > 0 ? Number(order.time) : Number(order.updateTime ?? 0) > 0 ? Number(order.updateTime) : null // float-ok: epoch timestamp
  return {
    id: String(order.orderId),
    contractId: contract.id,
    contractName: contract.contractName,
    side,
    open,
    type: market ? 2 : 1,
    triggerType,
    triggerPrice: udecText(order.stopPrice),
    price: market ? '' : udecText(order.price),
    // vendor web market OPEN conditionals carry the USDT amount (classic meaning of `volume` for a market open)
    volume: qty !== '' ? coinToContracts(qty, contract.multiplier) : quote,
    status: 0,
    memo: '',
    expireTime: null,
    ctime: time,
    mtime: null,
    workingType: String(order.workingType ?? '').toUpperCase() === 'MARK_PRICE' ? 'MARK_PRICE' : 'CONTRACT_PRICE',
    closePosition: order.closePosition === true,
    volumeIsContracts: qty !== '',
    direction,
  }
}

/** Newest first; same time → larger id first (ids grow with the trigger row). */
export function compareTriggerRows(a: FuturesTriggerOrder, b: FuturesTriggerOrder): number {
  const time = (b.ctime ?? 0) - (a.ctime ?? 0)
  if (time !== 0) return time
  if (a.id.length !== b.id.length) return b.id.length - a.id.length
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** TP / SL rows of one position (closing conditionals on its contract and side), in the TP/SL dialog's row shape. */
export function positionTpslRows(rows: readonly FuturesTriggerOrder[], position: Pick<FuturesPosition, 'contractId' | 'orderSide' | 'canCloseVolume' | 'positionVolume'>): { takeProfit: TpslRow[]; stopLoss: TpslRow[] } {
  const closeSide = position.orderSide === 'BUY' ? 'SELL' : 'BUY'
  const mine = rows.filter((row) => row.contractId === position.contractId && row.open === 'CLOSE' && row.side === closeSide)
  const toRow = (row: FuturesTriggerOrder): TpslRow => ({
    id: row.id,
    triggerPrice: row.triggerPrice,
    price: row.price,
    // closePosition legs cover whatever is held
    volume: row.closePosition === true ? (position.positionVolume || position.canCloseVolume) : row.volume,
    status: 0,
  })
  return { takeProfit: mine.filter((row) => row.triggerType === 2).map(toRow), stopLoss: mine.filter((row) => row.triggerType === 1).map(toRow) }
}

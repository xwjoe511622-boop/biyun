import { readCache, writeCache, type CacheHit } from '@/core/session-cache'
import { canonicalDecimal, isDecimalString, lt } from '@/modules/finance/decimal'
import { request, requestLanguage, requestWithRetry, type RetryPolicy } from '@/modules/api/http'
import { FUTURES_ENDPOINTS as E, SPOT_CONTRACT_ENDPOINTS } from './endpoints'
import { normalizeLadder, type LadderTier } from './liq-estimate'
import { normalizeLeverTiers, type LeverTier } from './lever-tiers'
import { normalizeClosedPositions, type ClosedPosition } from './position-history'
import {
  normalizeAssets,
  normalizeFeeRows,
  normalizeFundingRateList,
  normalizeMarketInfo,
  normalizeOrders,
  normalizePublicInfo,
  normalizeTpsl,
  normalizeTrades,
  normalizeTransactions,
  normalizeTriggerOrders,
  normalizeUserConfig,
  type FeeRow,
  type FundingRateList,
  type FuturesAssets,
  type FuturesMarketInfo,
  type FuturesOrder,
  type FuturesPublicInfo,
  type FuturesTrade,
  type FuturesTransaction,
  type FuturesTriggerOrder,
  type FuturesUserConfig,
} from './types'

/**
 * futures-web-api client. Every call uses the `futures` namespace, which never clears the spot
 * session on a rejection. Most controllers bind `@RequestBody Map<String, String>`, so scalar
 * values are sent as strings; the typed-POJO endpoints (`order_tpsl_create`, `light_close`) get
 * JSON numbers where the VO field is numeric.
 */

type Params = Record<string, string>

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { api: 'futures', body })
}

/* ------------------------------------------------------------------ public */

/** A cached contract list older than this is not used at all. */
export const FUTURES_PUBLIC_INFO_CACHE_MAX_AGE_MS = 10 * 60_000
/** A cached contract list younger than this is used without a background revalidation. */
export const FUTURES_PUBLIC_INFO_FRESH_MS = 60_000

function publicInfoCacheName(): string {
  return `futures_public_info.${requestLanguage()}`
}

/**
 * Contract list + market socket URL. Idempotent, so transport failures (timeout, 502, offline) are
 * retried with backoff instead of blanking the terminal; the raw payload is cached per language in
 * `sessionStorage` and re-normalized on read.
 */
export async function fetchFuturesPublicInfo(policy?: RetryPolicy): Promise<FuturesPublicInfo> {
  const raw = await requestWithRetry<unknown>(E.publicInfo, { api: 'futures', body: {}, timeoutMs: 12_000 }, policy)
  const info = normalizePublicInfo(raw)
  if (info.contractList.length > 0) writeCache(publicInfoCacheName(), raw)
  return info
}

/** Cached contract list; `currentTimeMillis` is dropped because a cached clock is stale. */
export function readCachedFuturesPublicInfo(): CacheHit<FuturesPublicInfo> | null {
  return readCache(publicInfoCacheName(), FUTURES_PUBLIC_INFO_CACHE_MAX_AGE_MS, (data) => {
    const info = normalizePublicInfo(data)
    return info.contractList.length > 0 ? { ...info, currentTimeMillis: null } : null
  })
}

export async function fetchPublicMarketInfo(contractId: number): Promise<FuturesMarketInfo> {
  return normalizeMarketInfo(await post<unknown>(E.publicMarketInfo, { contractId: String(contractId) }))
}

export async function fetchFundingRateList(contractId: number, page = 1, limit = 20): Promise<FundingRateList> {
  return normalizeFundingRateList(await post<unknown>(E.fundingRateList, {
    contractId: String(contractId), page: String(page), limit: String(limit),
  }))
}

/** `common/get_ladder_info` of a contract, cached per contract for the page's lifetime (static config). */
const ladderCache = new Map<number, Promise<unknown>>()
function fetchLadderInfo(contractId: number): Promise<unknown> {
  let hit = ladderCache.get(contractId)
  if (hit === undefined) {
    hit = post<unknown>(E.ladderInfo, { contractId: String(contractId) })
    hit.catch(() => { ladderCache.delete(contractId) })
    ladderCache.set(contractId, hit)
  }
  return hit
}

/** Tests: forget cached ladder answers. */
export function resetLadderCache(): void {
  ladderCache.clear()
}

/** Maintenance-margin tiers of a contract. */
export function fetchLadder(contractId: number): Promise<LadderTier[]> {
  return fetchLadderInfo(contractId).then(normalizeLadder)
}

/** Leverage tiers (largest position value per leverage) of a contract, same answer as `fetchLadder`. */
export function fetchLeverTiers(contractId: number): Promise<LeverTier[]> {
  return fetchLadderInfo(contractId).then(normalizeLeverTiers)
}

/** 仓位历史: closed positions of one contract (`position/history_position_list`, status Unwind), newest first. */
export async function fetchPositionHistory(contractId: number, page: number, limit: number): Promise<{ rows: ClosedPosition[]; count: number }> {
  return normalizeClosedPositions(await post<unknown>(E.historyPositionList, { contractId: String(contractId), page: String(page), limit: String(limit) }))
}

export async function fetchFeeRows(): Promise<FeeRow[]> {
  return normalizeFeeRows(await request<unknown>(E.makerTaker, { api: 'futures', method: 'GET' }))
}

/* ------------------------------------------------------------------ user */

export async function fetchUserConfig(contractId: number): Promise<FuturesUserConfig> {
  return normalizeUserConfig(await post<unknown>(E.userConfig, { contractId: String(contractId) }))
}

export async function openFuturesAccount(): Promise<void> {
  await post<unknown>(E.createCoId, {})
}

/**
 * `user/level_edit`. Since the 2026-09-29 backend guards (`levguard-20260929`) the server itself moves the missing
 * isolated margin from 可用 in the same transaction and answers `data.isolatedTopUps` on success; an older server
 * answers no data and only relabels isolated positions (the caller then adds the margin itself).
 */
export async function editLeverage(contractId: number, nowLevel: number): Promise<{ serverTopUp: boolean }> {
  const data = await post<unknown>(E.levelEdit, { contractId: String(contractId), nowLevel: String(nowLevel) })
  const topUps = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).isolatedTopUps : undefined
  return { serverTopUp: Array.isArray(topUps) }
}

/** `marginModel` 1 = cross, 2 = isolated (`PositionType`). */
export async function editMarginModel(contractId: number, marginModel: 1 | 2): Promise<void> {
  await post<unknown>(E.marginModelEdit, { contractId: String(contractId), marginModel: String(marginModel) })
}

/* ------------------------------------------------------------------ assets */

export async function fetchAssets(marginCoin?: string): Promise<FuturesAssets> {
  const body: Params = {}
  if (marginCoin !== undefined && marginCoin !== '') body.marginCoin = marginCoin
  return normalizeAssets(await post<unknown>(E.assetsList, body))
}

/** Positive `amount` adds isolated margin, negative removes it (`PositionController.java:123`). */
export async function changePositionMargin(positionId: number, amount: string): Promise<void> {
  await post<unknown>(E.changePositionMargin, { positionId: String(positionId), amount })
}

/* ------------------------------------------------------------------ orders */

export interface CreateOrderPayload {
  contractId: number
  positionType: 1 | 2
  side: 'BUY' | 'SELL'
  open: 'OPEN' | 'CLOSE'
  /** 1 limit, 2 market, 3 IOC, 4 FOK, 5 POST_ONLY. */
  type: 1 | 2 | 3 | 4 | 5
  /** Contracts; for a market OPEN it is the open value in the margin coin (legacy `tradeForm.js:1106-1120`). */
  volume: string
  price: string
  leverageLevel: number
  isConditionOrder: boolean
  /**
   * Market OPEN only: the exact contracts the ticket wants when it knows them (coin entry, 反手). `/fapi` order entry
   * sends this quantity; the classic path keeps sending `volume` (the value).
   */
  contracts?: string
  triggerPrice?: string
  /** 条件委托 on `/fapi`: the price the trigger watches (default CONTRACT_PRICE = last trade, the classic meaning). */
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  /** Attached TP/SL on `/fapi`: the price the legs watch (default CONTRACT_PRICE; classic OTO watches the last price). */
  tpslWorkingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  /** Optional OTO take-profit / stop-loss attached to an opening order. */
  tpsl?: {
    takerProfitTrigger?: string
    takerProfitPrice?: string
    stopLossTrigger?: string
    stopLossPrice?: string
  }
}

/** Serialises an order for `order/order_create` (`OrderCreateController.java:74-128`, `buildOrderParam`). */
export function orderCreateBody(payload: CreateOrderPayload): Params {
  const body: Params = {
    contractId: String(payload.contractId),
    positionType: String(payload.positionType),
    side: payload.side,
    open: payload.open,
    type: String(payload.type),
    volume: payload.volume,
    price: payload.price,
    leverageLevel: String(payload.leverageLevel),
    isConditionOrder: payload.isConditionOrder ? 'true' : 'false',
  }
  if (payload.isConditionOrder && payload.triggerPrice !== undefined) {
    body.triggerPrice = payload.triggerPrice
  }
  const tpsl = payload.tpsl
  if (tpsl !== undefined && ((tpsl.takerProfitTrigger ?? '') !== '' || (tpsl.stopLossTrigger ?? '') !== '')) {
    // OTO: TP/SL legs are placed as market-type (`type` 2) close triggers unless a price is given.
    body.isOto = 'true'
    if ((tpsl.takerProfitTrigger ?? '') !== '') {
      body.takerProfitTrigger = tpsl.takerProfitTrigger as string
      body.takerProfitPrice = tpsl.takerProfitPrice !== undefined && tpsl.takerProfitPrice !== '' ? tpsl.takerProfitPrice : '0'
      body.takerProfitType = tpsl.takerProfitPrice !== undefined && tpsl.takerProfitPrice !== '' ? '1' : '2'
    }
    if ((tpsl.stopLossTrigger ?? '') !== '') {
      body.stopLossTrigger = tpsl.stopLossTrigger as string
      body.stopLossPrice = tpsl.stopLossPrice !== undefined && tpsl.stopLossPrice !== '' ? tpsl.stopLossPrice : '0'
      body.stopLossType = tpsl.stopLossPrice !== undefined && tpsl.stopLossPrice !== '' ? '1' : '2'
    }
  }
  return body
}

/** Order entry used by composite actions (the account store routes them through `/fapi` first). */
export interface OrderOps {
  create?: (payload: CreateOrderPayload) => Promise<string[]>
  cancel?: (contractId: number, orderId: string) => Promise<void>
}

/** Resolves to the new order ids (`data.ids`, empty when the server does not return them). */
export async function createOrder(payload: CreateOrderPayload): Promise<string[]> {
  const data = await post<unknown>(E.orderCreate, orderCreateBody(payload))
  const ids = data !== null && typeof data === 'object' ? (data as { ids?: unknown }).ids : undefined
  return Array.isArray(ids) ? ids.map(String) : []
}

export async function cancelOrder(contractId: number, orderId: string, isConditionOrder: boolean): Promise<void> {
  await post<unknown>(E.orderCancel, { contractId: String(contractId), orderId, isConditionOrder: isConditionOrder ? 'true' : 'false' })
}

/**
 * Whole-position MARKET close (Binance: a market close always goes through). A real `type 2` CLOSE order for the whole
 * position; the position's own resting CLOSE orders are cancelled first when they hold part of it (what light_close did).
 * `wire` (from `marketCloseWire`) sends an IOC just inside the liquidation price when the guard's market edge is past it.
 * Not `light_close`: that sends a LIMIT at the 10th opposite level, which `ValidateServiceImpl.checkReducePrice` refuses
 * with 10058 / 10059 (and 10063 / 10064 in `lightningClose`) once that price is past the liquidation price — the
 * 2026-09-30 owner bug 「预计成交价格低于强平价格，无法下单」 on 市价. MARKET orders skip that check.
 */
/** `a < b` for two contract volumes as exact decimals; '' counts as 0, anything non-decimal compares false. */
export function volumeLess(a: string, b: string): boolean {
  const left = canonicalDecimal(a) || '0'
  const right = canonicalDecimal(b) || '0'
  return isDecimalString(left) && isDecimalString(right) && lt(left, right)
}

export async function marketClosePosition(position: {
  contractId: number
  orderSide: 'BUY' | 'SELL'
  positionType: 1 | 2
  positionVolume: string
  canCloseVolume: string
  leverageLevel: number | null
}, wire: { type: 2 | 3; price: string } = { type: 2, price: '' }, ops: OrderOps = {}): Promise<void> {
  const create = ops.create ?? createOrder
  const cancel = ops.cancel ?? ((contractId: number, orderId: string) => cancelOrder(contractId, orderId, false))
  const closeSide = position.orderSide === 'BUY' ? 'SELL' : 'BUY'
  if (volumeLess(position.canCloseVolume, position.positionVolume)) {
    const current = await fetchCurrentOrders({ contractId: position.contractId, page: 1, limit: 100 })
    const resting = current.rows.filter((order) => order.open === 'CLOSE' && order.side === closeSide
      && (order.positionType === null || order.positionType === position.positionType))
    for (const order of resting) await cancel(position.contractId, order.id)
  }
  await create({
    contractId: position.contractId, positionType: position.positionType, side: closeSide, open: 'CLOSE', type: wire.type,
    volume: position.positionVolume, price: wire.price, leverageLevel: position.leverageLevel ?? 1, isConditionOrder: false,
  })
}

/** 闪电平仓: a LIMIT at the opposite ten-level price (`CoOrderServiceImpl.lightningClose`). Not used for 市价 (see above). */
export async function lightClose(contractId: number, closeSide: 'BUY' | 'SELL', positionType: 1 | 2): Promise<void> {
  await post<unknown>(E.lightClose, { contractId, open: 'CLOSE', side: closeSide, positionType })
}

export interface TpslLeg {
  /** 2 take profit, 1 stop loss (`TriggerType`). */
  triggerType: 1 | 2
  triggerPrice: string
  /** `0` for a market leg. */
  price: string
  /** 1 limit, 2 market. */
  type: 1 | 2
  volume: string
}

/** `order/order_tpsl_create` body (`OrderProfitLossParam`, legacy `stopOrder.js:694-721`). */
export function tpslBody(input: {
  contractId: number
  positionId: number
  positionType: 1 | 2
  leverageLevel: number
  closeSide: 'BUY' | 'SELL'
  legs: TpslLeg[]
}): Record<string, unknown> {
  return {
    contractId: input.contractId,
    positionId: input.positionId,
    positionType: input.positionType,
    leverageLevel: input.leverageLevel,
    side: input.closeSide,
    orderList: input.legs.map((leg) => ({
      triggerType: leg.triggerType,
      triggerPrice: leg.triggerPrice,
      price: leg.price,
      type: leg.type,
      volume: leg.volume,
    })),
  }
}

export async function createTpsl(input: Parameters<typeof tpslBody>[0]): Promise<void> {
  await post<unknown>(E.tpslCreate, tpslBody(input))
}

/**
 * Cancels TP/SL orders. Since 2026-10-01 the server answers per id (`data {results:[{orderId, code, msg, reason?}],
 * succeeded, failed}`); code 0 only when every id was cancelled, otherwise it throws 10021 carrying the same data
 * (`tpslCancelOutcome(error)` lists the failed ids). Resolves to the raw success data (older servers: anything).
 */
export async function cancelTpsl(contractId: number, orderIds: string[]): Promise<unknown> {
  return post<unknown>(E.tpslCancel, { contractId: String(contractId), orderIds: orderIds.join(',') })
}

export async function fetchPositionTpsl(contractId: number, orderSide: 'BUY' | 'SELL'): Promise<ReturnType<typeof normalizeTpsl>> {
  return normalizeTpsl(await post<unknown>(E.takeProfitStopLoss, { contractId: String(contractId), orderSide }))
}

/* ------------------------------------------------------------------ lists */

export interface PageQuery {
  contractId: number
  page: number
  limit: number
  beginTime?: number
  endTime?: number
}

function pageBody(query: PageQuery): Params {
  const body: Params = { contractId: String(query.contractId), page: String(query.page), limit: String(query.limit) }
  if (query.beginTime !== undefined && query.endTime !== undefined) {
    body.beginTime = String(query.beginTime)
    body.endTime = String(query.endTime)
  }
  return body
}

export interface Paged<T> { rows: T[]; count: number }

export async function fetchCurrentOrders(query: PageQuery): Promise<Paged<FuturesOrder>> {
  return normalizeOrders(await post<unknown>(E.currentOrderList, pageBody(query)))
}

export async function fetchTriggerOrders(query: PageQuery): Promise<Paged<FuturesTriggerOrder>> {
  return normalizeTriggerOrders(await post<unknown>(E.triggerOrderList, pageBody(query)))
}

export async function fetchHistoryOrders(query: PageQuery): Promise<Paged<FuturesOrder>> {
  return normalizeOrders(await post<unknown>(E.historyOrderList, pageBody(query)))
}

export async function fetchHistoryTriggerOrders(query: PageQuery): Promise<Paged<FuturesTriggerOrder>> {
  return normalizeTriggerOrders(await post<unknown>(E.historyTriggerOrderList, pageBody(query)))
}

export async function fetchTradeHistory(query: PageQuery): Promise<Paged<FuturesTrade>> {
  return normalizeTrades(await post<unknown>(E.hisTradeList, pageBody(query)), 'tradeHisList')
}

/** `symbol` is the margin coin (flow records are per margin account). */
export async function fetchTransactions(query: { symbol: string; page: number; limit: number; type?: string }): Promise<Paged<FuturesTransaction>> {
  const body: Params = { symbol: query.symbol, page: String(query.page), limit: String(query.limit) }
  if (query.type !== undefined && query.type !== '') body.type = query.type
  return normalizeTransactions(await post<unknown>(E.transactionList, body))
}

/* ------------------------------------------------------------------ transfer (spot web-api) */

export type TransferDirection = 'wallet_to_contract' | 'contract_to_wallet'

/** `ContractAct.java:102-130`: amount must be > 0; `coinSymbol` is the margin coin. */
export async function transferFunds(direction: TransferDirection, amount: string, coinSymbol: string): Promise<void> {
  await request<unknown>(SPOT_CONTRACT_ENDPOINTS.coTransfer, { body: { transferType: direction, amount, coinSymbol } })
}

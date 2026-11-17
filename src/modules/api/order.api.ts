import { ENDPOINTS } from '@/config/endpoints'
import { request } from './http'
import type {
  CancelOrderRequest,
  HistoryOrderListRequest,
  OrderCreateRequest,
  OrderListData,
  OrderListRequest,
  TradeListData,
} from './types'

/**
 * `POST /order/create`.
 * `volume` is a decimal string: base amount for limit orders and market sells,
 * quote amount (USDT) for market buys.
 */
export function createOrder(payload: OrderCreateRequest): Promise<unknown> {
  const body: Record<string, string> = {
    symbol: payload.symbol,
    side: payload.side,
    type: payload.type,
    volume: payload.volume,
  }
  if (payload.price !== undefined && payload.price !== '') {
    body.price = payload.price
  }
  return request<unknown>(ENDPOINTS.createOrder, { body })
}

/** `POST /order/cancel` — requires `orderId` and the lowercase pair. */
export function cancelOrder(payload: CancelOrderRequest): Promise<unknown> {
  return request<unknown>(ENDPOINTS.cancelOrder, {
    body: { orderId: payload.orderId, symbol: payload.symbol },
  })
}

/** `POST /order/list/new` — open orders. `symbol` is mandatory on the server. */
export function fetchOpenOrders(payload: OrderListRequest): Promise<OrderListData> {
  const body: Record<string, string | number> = {
    symbol: payload.symbol,
    page: payload.page,
    pageSize: payload.pageSize,
  }
  if (payload.side !== undefined && payload.side !== '') {
    body.side = payload.side
  }
  return request<OrderListData>(ENDPOINTS.openOrders, { body })
}

/** `POST /order/entrust_history` — filled/cancelled orders. */
export function fetchHistoryOrders(payload: HistoryOrderListRequest): Promise<OrderListData> {
  const body: Record<string, string | number> = {
    symbol: payload.symbol,
    page: payload.page,
    pageSize: payload.pageSize,
    isShowCanceled: payload.isShowCanceled ?? 1,
  }
  if (payload.side !== undefined && payload.side !== '') {
    body.side = payload.side
  }
  return request<OrderListData>(ENDPOINTS.historyOrders, { body })
}

/** `POST /trade/list` — my fills for one pair. */
export function fetchMyTrades(payload: OrderListRequest): Promise<TradeListData> {
  return request<TradeListData>(ENDPOINTS.myTrades, {
    body: { symbol: payload.symbol, page: payload.page, pageSize: payload.pageSize },
  })
}

/** `POST /trade/list_by_order` — fills of a single order. */
export function fetchTradesByOrder(
  symbol: string,
  orderId: string,
  page = 1,
  pageSize = 20,
): Promise<TradeListData> {
  return request<TradeListData>(ENDPOINTS.tradesByOrder, {
    body: { symbol, order_id: orderId, page, pageSize },
  })
}

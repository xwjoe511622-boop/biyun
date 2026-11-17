import { request } from '@/modules/api/http'
import type { OrderItem, OrderListData, TradeItem, TradeListData } from '@/modules/api/types'
import {
  decimalField,
  normalizeAccountsOverview,
  normalizeBorrowPage,
  normalizeBorrowRules,
  normalizeRepayments,
  normalizeSymbolAccount,
  normalizeTransferPage,
} from './normalize'
import type {
  BorrowRecordPage,
  BorrowRule,
  MarginAccountsOverview,
  MarginSymbolAccount,
  MarginTransferPage,
  RepaymentRecord,
} from './types'

/**
 * Margin endpoints, all on the default `/fe-ex-api/` namespace (exchange-web-api).
 * Paths verified against the controllers:
 *   LeverFinanceAct.java  @RequestMapping("/lever") :43 — finance/balance :63, finance/symbol/balance :94,
 *                         finance/transfer :134, finance/transfer/list :243
 *   LeverBorrowAct.java   @RequestMapping("/lever") :38 — borrow/new :59, borrow/history :127,
 *                         return/info :193, finance/borrow :265, finance/return :356
 *   LeverOrderAct.java    @RequestMapping("/lever") :43 — order/create :67, order/cancel :170,
 *                         trade/list_by_order :243, order/history :354, order/list/new :424
 *   PublicAct.java        (no class prefix) borrow_rule :2674
 * There is **no** `lever/trade/list` (the legacy client marks it "废弃"; the live server answers 404).
 */
export const MARGIN_PATHS = {
  accounts: 'lever/finance/balance',
  symbolAccount: 'lever/finance/symbol/balance',
  borrow: 'lever/finance/borrow',
  repay: 'lever/finance/return',
  borrowOpen: 'lever/borrow/new',
  borrowHistory: 'lever/borrow/history',
  repayments: 'lever/return/info',
  transfer: 'lever/finance/transfer',
  transferList: 'lever/finance/transfer/list',
  createOrder: 'lever/order/create',
  cancelOrder: 'lever/order/cancel',
  openOrders: 'lever/order/list/new',
  historyOrders: 'lever/order/history',
  tradesByOrder: 'lever/trade/list_by_order',
  borrowRule: 'borrow_rule',
} as const

export function fetchMarginAccounts(): Promise<MarginAccountsOverview> {
  return request<unknown>(MARGIN_PATHS.accounts, { body: {} }).then(normalizeAccountsOverview)
}

/** `symbol` is the lower-case pair (`btcusdt`); the server resolves it with `SymbolUtils.getInfo`. */
export async function fetchMarginSymbolAccount(symbol: string): Promise<MarginSymbolAccount> {
  const data = await request<unknown>(MARGIN_PATHS.symbolAccount, { body: { symbol } })
  const account = normalizeSymbolAccount(data)
  if (account === null) {
    throw new Error('lever/finance/symbol/balance returned no account')
  }
  return account
}

export function fetchBorrowRules(): Promise<BorrowRule[]> {
  return request<unknown>(MARGIN_PATHS.borrowRule, { body: {} }).then(normalizeBorrowRules)
}

/** `{symbol, coin, amount}` — the server upper-cases symbol and coin itself. */
export function borrow(payload: { symbol: string; coin: string; amount: string; requestId?: string }): Promise<unknown> {
  const body: Record<string, string> = { symbol: payload.symbol, coin: payload.coin, amount: payload.amount }
  // client idempotency id (modules/api/draft-request-id.ts); an older server ignores it
  if (payload.requestId !== undefined && payload.requestId !== '') body.requestId = payload.requestId
  return request<unknown>(MARGIN_PATHS.borrow, { body })
}

/** `{id, amount}` — repays interest first, then principal (BorrowOrderServiceImpl.operateLeverReturn). */
export function repay(payload: { id: string; amount: string; requestId?: string }): Promise<unknown> {
  const body: Record<string, string> = { id: payload.id, amount: payload.amount }
  if (payload.requestId !== undefined && payload.requestId !== '') body.requestId = payload.requestId
  return request<unknown>(MARGIN_PATHS.repay, { body })
}

export interface BorrowQuery {
  /** Optional: blank returns every pair. */
  symbol?: string
  page: number
  pageSize: number
  /** `yyyy-MM-dd HH:mm:ss` (DateUtils.FORMAT_LONG); omitted when empty. */
  startTime?: string
  endTime?: string
}

function borrowBody(query: BorrowQuery): Record<string, string> {
  // `@RequestBody Map<String, String>`: send every value as a string.
  const body: Record<string, string> = { page: String(query.page), pageSize: String(query.pageSize) }
  if (query.symbol !== undefined && query.symbol !== '') body.symbol = query.symbol
  if (query.startTime !== undefined && query.startTime !== '') body.startTime = query.startTime
  if (query.endTime !== undefined && query.endTime !== '') body.endTime = query.endTime
  return body
}

export function fetchOpenBorrows(query: BorrowQuery): Promise<BorrowRecordPage> {
  return request<unknown>(MARGIN_PATHS.borrowOpen, { body: borrowBody(query) }).then(normalizeBorrowPage)
}

export function fetchBorrowHistory(query: BorrowQuery): Promise<BorrowRecordPage> {
  return request<unknown>(MARGIN_PATHS.borrowHistory, { body: borrowBody(query) }).then(normalizeBorrowPage)
}

export function fetchRepayments(id: string, page = 1, pageSize = 50): Promise<RepaymentRecord[]> {
  return request<unknown>(MARGIN_PATHS.repayments, { body: { id, page: String(page), pageSize: String(pageSize) } }).then(normalizeRepayments)
}

export function fetchMarginTransfers(query: { symbol?: string; transactionType?: '1' | '2'; page: number; pageSize: number }): Promise<MarginTransferPage> {
  const body: Record<string, string | number> = { page: query.page, pageSize: query.pageSize }
  if (query.symbol !== undefined && query.symbol !== '') body.symbol = query.symbol
  if (query.transactionType !== undefined) body.transactionType = query.transactionType
  return request<unknown>(MARGIN_PATHS.transferList, { body }).then(normalizeTransferPage)
}

function normalizeOrder(raw: unknown): OrderItem | null {
  if (raw === null || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const idValue = entry.id
  const id = typeof idValue === 'string' ? idValue : typeof idValue === 'number' && Number.isSafeInteger(idValue) ? String(idValue) : ''
  if (id === '') return null
  const status = typeof entry.status === 'number' ? entry.status : Number.parseInt(String(entry.status ?? ''), 10)
  const type = typeof entry.type === 'number' ? entry.type : Number.parseInt(String(entry.type ?? ''), 10)
  return {
    id,
    side: String(entry.side ?? '').toUpperCase(),
    side_text: typeof entry.side_text === 'string' ? entry.side_text : undefined,
    status: Number.isNaN(status) ? -1 : status,
    status_text: typeof entry.status_text === 'string' ? entry.status_text : undefined,
    type: Number.isNaN(type) ? 1 : type,
    time_long: typeof entry.time_long === 'number' ? entry.time_long : undefined,
    created_at: typeof entry.created_at === 'string' ? entry.created_at : undefined,
    price: decimalField(entry.price),
    volume: decimalField(entry.volume),
    total_price: decimalField(entry.total_price),
    remain_volume: decimalField(entry.remain_volume),
    deal_volume: decimalField(entry.deal_volume),
    deal_money: decimalField(entry.deal_money),
    avg_price: decimalField(entry.avg_price),
    baseCoin: typeof entry.baseCoin === 'string' ? entry.baseCoin : undefined,
    countCoin: typeof entry.countCoin === 'string' ? entry.countCoin : undefined,
  }
}

function normalizeOrderList(raw: unknown): OrderListData {
  const data = (raw ?? {}) as { count?: unknown; orderList?: unknown }
  const list = Array.isArray(data.orderList) ? data.orderList.map(normalizeOrder).filter((entry): entry is OrderItem => entry !== null) : []
  const count = typeof data.count === 'number' && Number.isInteger(data.count) ? data.count : list.length
  return { count, orderList: list }
}

export interface MarginOrderQuery {
  /** Lower-case pair; mandatory on the server for both lists (sharded order tables). */
  symbol: string
  page: number
  pageSize: number
  side?: '' | 'BUY' | 'SELL'
}

export function fetchMarginOpenOrders(query: MarginOrderQuery): Promise<OrderListData> {
  const body: Record<string, string | number> = { symbol: query.symbol, page: query.page, pageSize: query.pageSize }
  if (query.side !== undefined && query.side !== '') body.side = query.side
  return request<unknown>(MARGIN_PATHS.openOrders, { body }).then(normalizeOrderList)
}

/** `lever/order/history` reads `Map<String, String>`: every value goes out as a string. */
export function fetchMarginHistoryOrders(query: MarginOrderQuery & { isShowCanceled?: boolean }): Promise<OrderListData> {
  const body: Record<string, string> = {
    symbol: query.symbol,
    page: String(query.page),
    pageSize: String(query.pageSize),
    isShowCanceled: query.isShowCanceled === false ? '0' : '1',
  }
  if (query.side !== undefined && query.side !== '') body.side = query.side
  return request<unknown>(MARGIN_PATHS.historyOrders, { body }).then(normalizeOrderList)
}

/**
 * `lever/order/create` body exactly as LeverOrderAct reads it: `side`, `type` (1 limit / 2 market),
 * `volume`, lower-case `symbol` and `price` (`0` for market orders, matching the legacy client).
 */
export function createMarginOrder(payload: { symbol: string; side: 'BUY' | 'SELL'; type: '1' | '2'; price: string; volume: string }): Promise<unknown> {
  return request<unknown>(MARGIN_PATHS.createOrder, {
    body: {
      side: payload.side,
      type: payload.type,
      volume: payload.volume,
      price: payload.type === '1' ? payload.price : '0',
      symbol: payload.symbol.toLowerCase(),
    },
  })
}

export function cancelMarginOrder(payload: { orderId: string; symbol: string }): Promise<unknown> {
  return request<unknown>(MARGIN_PATHS.cancelOrder, { body: { orderId: payload.orderId, symbol: payload.symbol } })
}

export function fetchMarginTradesByOrder(symbol: string, orderId: string, page = 1, pageSize = 50): Promise<TradeListData> {
  return request<unknown>(MARGIN_PATHS.tradesByOrder, { body: { symbol, order_id: orderId, page, pageSize } }).then((raw) => {
    const data = (raw ?? {}) as { count?: unknown; trade_list?: unknown }
    const list: TradeItem[] = Array.isArray(data.trade_list)
      ? data.trade_list.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object').map(entry => ({
        id: typeof entry.id === 'number' || typeof entry.id === 'string' ? entry.id : '',
        ctime: typeof entry.ctime === 'string' ? entry.ctime : undefined,
        time_long: typeof entry.time_long === 'number' ? entry.time_long : undefined,
        side: typeof entry.side === 'string' ? entry.side : undefined,
        side_text: typeof entry.side_text === 'string' ? entry.side_text : undefined,
        price: decimalField(entry.price),
        volume: decimalField(entry.volume),
        deal_price: decimalField(entry.deal_price),
        fee: decimalField(entry.fee),
        feeCoin: typeof entry.feeCoin === 'string' ? entry.feeCoin : undefined,
      }))
      : []
    return { count: typeof data.count === 'number' ? data.count : list.length, trade_list: list }
  })
}

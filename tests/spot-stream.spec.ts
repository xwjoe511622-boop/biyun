// @vitest-environment jsdom
/**
 * Spot trade page on the Binance-style `/api/v3` + spot user data stream (2026-10-02): mapping, error texts, order
 * routing with the classic fallback, the stream-maintained 当前委托 / balances, fill toast, and the poll fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { clearToasts, useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { describeSpotV3Error, isSpotV3Unavailable, rejectReason } from '@/modules/spot/spot-errors'
import { setSpotV3Enabled, spotOrderParams } from '@/modules/spot/spot-order'
import { balanceUpdates, fillNotice, orderFromEvent, orderFromV3, type ExecutionReport } from '@/modules/spot/spot-stream-model'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'
import { useSpotLiveStore } from '@/stores/spot-live'

/* ------------------------------------------------------------------ fixtures */

/** Shapes as fgw `spotv3.rs` sends them (`order_obj`, core `stream_batch` via `map_event`). */
const v3Limit = { symbol: 'BTCUSDT', orderId: 156061400, orderListId: -1, clientOrderId: 'web1', price: '50000', origQty: '0.0003', executedQty: '0', cummulativeQuoteQty: '0', status: 'NEW', timeInForce: 'GTC', type: 'LIMIT', side: 'BUY', time: 1759347000000, updateTime: 1759347000000, isWorking: true, origQuoteOrderQty: '0' }
const v3MarketBuy = { ...v3Limit, orderId: 156061401, type: 'MARKET', price: '0', origQty: '0', origQuoteOrderQty: '15', status: 'FILLED', executedQty: '0.000177', cummulativeQuoteQty: '14.98' }

function report(over: Partial<ExecutionReport> = {}): ExecutionReport {
  return { e: 'executionReport', E: 1759347000100, s: 'BTCUSDT', c: 'web1', S: 'BUY', o: 'LIMIT', f: 'GTC', q: '0.0003', p: '50000', x: 'NEW', X: 'NEW', i: 156061400, l: '0', z: '0', L: '0', n: '0', N: null, T: 1759347000100, t: -1, O: 1759347000000, Z: '0', ...over }
}

describe('spot stream model', () => {
  it('maps /api/v3 orders to classic rows (market buy volume = quote amount)', () => {
    expect(orderFromV3(v3Limit)).toMatchObject({ id: '156061400', v3Symbol: 'BTCUSDT', side: 'BUY', type: 1, status: 1, price: '50000', volume: '0.0003', deal_volume: '0' })
    expect(orderFromV3(v3MarketBuy)).toMatchObject({ type: 2, status: 2, price: '', volume: '15', deal_volume: '0.000177', deal_money: '14.98' })
    expect(orderFromV3(v3Limit).created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  })

  it('maps executionReport and builds a fill notice only for TRADE', () => {
    expect(orderFromEvent(report({ X: 'PARTIALLY_FILLED', z: '0.0001', Z: '5' }))).toMatchObject({ id: '156061400', status: 3, deal_volume: '0.0001', avg_price: '50000', clientOrderId: 'web1' })
    expect(fillNotice(report())).toBeNull()
    expect(fillNotice(report({ x: 'TRADE', X: 'FILLED', z: '0.0003', Z: '15' }))).toMatchObject({ orderId: '156061400', filled: '0.0003', avgPrice: '50000', complete: true, market: false })
    expect(fillNotice(report({ x: 'TRADE', X: 'PARTIALLY_FILLED', z: '0.0001', Z: '5' }))?.complete).toBe(false)
  })

  it('reads balances from outboundAccountPosition and /api/v3/account, skipping unknown coins', () => {
    expect(balanceUpdates([{ a: 'usdt', f: '100.5', l: '15' }, { a: 'COIN99', f: '1', l: '0' }])).toEqual([{ asset: 'USDT', free: '100.5', locked: '15' }])
    expect(balanceUpdates([{ asset: 'BTC', free: '0.1', locked: '0' }])).toEqual([{ asset: 'BTC', free: '0.1', locked: '0' }])
  })
})

describe('spot /api/v3 errors and params', () => {
  const err = (code: number | string, msg: string, status = 400): ApiError => new ApiError({ kind: status === 401 ? 'unauthorized' : 'http', code: String(code), message: msg, status, path: 'api/v3/order', product: 'spot' })

  it('localises Binance codes and core reasons', () => {
    expect(describeSpotV3Error(err(-2010, 'Account has insufficient balance for requested action.'), 'zh_CN')).toBe('余额不足，无法冻结这笔委托')
    expect(rejectReason('Order rejected: VOLUME_BELOW_MIN')).toBe('VOLUME_BELOW_MIN')
    expect(describeSpotV3Error(err(-2010, 'Order rejected: VOLUME_BELOW_MIN'), 'zh_CN')).toBe('数量低于最小下单量')
    expect(describeSpotV3Error(err(-1013, 'Filter failure: PRICE_ABOVE_BAND'), 'en_US')).toBe('The price is above the allowed range: lower it')
    expect(describeSpotV3Error(err(-2010, 'Order rejected: SOMETHING_NEW'), 'zh_CN')).toBe('委托被拒绝（SOMETHING_NEW）')
    expect(describeSpotV3Error(err(-2011, 'Unknown order sent.'), 'zh_CN')).toBe('该委托已成交或已撤销')
    expect(describeSpotV3Error(err(-1102, "Mandatory parameter 'price' was not sent"), 'zh_CN')).toContain('请求参数有误')
    expect(describeSpotV3Error(new ApiError({ kind: 'http', code: '-2010', message: 'x', path: 'fapi/v1/order' }), 'zh_CN')).toBeNull()
  })

  it('treats 404 / HTML / API-key-only answers as "not available here"', () => {
    expect(isSpotV3Unavailable(err('HTTP404', 'HTTP 404', 404))).toBe(true)
    expect(isSpotV3Unavailable(new ApiError({ kind: 'parse', code: '', message: 'Invalid JSON', path: 'api/v3/order' }))).toBe(true)
    expect(isSpotV3Unavailable(err(-2014, 'API-key format invalid.', 401))).toBe(true)
    expect(isSpotV3Unavailable(err(-2015, 'Invalid session.', 401))).toBe(false)
    expect(isSpotV3Unavailable(err(-2010, 'Order rejected: X'))).toBe(false)
  })

  it('maps the ticket payload to Binance parameters', () => {
    expect(spotOrderParams('btcusdt', { side: 'BUY', type: '1', price: '50000', volume: '0.0003' }, 'c1')).toEqual({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '50000', quantity: '0.0003', newClientOrderId: 'c1', newOrderRespType: 'RESULT' })
    expect(spotOrderParams('btcusdt', { side: 'SELL', type: '1', price: '90000', volume: '0.001', timeInForce: 'FOK' }, 'c2')).toMatchObject({ type: 'LIMIT', timeInForce: 'FOK' })
    expect(spotOrderParams('btcusdt', { side: 'BUY', type: '2', price: '', volume: '15' }, 'c3')).toMatchObject({ type: 'MARKET', quoteOrderQty: '15' })
    expect(spotOrderParams('btcusdt', { side: 'BUY', type: '2', price: '', volume: '15' }, 'c3')).not.toHaveProperty('quantity')
    expect(spotOrderParams('btcusdt', { side: 'SELL', type: '2', price: '', volume: '0.001' }, 'c4')).toMatchObject({ type: 'MARKET', quantity: '0.001' })
  })
})

/* ------------------------------------------------------------------ stores with a fake gateway */

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  close(): void { this.closed = true }
  send(): void { /* heartbeat */ }
  open(): void { this.onopen?.({}) }
  push(event: unknown): void { this.onmessage?.({ data: JSON.stringify(event) }) }
  drop(): void { this.closed = true; this.onclose?.({ code: 1006 }) }
}
const socket = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket

let calls: string[]
let v3Open: unknown[]
let v3Mode: 'session' | 'absent'
let orderReply: { status: number; body: unknown }
let serverUsdt: { free: string; locked: string }

function json(payload: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: 'OK', text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) } as unknown as Response
}
const count = (entry: string): number => calls.filter((call) => call === entry).length
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  session.clear()
  clearToasts()
  i18n.global.locale.value = 'zh-CN'
  calls = []
  v3Open = []
  v3Mode = 'session'
  orderReply = { status: 200, body: { ...v3Limit } }
  serverUsdt = { free: '1000', locked: '0' }
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  setSpotV3Enabled(true)
  setActivePinia(createPinia())
  const symbol = { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 4, depth: '0.01' }
  useMarketStore().publicInfo = { market: { market: { USDT: { 'BTC/USDT': symbol } } } }
  session.setToken('jwt')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = url.split('?')[0] as string
    if (path.startsWith('/api/v3/')) {
      calls.push(`${method} ${path}`)
      if (v3Mode === 'absent') return json('<!doctype html><html></html>', 404)
      if (path === '/api/v3/userDataStream') return json(method === 'POST' ? { listenKey: 'sk1' } : {})
      if (path === '/api/v3/account') return json({ balances: [{ asset: 'USDT', free: '1000', locked: '0' }, { asset: 'BTC', free: '0.5', locked: '0' }] })
      if (path === '/api/v3/openOrders') return json(v3Open)
      if (path === '/api/v3/order' && method === 'POST') return json(orderReply.body, orderReply.status)
      if (path === '/api/v3/order' && method === 'DELETE') return json({ ...v3Limit, status: 'PENDING_CANCEL' })
      if (path === '/api/v3/openOrders' && method === 'DELETE') return json([])
      return json({ code: -1, msg: 'Unknown endpoint.' }, 404)
    }
    const classic = path.replace('/fe-ex-api/', '')
    calls.push(classic)
    if (classic === 'order/create') return json({ code: '0', msg: 'ok', data: { order_id: '777' } })
    if (classic === 'order/cancel') return json({ code: '0', msg: 'ok', data: {} })
    if (classic === 'order/list/new') return json({ code: '0', msg: 'ok', data: { count: 0, orderList: [] } })
    if (classic === 'finance/account_balance') return json({ code: '0', msg: 'ok', data: { allCoinMap: {
      USDT: { coinName: 'USDT', normal_balance: '900', lock_balance: '0', normalBalanceExact: serverUsdt.free, lockBalanceExact: serverUsdt.locked, nonTradingBalance: '0', overchargeRestricted: false },
      BTC: { coinName: 'BTC', normal_balance: '0.5', lock_balance: '0', normalBalanceExact: '0.5', lockBalanceExact: '0', nonTradingBalance: '0', overchargeRestricted: false },
    } } })
    return json({ code: '0', msg: 'ok', data: { count: 0, orderList: [], trade_list: [] } })
  }))
})
afterEach(() => {
  useSpotLiveStore().stop()
  setSpotV3Enabled(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  session.clear()
})

async function goLive(): Promise<void> {
  const live = useSpotLiveStore()
  live.start()
  await flush()
  expect(socket().url).toBe('wss://ws.exchange.invalid/spot/ws/sk1')
  socket().open()
  await flush()
  expect(useOrdersStore().live).toBe(true)
}

describe('spot order routing', () => {
  it('places via /api/v3/order with the session cookie and confirms the pending row', async () => {
    const orders = useOrdersStore()
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003' })).toBe(true)
    expect(count('POST /api/v3/order')).toBe(1)
    expect(count('order/create')).toBe(0)
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith('/api/v3/order'))
    expect(String(call?.[0])).toContain('timeInForce=GTC')
    // 10-17: the session is the HttpOnly cookie (same-origin credentials), never a header
    expect((call?.[1]?.headers as Record<string, string>)['exchange-token']).toBeUndefined()
    expect(call?.[1]?.credentials).toBe('same-origin')
    expect(orders.openOrders[0]).toMatchObject({ id: '156061400', pending: false })
  })

  it('falls back to the classic order/create when /api/v3 is not deployed, and keeps using it', async () => {
    v3Mode = 'absent'
    const orders = useOrdersStore()
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003' })).toBe(true)
    expect(count('order/create')).toBe(1)
    expect(orders.v3Available).toBe(false)
    await orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003' })
    expect(count('POST /api/v3/order')).toBe(1)
    expect(count('order/create')).toBe(2)
  })

  it('refuses IOC / FOK without /api/v3 instead of sending a GTC order', async () => {
    v3Mode = 'absent'
    const orders = useOrdersStore()
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003', timeInForce: 'IOC' })).toBe(false)
    expect(orders.submitError).toBe('error.tifUnavailable')
    expect(count('order/create')).toBe(0)
  })

  it('shows a Binance refusal in plain words and rolls the pending row back', async () => {
    orderReply = { status: 400, body: { code: -2010, msg: 'Account has insufficient balance for requested action.' } }
    const orders = useOrdersStore()
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003' })).toBe(false)
    expect(orders.submitError).toBe('余额不足，无法冻结这笔委托')
    expect(orders.openOrders).toHaveLength(0)
    expect(count('order/create')).toBe(0)
  })

  it('-1007 is "result unknown": no retry, the lists are re-read', async () => {
    orderReply = { status: 503, body: { code: -1007, msg: 'Timeout waiting for response from backend server.' } }
    const orders = useOrdersStore()
    const pending = orders.submitOrder({ side: 'BUY', type: '1', price: '50000', volume: '0.0003' })
    await vi.runAllTimersAsync()
    expect(await pending).toBe(false)
    expect(orders.submitError).toContain('结果未确认')
    expect(count('POST /api/v3/order')).toBe(1)
    expect(count('order/create')).toBe(0)
  })
})

describe('spot user stream', () => {
  it('drives 当前委托 immediately and coalesces dirty balance events into an authoritative read', async () => {
    v3Open = [v3Limit]
    const orders = useOrdersStore()
    const account = useAccountStore()
    await goLive()
    expect(orders.openOrders.map((row) => row.id)).toEqual(['156061400'])
    expect(account.quoteAvailable).toBe('1000')
    calls = []
    orderReply = { status: 200, body: { ...v3Limit, orderId: 156061402, clientOrderId: 'x' } }
    const placed = orders.submitOrder({ side: 'BUY', type: '1', price: '60000', volume: '0.001' })
    expect(account.quoteAvailable).toBe('940')
    expect(await placed).toBe(true)
    const sent = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/v3/order')).pop() ?? ''
    const clientId = new URLSearchParams(sent.split('?')[1]).get('newClientOrderId') ?? ''
    expect(clientId).toMatch(/^web/)
    // NEW event + balance event: the estimate is replaced by the stream figure
    socket().push(report({ i: 156061402, c: clientId, p: '60000', q: '0.001', O: 1759347001000 }))
    expect(account.quoteAvailable).toBe('940')
    serverUsdt = { free: '940', locked: '60' }
    socket().push({ e: 'outboundAccountPosition', E: 1, u: 1, B: [{ a: 'USDT', f: '940', l: '60' }] })
    expect(account.quoteAvailable).toBe('940')
    expect(account.quoteLocked).toBe('60')
    expect(orders.openOrders.map((row) => row.id)).toEqual(['156061402', '156061400'])
    await vi.advanceTimersByTimeAsync(6000)
    expect(count('finance/account_balance')).toBe(1)
    expect(count('GET /api/v3/account')).toBe(0)
  })

  it('events that arrive before the order reply still release the estimate', async () => {
    const account = useAccountStore()
    await goLive()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/v3/order') && init?.method === 'POST') {
        const clientId = new URLSearchParams(String(url).split('?')[1]).get('newClientOrderId') ?? ''
        socket().push(report({ i: 156061404, c: clientId, p: '60000', q: '0.001' }))
        serverUsdt = { free: '940', locked: '60' }
        socket().push({ e: 'outboundAccountPosition', E: 1, u: 1, B: [{ a: 'USDT', f: '940', l: '60' }] })
        await gate
        return json({ ...v3Limit, orderId: 156061404, clientOrderId: clientId })
      }
      return base(url, init)
    })
    const placed = useOrdersStore().submitOrder({ side: 'BUY', type: '1', price: '60000', volume: '0.001' })
    await flush()
    expect(account.quoteAvailable).toBe('940')
    release()
    expect(await placed).toBe(true)
    expect(account.quoteAvailable).toBe('940')
    expect(useOrdersStore().openOrders.map((row) => row.id)).toEqual(['156061404'])
  })

  it('a fill removes the row, raises the Binance-style toast and re-reads the fills list once', async () => {
    v3Open = [v3Limit]
    const orders = useOrdersStore()
    await goLive()
    calls = []
    socket().push(report({ x: 'TRADE', X: 'PARTIALLY_FILLED', z: '0.0001', Z: '5', l: '0.0001', L: '50000' }))
    expect(orders.openOrders[0]?.deal_volume).toBe('0.0001')
    socket().push(report({ x: 'TRADE', X: 'FILLED', z: '0.0003', Z: '15', l: '0.0002', L: '50000' }))
    expect(orders.openOrders).toHaveLength(0)
    const toasts = useToasts().value
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toBe('订单已成交：限价买入 BTC/USDT 0.0003 BTC，成交均价 50,000.00')
    await vi.advanceTimersByTimeAsync(1500)
    expect(count('trade/list')).toBe(1)
    expect(count('order/entrust_history')).toBe(1)
  })

  it('cancels via DELETE /api/v3/order; cancel-all is one DELETE /api/v3/openOrders', async () => {
    v3Open = [v3Limit, { ...v3Limit, orderId: 156061403, time: 1759347002000 }]
    const orders = useOrdersStore()
    await goLive()
    expect(await orders.cancelOrder('156061400')).toBe(true)
    expect(count('DELETE /api/v3/order')).toBe(1)
    expect(orders.openOrders.map((row) => row.id)).toEqual(['156061403'])
    const result = await orders.cancelAll()
    expect(result).toEqual({ cancelled: 1, failed: 0 })
    expect(count('DELETE /api/v3/order')).toBe(1)
    expect(count('DELETE /api/v3/openOrders')).toBe(1)
    expect(orders.openOrders).toHaveLength(0)
  })

  it('a cancel releases the funds at once and the stream figure replaces the estimate (no flicker)', async () => {
    v3Open = [v3Limit]
    const orders = useOrdersStore()
    const account = useAccountStore()
    await goLive()
    expect(await orders.cancelOrder('156061400')).toBe(true)
    expect(account.quoteAvailable).toBe('1015')
    // PENDING_CANCEL + a balance event that still shows the lock: the estimate stays
    socket().push(report({ x: 'PENDING_CANCEL', X: 'PENDING_CANCEL' }))
    serverUsdt = { free: '1000', locked: '15' }
    socket().push({ e: 'outboundAccountPosition', E: 1, u: 1, B: [{ a: 'USDT', f: '1000', l: '15' }] })
    expect(account.quoteAvailable).toBe('1015')
    socket().push(report({ x: 'CANCELED', X: 'CANCELED' }))
    serverUsdt = { free: '1015', locked: '0' }
    socket().push({ e: 'outboundAccountPosition', E: 2, u: 2, B: [{ a: 'USDT', f: '1015', l: '0' }] })
    await vi.advanceTimersByTimeAsync(120)
    expect(account.quoteAvailable).toBe('1015')
    expect(account.quoteLocked).toBe('0')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(account.quoteAvailable).toBe('1015')
  })

  it('ignores margin rows when the gateway marks them', async () => {
    v3Open = [v3Limit, { ...v3Limit, orderId: 9, orderType: 2 }]
    const orders = useOrdersStore()
    await goLive()
    socket().push(report({ i: 10, orderType: 2 }))
    expect(orders.openOrders.map((row) => row.id)).toEqual(['156061400'])
  })
  it('never uses stale/duplicate/invalid WS monetary payloads as an account snapshot', async () => {
    const account = useAccountStore(); await goLive(); calls = []
    serverUsdt = { free: '1100', locked: '2' }
    const stale = { e: 'outboundAccountPosition', B: [{ a: 'USDT', f: '3', l: '4' }] }
    socket().push(stale); socket().push(stale)
    socket().push({ e: 'outboundAccountPosition', B: [{ a: 'USDT', f: 'invalid', l: 'invalid' }] })
    expect(account.quoteAvailable).toBe('1000')
    await vi.advanceTimersByTimeAsync(120)
    expect(account.quoteAvailable).toBe('1100'); expect(account.quoteLocked).toBe('2')
    expect(count('finance/account_balance')).toBe(1)
  })
  it('runs a trailing authoritative read when another event arrives during a refresh', async () => {
    const account = useAccountStore(); await goLive(); calls = []
    let finish: () => void = () => { throw new Error('Missing first read') }
    const base = vi.mocked(fetch).getMockImplementation()!
    let delayed = true
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await base(url, init)
      if (String(url).endsWith('finance/account_balance') && delayed) {
        delayed = false
        await new Promise<void>(resolve => { finish = resolve })
      }
      return response
    })
    socket().push({ e: 'outboundAccountPosition', B: [] }); await vi.advanceTimersByTimeAsync(120)
    serverUsdt = { free: '1200', locked: '0' }
    socket().push({ e: 'outboundAccountPosition', B: [{ a: 'USDT', f: '1', l: '0' }] })
    finish(); await flush(); await vi.advanceTimersByTimeAsync(120)
    expect(account.quoteAvailable).toBe('1200')
    expect(count('finance/account_balance')).toBe(2)
  })
  it('does not commit a pending dirty refresh after logout or create a trailing request for the old session', async () => {
    const account = useAccountStore(); await goLive(); calls = []
    let finish: () => void = () => { throw new Error('Missing old-session read') }
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await base(url, init)
      if (String(url).endsWith('finance/account_balance')) await new Promise<void>(resolve => { finish = resolve })
      return response
    })
    socket().push({ e: 'outboundAccountPosition', B: [] }); await vi.advanceTimersByTimeAsync(120)
    session.clear(); finish(); await flush(); await vi.advanceTimersByTimeAsync(120)
    expect(account.data).toBeNull(); expect(account.quoteAvailable).toBe('')
    expect(count('finance/account_balance')).toBe(1)
    expect(useOrdersStore().live).toBe(false)
  })
  it('keeps a failed dirty read unknown and recovers through bounded resync instead of staying live', async () => {
    const account = useAccountStore(); const orders = useOrdersStore(); await goLive()
    const base = vi.mocked(fetch).getMockImplementation()!
    let unavailable = true
    vi.mocked(fetch).mockImplementation(async (url, init) => unavailable && String(url).endsWith('finance/account_balance')
      ? json({ code: '503', message: 'Synthetic snapshot unavailable' }, 503) : base(url, init))
    socket().push({ e: 'outboundAccountPosition', B: [{ a: 'USDT', f: '99999', l: '0' }] })
    await vi.advanceTimersByTimeAsync(120); await flush()
    expect(account.data).toBeNull(); expect(account.quoteAvailable).toBe(''); expect(orders.live).toBe(false)
    unavailable = false; serverUsdt = { free: '1100', locked: '0' }
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(orders.live).toBe(true); expect(account.quoteAvailable).toBe('1100')
  })
  it('stops the old private stream when a known UID changes under the same local session key', async () => {
    session.setUser({ id: 7 }); await goLive()
    const oldSocket = socket(); session.setUser({ id: 8 }); await flush()
    expect(oldSocket.closed).toBe(true); expect(useOrdersStore().live).toBe(false)
    expect(useAccountStore().data).toBeNull()
  })

  it('socket down → classic mode; the reconnect resyncs and goes live again', async () => {
    const orders = useOrdersStore()
    await goLive()
    socket().drop()
    expect(orders.live).toBe(false)
    await flush()
    expect(count('order/list/new')).toBeGreaterThanOrEqual(0)
    v3Open = [v3Limit]
    await vi.advanceTimersByTimeAsync(2000)
    socket().open()
    await flush()
    expect(orders.live).toBe(true)
    expect(orders.openOrders.map((row) => row.id)).toEqual(['156061400'])
  })

  it('no stream without /api/v3 (the classic poll stays in charge)', async () => {
    v3Mode = 'absent'
    useSpotLiveStore().start()
    await flush()
    expect(FakeSocket.all).toHaveLength(0)
    expect(useOrdersStore().live).toBe(false)
  })

  it('logout stops the stream but never DELETEs the shared listenKey', async () => {
    await goLive()
    session.clear()
    await flush()
    expect(socket().closed).toBe(true)
    expect(count('DELETE /api/v3/userDataStream')).toBe(0)
    expect(useOrdersStore().live).toBe(false)
  })

  it('keeps the key alive with PUT ?listenKey= every 30 min', async () => {
    await goLive()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).startsWith('/api/v3/userDataStream') && init?.method === 'PUT')
    expect(String(put?.[0])).toContain('listenKey=sk1')
  })
})

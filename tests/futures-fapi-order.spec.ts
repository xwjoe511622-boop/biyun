// @vitest-environment jsdom
/**
 * Binance-style order entry (`/futures-api/fapi/v1/order`, fgw 0.4.0, 2026-10-01): the classic payload maps onto
 * symbol / positionSide / type + timeInForce / quantity in coin; conditionals go to /fapi too since 10-02 (OTO stays classic); `-4000`
 * falls back to `order/order_create` for the rest of the session; cancels use DELETE; refusals read in plain words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import type { CreateOrderPayload } from '@/modules/futures/api'
import { buildContract } from '@/modules/futures/contracts'
import { describeFapiError } from '@/modules/futures/fapi-errors'
import { contractsForValue, fapiOrderParams, setFapiOrdersEnabled } from '@/modules/futures/fapi-order'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'

const info = normalizePublicInfo({
  contractList: [{ id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } }],
})
const btc = info.contractList.map(buildContract).filter((entry) => entry !== null)[0]!

const base: CreateOrderPayload = { contractId: 1, positionType: 1, side: 'BUY', open: 'OPEN', type: 1, volume: '10', price: '75000.5', leverageLevel: 20, isConditionOrder: false }

describe('payload → /fapi/v1/order parameters', () => {
  it('limit open long: BTCUSDT, LONG, GTC, quantity in coin', () => {
    expect(fapiOrderParams(base, { contract: btc }, 'cid1')).toEqual({ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', timeInForce: 'GTC', price: '75000.5', quantity: '0.001', newClientOrderId: 'cid1' })
  })

  it('position side from side + open/close (hedge mode)', () => {
    const side = (side: 'BUY' | 'SELL', open: 'OPEN' | 'CLOSE'): string | undefined => fapiOrderParams({ ...base, side, open }, { contract: btc })?.positionSide
    expect([side('BUY', 'OPEN'), side('SELL', 'OPEN'), side('SELL', 'CLOSE'), side('BUY', 'CLOSE')]).toEqual(['LONG', 'SHORT', 'LONG', 'SHORT'])
  })

  it('time in force per legacy type: 3 IOC, 4 FOK, 5 GTX; 2 MARKET without price', () => {
    expect(fapiOrderParams({ ...base, type: 3 }, { contract: btc })?.timeInForce).toBe('IOC')
    expect(fapiOrderParams({ ...base, type: 4 }, { contract: btc })?.timeInForce).toBe('FOK')
    expect(fapiOrderParams({ ...base, type: 5 }, { contract: btc })?.timeInForce).toBe('GTX')
    const close = fapiOrderParams({ ...base, side: 'SELL', open: 'CLOSE', type: 2, price: '', volume: '25' }, { contract: btc })
    expect(close).toMatchObject({ type: 'MARKET', quantity: '0.0025', positionSide: 'LONG' })
    expect(close?.price).toBeUndefined()
    expect(close?.timeInForce).toBeUndefined()
  })

  it('market open: the exact contracts when known, else the value spent over the book', () => {
    expect(fapiOrderParams({ ...base, type: 2, price: '', volume: '171.56', contracts: '20' }, { contract: btc })?.quantity).toBe('0.002')
    const levels = [{ price: '80000', amount: '5' }, { price: '80010', amount: '100' }]
    // 5 × 8 = 40 USDT at 80000, then 8.001 per contract: (100 − 40) / 8.001 = 7.49 → 7
    expect(fapiOrderParams({ ...base, type: 2, price: '', volume: '100' }, { contract: btc, levels, fallbackPrice: '80000' })?.quantity).toBe('0.0012')
    expect(fapiOrderParams({ ...base, type: 2, price: '', volume: '100' }, { contract: btc })).toBeNull()
  })

  it('conditionals are not mapped here (fapi-conditional.ts); attached TP/SL ride on the entry; a fractional contract count stays classic', () => {
    expect(fapiOrderParams({ ...base, isConditionOrder: true, triggerPrice: '76000' }, { contract: btc })).toBeNull()
    expect(fapiOrderParams({ ...base, tpsl: { takerProfitTrigger: '90000', takerProfitPrice: '90100' } }, { contract: btc })).toMatchObject({ tpStopPrice: '90000', tpOrderType: 'TAKE_PROFIT', tpPrice: '90100', tpslWorkingType: 'CONTRACT_PRICE' })
    expect(fapiOrderParams({ ...base, volume: '10.5' }, { contract: btc })).toBeNull()
  })

  it('contractsForValue: sells walk the bids from the top; a short book is priced at the worse fallback', () => {
    const bids = [{ price: '79990', amount: '1' }, { price: '80000', amount: '2' }]
    // best first: 2 × 8.000 + 1 × 7.999 = 23.999
    expect(contractsForValue({ side: 'SELL', value: '24', multiplier: '0.0001', levels: bids, fallbackPrice: '79000' })).toBe('3')
    // book exhausted: 16.001 left at the worse of 79990 / 79000 = 7.9 per contract → 2 more
    expect(contractsForValue({ side: 'SELL', value: '40', multiplier: '0.0001', levels: bids, fallbackPrice: '79000' })).toBe('5')
    expect(contractsForValue({ side: 'BUY', value: '50', multiplier: '0.0001', levels: [], fallbackPrice: '80000' })).toBe('6')
    expect(contractsForValue({ side: 'BUY', value: '5', multiplier: '0.0001', levels: [], fallbackPrice: '80000' })).toBe('')
  })
})

describe('/fapi refusals in plain words', () => {
  const fapi = (code: string, data?: unknown, message = 'x'): ApiError => new ApiError({ kind: 'http', code, message, status: 400, path: 'fapi/v1/order', data, product: 'futures' })

  it('filter refusals reuse the guard texts', () => {
    expect(describeFapiError(fapi('-1013', { filter: 'LOT_SIZE', minQty: '0.001', minContracts: '10', quantity: '0.0009' }), 'zh_CN')).toBe('不符合下单规则：数量太小：至少 0.001（10 张）')
    expect(describeFapiError(fapi('-4164', { filter: 'MIN_NOTIONAL', minNotional: '50', notional: '30' }), 'zh_CN')).toBe('不符合下单规则：订单金额太小：至少 50 USDT（当前约 30 USDT）')
    expect(describeFapiError(fapi('-1013', { filter: 'PRICE_FILTER', tickSize: '0.1', minPrice: '556.8', maxPrice: '4529764', price: '75000.55' }), 'zh_CN')).toBe('不符合下单规则：价格须为 0.1 的整数倍')
    expect(describeFapiError(fapi('-1013', { filter: 'PERCENT_PRICE', maxPrice: '87150', markPrice: '83000', multiplierUp: '1.05' }), 'en_US')).toBe('Order rejected by trading rules: price too high: at most 87150 (mark price 83000)')
    expect(describeFapiError(fapi('-2010', { filter: 'STP', ownOrderPrice: '75000' }), 'zh_CN')).toContain('价格为 75000 的挂单成交')
  })

  it('business codes', () => {
    expect(describeFapiError(fapi('-2019'), 'zh_CN')).toBe('可用保证金不足，请减少数量、降低杠杆或先划入资金')
    expect(describeFapiError(fapi('-2022'), 'en_US')).toContain('no position to close')
    expect(describeFapiError(fapi('-2027'), 'zh_CN')).toBe('超出当前杠杆的最大仓位价值，请降低杠杆或数量')
    expect(describeFapiError(fapi('-1102', undefined, "Mandatory parameter 'price' was not sent"), 'zh_CN')).toBe("请求参数有误（Mandatory parameter 'price' was not sent）")
  })

  it('the refusals B got from the live server (10-01 19:45, fapi-errors-live.mjs) read in plain words', () => {
    const live: [number, unknown, string][] = [
      [400, { code: -1013, data: { filter: 'LOT_SIZE', minContracts: '10', minQty: '0.001', quantity: '0.0005' }, msg: 'Filter failure: LOT_SIZE. quantity must be >= 0.001 BTC (10 contracts)' }, '不符合下单规则：数量太小：至少 0.001（10 张）'],
      [400, { code: -1111, msg: 'Precision is over the maximum defined for this asset. (quantity step 0.0001 BTC)' }, '数量须为整张（按合约面值的整数倍）'],
      [400, { code: -1013, data: { filter: 'PRICE_FILTER', maxPrice: '4529764', minPrice: '556.8', price: '79652.55', tickSize: '0.1' }, msg: 'Filter failure: PRICE_FILTER.' }, '不符合下单规则：价格须为 0.1 的整数倍'],
      [400, { code: -1013, data: { filter: 'PERCENT_PRICE', markPrice: '83843.1', maxPrice: '88035.2', multiplierUp: '1.05' }, msg: 'Filter failure: PERCENT_PRICE.' }, '不符合下单规则：价格太高：最高 88035.2（标记价格 83843.1）'],
      [400, { code: -4164, data: { filter: 'MIN_NOTIONAL', minNotional: '50', notional: '40' }, msg: "Order's notional must be no smaller than 50 (unless you choose reduce only)." }, '不符合下单规则：订单金额太小：至少 50 USDT（当前约 40 USDT）'],
      [400, { code: -2019, data: { name: 'ORDER_ACCOUNT_ENOUGH', reason: 'INSUFFICIENT_MARGIN' }, msg: 'Margin is insufficient.' }, '可用保证金不足，请减少数量、降低杠杆或先划入资金'],
      [400, { code: -2022, data: { name: 'POSITION_NOT_FOUND_FOR_CLOSE', reason: 'NO_POSITION' }, msg: 'ReduceOnly Order is rejected.' }, '平仓单被拒：该方向没有可平的仓位'],
      [400, { code: -4061, msg: "Order's position side does not match user's setting." }, '持仓方向与账户的持仓模式不符'],
      [400, { code: -1121, msg: 'Invalid symbol.' }, '该合约暂不可交易'],
      [400, { code: -2011, msg: 'Unknown order sent.' }, '委托不存在或已成交/已撤销'],
    ]
    for (const [status, body, text] of live) {
      const record = body as { code: number; msg: string; data?: unknown }
      const error = new ApiError({ kind: 'http', code: String(record.code), message: record.msg, status, path: 'fapi/v1/order', data: record.data, product: 'futures' })
      expect(describeFapiError(error, 'zh_CN'), String(record.code)).toBe(text)
    }
  })

  it('not a /fapi error, or a transport error: null (the usual path answers)', () => {
    expect(describeFapiError(new ApiError({ kind: 'api', code: '10001', message: 'x', path: 'order/order_create' }), 'zh_CN')).toBeNull()
    expect(describeFapiError(new ApiError({ kind: 'timeout', code: '', message: 'timeout', path: 'fapi/v1/order' }), 'zh_CN')).toBeNull()
  })
})

/* ---------------------------------------------------------------- store routing */

let calls: { path: string; method: string; query: string }[]
let openOrdersReply: unknown[] = []
let orderReply: { status: number; body: unknown }

function json(payload: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: 'OK', text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) } as unknown as Response
}

describe('order routing in the stores', () => {
  beforeEach(() => {
    localStorage.clear()
    session.clear()
    i18n.global.locale.value = 'zh-CN'
    setFapiOrdersEnabled(true)
    calls = []
    openOrdersReply = []
    orderReply = { status: 200, body: '{"orderId":3490755354386448384,"symbol":"BTCUSDT","status":"NEW"}' }
    setActivePinia(createPinia())
    const market = useFuturesMarketStore()
    market.contracts = [btc]
    market.selectedName = 'E-BTC-USDT'
    session.setToken('jwt')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const [path, query = ''] = url.replace(FUTURES_API_PREFIX, '').split('?') as [string, string?]
      const method = init?.method ?? 'GET'
      calls.push({ path, method, query })
      if (path === 'fapi/v1/order' && method === 'POST') return json(orderReply.body, orderReply.status)
      if (path === 'fapi/v1/order' && method === 'DELETE') return json({ orderId: 1, status: 'CANCELED' })
      if (path === 'fapi/v1/allOpenOrders') return json({ code: 200, msg: 'done' })
      if (path === 'fapi/v1/openOrders') return json(openOrdersReply)
      if (path === 'user/get_user_config') return json({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } })
      if (path === 'position/get_assets_list') return json({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
      if (path === 'order/order_create') return json({ code: '0', data: { ids: ['111'] } })
      if (path === 'order/order_cancel') return json({ code: '0', data: {} })
      if (path === 'order/current_order_list') return json({ code: '0', data: { count: 0, orderList: [] } })
      return json({ code: '0', data: {} })
    }))
  })
  afterEach(() => {
    setFapiOrdersEnabled(false)
    vi.unstubAllGlobals()
    session.clear()
  })

  async function ready(): Promise<{ account: ReturnType<typeof useFuturesAccountStore>; orders: ReturnType<typeof useFuturesOrdersStore> }> {
    const account = useFuturesAccountStore()
    const orders = useFuturesOrdersStore()
    await account.refresh()
    calls = []
    return { account, orders }
  }

  it('a limit order goes to POST /fapi/v1/order with the coin quantity; the long id is kept exact', async () => {
    const { account } = await ready()
    let ids: string[] = []
    const result = await account.placeOrder(base, { onAccepted: (next) => { ids = next } })
    expect(result).toBeNull()
    const post = calls.find((entry) => entry.path === 'fapi/v1/order')!
    const params = new URLSearchParams(post.query)
    expect(Object.fromEntries([...params].filter(([key]) => key !== 'newClientOrderId'))).toEqual({ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', quantity: '0.001', type: 'LIMIT', timeInForce: 'GTC', price: '75000.5' })
    expect(params.get('newClientOrderId')).toMatch(/^web[0-9a-z]{6,29}$/)
    expect(ids).toEqual(['3490755354386448384'])
    expect(calls.some((entry) => entry.path === 'order/order_create')).toBe(false)
    expect(account.orderRoute).toBe('fapi')
  })

  it('-4000 (copy trading) falls back to order_create, and later orders go classic directly', async () => {
    const { account } = await ready()
    orderReply = { status: 400, body: { code: -4000, msg: 'Copy-trading accounts use the classic order entry for now.' } }
    expect(await account.placeOrder(base)).toBeNull()
    expect(calls.filter((entry) => entry.path === 'fapi/v1/order')).toHaveLength(1)
    expect(calls.filter((entry) => entry.path === 'order/order_create')).toHaveLength(1)
    calls = []
    expect(await account.placeOrder(base)).toBeNull()
    expect(calls.some((entry) => entry.path === 'fapi/v1/order')).toBe(false)
    expect(account.orderRoute).toBe('classic')
  })

  it('a conditional order goes to /fapi as STOP / TAKE_PROFIT by its side of the watched price (10-02, core triggers)', async () => {
    const { account } = await ready()
    useFuturesMarketStore().ticker = { close: '75000', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
    expect(await account.placeOrder({ ...base, isConditionOrder: true, triggerPrice: '76000' })).toBeNull()
    const post = new URLSearchParams(calls.find((entry) => entry.path === 'fapi/v1/order')!.query)
    expect(post.get('type')).toBe('STOP')
    expect(post.get('stopPrice')).toBe('76000')
    expect(post.get('workingType')).toBe('CONTRACT_PRICE')
    expect(post.get('price')).toBe('75000.5')
    expect(calls.some((entry) => entry.path === 'order/order_create')).toBe(false)
    calls = []
    expect(await account.placeOrder({ ...base, type: 2, price: '', side: 'SELL', open: 'CLOSE', isConditionOrder: true, triggerPrice: '76000', workingType: 'MARK_PRICE' })).toBe('暂时拿不到当前价格，无法判断触发方向，请稍后再试')
    useFuturesMarketStore().marketInfo = { ...useFuturesMarketStore().marketInfo, tagPrice: '75100' }
    expect(await account.placeOrder({ ...base, type: 2, price: '', side: 'SELL', open: 'CLOSE', isConditionOrder: true, triggerPrice: '76000', workingType: 'MARK_PRICE' })).toBeNull()
    const tp = new URLSearchParams(calls.filter((entry) => entry.path === 'fapi/v1/order').pop()!.query)
    expect(Object.fromEntries([...tp].filter(([key]) => key !== 'newClientOrderId'))).toEqual({ symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'TAKE_PROFIT_MARKET', stopPrice: '76000', workingType: 'MARK_PRICE', quantity: '0.001' })
  })

  it('an opening order with attached TP/SL = one POST with tpStopPrice / slStopPrice (OTO, fgw 0.6.12)', async () => {
    const { account } = await ready()
    expect(await account.placeOrder({ ...base, tpsl: { takerProfitTrigger: '80000', stopLossTrigger: '70000' }, tpslWorkingType: 'MARK_PRICE' })).toBeNull()
    const post = new URLSearchParams(calls.find((entry) => entry.path === 'fapi/v1/order')!.query)
    expect([post.get('tpStopPrice'), post.get('slStopPrice'), post.get('tpslWorkingType'), post.get('tpOrderType'), post.get('type')]).toEqual(['80000', '70000', 'MARK_PRICE', null, 'LIMIT'])
    expect(calls.some((entry) => entry.path === 'order/order_create')).toBe(false)
  })

  it('a refused attached leg: the entry counts as placed, and a red toast says the TP/SL is missing', async () => {
    const { account } = await ready()
    orderReply = { status: 200, body: '{"orderId":3490755354386448384,"status":"NEW","attachedOrders":[{"orderId":8000000000000000070,"type":"TAKE_PROFIT_MARKET","otoPending":true},{"leg":"SL","status":"REJECTED","code":-2021,"msg":"Order would immediately trigger."}]}' }
    expect(await account.placeOrder({ ...base, tpsl: { takerProfitTrigger: '80000', stopLossTrigger: '76000' } })).toBeNull()
    expect(useToasts().value.map((toast) => toast.message).join('|')).toContain('开仓单已提交，但止损没有设置成功：触发价会立即触发')
  })

  it('cancel all keeps TP/SL: with conditionals on the contract it cancels the normal orders one by one', async () => {
    const { orders } = await ready()
    openOrdersReply = [
      { orderId: '8000000000000000058', symbol: 'BTCUSDT', status: 'NEW', price: '0', avgPrice: '0', origQty: '0.001', executedQty: '0', type: 'STOP_MARKET', origType: 'STOP_MARKET', timeInForce: 'GTC', side: 'SELL', positionSide: 'LONG', reduceOnly: true, stopPrice: '60000', workingType: 'MARK_PRICE', time: 0, updateTime: 0 },
    ]
    expect(await orders.cancelAll(false)).toBeNull()
    expect(calls.some((entry) => entry.path === 'fapi/v1/allOpenOrders')).toBe(false)
    expect(orders.conditionalRows.map((row) => row.id)).toEqual(['8000000000000000058'])
  })

  it('a refusal reads in plain words and is never reported as placed', async () => {
    const { account } = await ready()
    orderReply = { status: 400, body: { code: -2019, msg: 'Margin is insufficient.', data: { name: 'ORDER_ACCOUNT_ENOUGH' } } }
    expect(await account.placeOrder(base)).toBe('可用保证金不足，请减少数量、降低杠杆或先划入资金')
    orderReply = { status: 400, body: { code: -1013, msg: 'Filter failure: LOT_SIZE.', data: { filter: 'LOT_SIZE', minQty: '0.001', minContracts: '10', quantity: '0.0005' } } }
    expect(await account.placeOrder({ ...base, volume: '5' })).toBe('不符合下单规则：数量太小：至少 0.001（10 张）')
  })

  it('cancel uses DELETE /fapi/v1/order; cancel all uses DELETE /fapi/v1/allOpenOrders once', async () => {
    const { orders } = await ready()
    expect(await orders.cancel({ id: '3490755354386448384', contractId: 1 }, false)).toBeNull()
    const del = calls.find((entry) => entry.path === 'fapi/v1/order' && entry.method === 'DELETE')!
    expect(new URLSearchParams(del.query).get('orderId')).toBe('3490755354386448384')
    expect(new URLSearchParams(del.query).get('symbol')).toBe('BTCUSDT')
    calls = []
    expect(await orders.cancelAll(false)).toBeNull()
    expect(calls.filter((entry) => entry.path === 'fapi/v1/allOpenOrders' && entry.method === 'DELETE')).toHaveLength(1)
    expect(calls.some((entry) => entry.path === 'order/order_cancel')).toBe(false)
  })
})

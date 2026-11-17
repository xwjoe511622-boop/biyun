// @vitest-environment jsdom
/**
 * Conditional and TP/SL orders on `/fapi` (core trigger engine, fgw 0.6.9/0.6.10, 2026-10-02): Binance type by the
 * trigger's side of the watched price, TP/SL legs (closePosition / quantity, workingType), the 条件委托 rows from
 * `/fapi/v1/openOrders` (shape as B received it 10-02), the position TP/SL column source, the 「已触发」 toast, and the
 * -4000 classic fallback of the TP/SL dialog path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { session } from '@/core/session'
import { clearToasts, useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { conditionalType, directionOf, isConditionalId, positionTpslRows, tpslLegParams, triggerOrderFromFapi } from '@/modules/futures/fapi-conditional'
import type { FapiOpenOrder } from '@/modules/futures/fapi'
import { setFapiOrdersEnabled } from '@/modules/futures/fapi-order'
import { normalizePublicInfo, type FuturesPosition } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'

const info = normalizePublicInfo({
  contractList: [{ id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } }],
})
const btc = info.contractList.map(buildContract).filter((entry) => entry !== null)[0]!

/** `GET /fapi/v1/openOrders` row of a STOP_MARKET closePosition placed by B on 10-02 (fgw 0.6.10). */
const slRow: FapiOpenOrder = {
  avgPrice: '0', clientOrderId: '', closePosition: false, executedQty: '0', orderId: '8000000000000000058', origQty: '0.0011', origQuoteQty: '0', origType: 'STOP_MARKET',
  positionSide: 'LONG', price: '0', reduceOnly: true, side: 'SELL', status: 'NEW', stopPrice: '60000', symbol: 'BTCUSDT', time: 0, timeInForce: 'IOC', type: 'STOP_MARKET', updateTime: 0, workingType: 'MARK_PRICE',
} as FapiOpenOrder
const tpRow: FapiOpenOrder = { ...slRow, orderId: '8000000000000000059', origType: 'TAKE_PROFIT_MARKET', type: 'TAKE_PROFIT_MARKET', stopPrice: '99000', workingType: 'CONTRACT_PRICE', origQty: '0.001' }
const openRow: FapiOpenOrder = { ...slRow, orderId: '8000000000000000060', origType: 'STOP', type: 'STOP', side: 'BUY', positionSide: 'LONG', reduceOnly: false, stopPrice: '90000', price: '90100', origQty: '0.002' }

describe('conditional mapping', () => {
  it('Binance type from the trigger side of the watched price', () => {
    expect(conditionalType('BUY', '90000', '85000', false)).toBe('STOP')
    expect(conditionalType('BUY', '80000', '85000', true)).toBe('TAKE_PROFIT_MARKET')
    expect(conditionalType('SELL', '80000', '85000', true)).toBe('STOP_MARKET')
    expect(conditionalType('SELL', '90000', '85000', false)).toBe('TAKE_PROFIT')
    expect(conditionalType('SELL', '85000', '85000', true)).toBeNull()
    expect(conditionalType('SELL', '85000', '', true)).toBeNull()
    expect(directionOf('STOP_MARKET', 'SELL')).toBe('down')
    expect(directionOf('TAKE_PROFIT', 'SELL')).toBe('up')
    expect(isConditionalId('8000000000000000058')).toBe(true)
    expect(isConditionalId('3490755354386448384')).toBe(false)
  })

  it('TP/SL legs: entire position = closePosition without quantity; partial = quantity in coin', () => {
    expect(tpslLegParams({ contract: btc, positionSide: 'BUY', kind: 'sl', stopPrice: '80000', workingType: 'MARK_PRICE', closePosition: true, contracts: '11' }, 'c1'))
      .toEqual({ symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', stopPrice: '80000', workingType: 'MARK_PRICE', closePosition: 'true', newClientOrderId: 'c1' })
    expect(tpslLegParams({ contract: btc, positionSide: 'SELL', kind: 'tp', stopPrice: '80000', workingType: 'CONTRACT_PRICE', closePosition: false, contracts: '5' }, 'c2'))
      .toEqual({ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET', stopPrice: '80000', workingType: 'CONTRACT_PRICE', quantity: '0.0005', newClientOrderId: 'c2' })
  })

  it('openOrders rows → 条件委托 rows and the position TP/SL', () => {
    const sl = triggerOrderFromFapi(slRow, btc)
    expect(sl).toMatchObject({ id: '8000000000000000058', side: 'SELL', open: 'CLOSE', type: 2, triggerType: 1, triggerPrice: '60000', volume: '11', workingType: 'MARK_PRICE', direction: 'down', volumeIsContracts: true })
    const open = triggerOrderFromFapi(openRow, btc)
    expect(open).toMatchObject({ open: 'OPEN', type: 1, triggerType: 3, price: '90100', volume: '20', direction: 'up' })
    const position = { contractId: 1, orderSide: 'BUY', canCloseVolume: '11', positionVolume: '11' } as FuturesPosition
    const rows = positionTpslRows([sl, triggerOrderFromFapi(tpRow, btc), open], position)
    expect(rows.stopLoss.map((row) => row.triggerPrice)).toEqual(['60000'])
    expect(rows.takeProfit.map((row) => row.triggerPrice)).toEqual(['99000'])
    expect(positionTpslRows([sl], { ...position, orderSide: 'SELL' }).stopLoss).toEqual([])
  })
})

/* ---------------------------------------------------------------- stores */

let calls: { path: string; method: string; query: string }[]
let openOrders: unknown[]
let tpslReply: { status: number; body: unknown }

function json(payload: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: 'OK', text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) } as unknown as Response
}

const position: FuturesPosition = {
  id: 7, contractId: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', positionType: 1, orderSide: 'BUY', positionVolume: '11', canCloseVolume: '11', openAvgPrice: '84900',
  markPrice: '85000', reducePrice: '40000', holdAmount: '4.6', marginRate: '0.1', keepRate: '0.005', maxFeeRate: '0.00075', realizedAmount: '0', unRealizedAmount: '0',
  openRealizedAmount: '0', settleProfit: '0', returnRate: '0', leverageLevel: 20, positionBalance: '4.6', canSubMarginAmount: '0', capitalFee: '0', tradeFee: '0', takeProfitPrice: '', stopLossPrice: '',
}

describe('conditional orders in the stores', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    session.clear()
    clearToasts()
    i18n.global.locale.value = 'zh-CN'
    setFapiOrdersEnabled(true)
    calls = []
    openOrders = []
    tpslReply = { status: 200, body: '{"orderId":8000000000000000061,"type":"STOP_MARKET","status":"NEW"}' }
    setActivePinia(createPinia())
    const market = useFuturesMarketStore()
    market.contracts = [btc]
    market.selectedName = 'E-BTC-USDT'
    session.setToken('jwt')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const [path, query = ''] = url.replace(FUTURES_API_PREFIX, '').split('?') as [string, string?]
      const method = init?.method ?? 'GET'
      calls.push({ path, method, query })
      if (path === 'fapi/v1/order' && method === 'POST') return json(tpslReply.body, tpslReply.status)
      if (path === 'fapi/v1/order' && method === 'DELETE') return json({ orderId: 1, status: 'CANCELED' })
      if (path === 'fapi/v1/openOrders') return json(openOrders)
      if (path === 'user/get_user_config') return json({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } })
      if (path === 'position/get_assets_list') return json({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
      if (path === 'order/order_tpsl_create') return json({ code: '0', data: {} })
      return json({ code: '0', data: {} })
    }))
  })
  afterEach(() => {
    setFapiOrdersEnabled(false)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    session.clear()
  })

  it('position TP/SL → two *_MARKET close orders on /fapi (entire position, mark price); never order_tpsl_create', async () => {
    const account = useFuturesAccountStore()
    await account.refresh()
    calls = []
    const result = await account.createTpsl(position, [
      { triggerType: 2, triggerPrice: '95000', price: '0', type: 2, volume: '11' },
      { triggerType: 1, triggerPrice: '80000', price: '0', type: 2, volume: '11' },
    ], { workingType: 'MARK_PRICE', closePosition: true })
    expect(result).toBeNull()
    const posts = calls.filter((entry) => entry.path === 'fapi/v1/order' && entry.method === 'POST').map((entry) => new URLSearchParams(entry.query))
    expect(posts.map((params) => [params.get('type'), params.get('stopPrice'), params.get('closePosition'), params.get('quantity'), params.get('workingType')])).toEqual([
      ['TAKE_PROFIT_MARKET', '95000', 'true', null, 'MARK_PRICE'],
      ['STOP_MARKET', '80000', 'true', null, 'MARK_PRICE'],
    ])
    expect(calls.some((entry) => entry.path === 'order/order_tpsl_create')).toBe(false)
  })

  it('-2021 reads in plain words', async () => {
    const account = useFuturesAccountStore()
    await account.refresh()
    tpslReply = { status: 400, body: { code: -2021, msg: 'Order would immediately trigger.' } }
    const result = await account.createTpsl(position, [{ triggerType: 1, triggerPrice: '90000', price: '0', type: 2, volume: '11' }], { workingType: 'MARK_PRICE', closePosition: true })
    expect(result).toBe('触发价会立即触发：止盈/止损/条件单的触发价须在当前价格的另一侧')
  })

  it('-4000 (copy trading) → the classic order_tpsl_create', async () => {
    vi.useRealTimers()
    const account = useFuturesAccountStore()
    await account.refresh()
    tpslReply = { status: 400, body: { code: -4000, msg: 'classic' } }
    expect(await account.createTpsl(position, [{ triggerType: 1, triggerPrice: '80000', price: '0', type: 2, volume: '11' }])).toBeNull()
    expect(calls.some((entry) => entry.path === 'order/order_tpsl_create')).toBe(true)
  })

  it('条件委托 comes from /fapi/v1/openOrders (never 当前委托); cancel = DELETE by the 8e18 id', async () => {
    const account = useFuturesAccountStore()
    const orders = useFuturesOrdersStore()
    await account.refresh()
    openOrders = [slRow, openRow]
    await orders.load('trigger')
    expect(orders.lists.trigger.rows.map((row) => row.id)).toEqual(['8000000000000000060', '8000000000000000058'])
    expect(orders.lists.current.rows).toEqual([])
    calls = []
    expect(await orders.cancel({ id: '8000000000000000058', contractId: 1 }, true)).toBeNull()
    const del = calls.find((entry) => entry.path === 'fapi/v1/order' && entry.method === 'DELETE')!
    expect(new URLSearchParams(del.query).get('orderId')).toBe('8000000000000000058')
    expect(orders.lists.trigger.rows.map((row) => row.id)).toEqual(['8000000000000000060'])
    expect(calls.some((entry) => entry.path === 'order/order_cancel')).toBe(false)
  })

  it('conditional stream events: NEW lists, EXPIRED + the placed order = 「止损已触发」, CANCELED removes (core 0.8.7)', async () => {
    const account = useFuturesAccountStore()
    const orders = useFuturesOrdersStore()
    await account.refresh()
    await orders.load('trigger')
    const cond = { s: 'BTCUSDT', c: '', S: 'SELL', o: 'STOP_MARKET', ot: 'STOP_MARKET', f: 'GTC', q: '0', p: '0', ap: '0', sp: '60000', wt: 'MARK_PRICE', cp: true, R: true, ps: 'LONG', l: '0', z: '0', L: '0', T: 1790900647291, i: '8000000000000000080' }
    orders.applyOrderEvent({ ...cond, x: 'NEW', X: 'NEW' } as never)
    expect(orders.conditionalRows.map((row) => [row.id, row.closePosition, row.workingType, row.triggerType])).toEqual([['8000000000000000080', true, 'MARK_PRICE', 1]])
    expect(orders.lists.trigger.rows.map((row) => row.id)).toEqual(['8000000000000000080'])
    // an OTO leg not armed yet rides on its entry: not listed
    orders.applyOrderEvent({ ...cond, i: '8000000000000000081', x: 'NEW', X: 'NEW', otoPending: true, masterOrderId: '1' } as never)
    expect(orders.conditionalRows).toHaveLength(1)
    orders.applyOrderEvent({ ...cond, x: 'EXPIRED', X: 'EXPIRED' } as never)
    orders.applyOrderEvent({ s: 'BTCUSDT', c: '', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '0.0011', p: '57000', ap: '0', x: 'NEW', X: 'NEW', i: '3491679803147239425', l: '0', z: '0', L: '0', T: 2, ps: 'LONG', R: true } as never)
    expect(useToasts().value.map((toast) => toast.message).join('|')).toContain('止损已触发：平多 BTCUSDT，触发价 60,000.0（标记价格）')
    expect(orders.conditionalRows).toEqual([])
    expect(orders.lists.trigger.rows).toEqual([])
    // a user / system cancel is no fire
    clearToasts()
    orders.applyOrderEvent({ ...cond, i: '8000000000000000082', x: 'NEW', X: 'NEW' } as never)
    orders.applyOrderEvent({ ...cond, i: '8000000000000000082', x: 'CANCELED', X: 'CANCELED' } as never)
    expect(orders.conditionalRows).toEqual([])
    expect(useToasts().value).toEqual([])
  })
})

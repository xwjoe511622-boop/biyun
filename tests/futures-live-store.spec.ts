// @vitest-environment jsdom
/**
 * Futures stores driven by the user data stream (2026-10-01): after the resync the 5 s `get_assets_list` poll stops
 * (one safety snapshot per minute), events change open orders / positions / leverage at once, fills raise
 * 「订单已成交」, a dropped socket falls back to the legacy poll until the reconnect resyncs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { session } from '@/core/session'
import { clearToasts, useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesLiveStore } from '@/stores/futures-live'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  close(): void { this.closed = true }
  open(): void { this.onopen?.({}) }
  push(event: unknown): void { this.onmessage?.({ data: JSON.stringify(event).replace(/"i":"(\d+)"/, '"i":$1') }) }
  drop(): void { this.closed = true; this.onclose?.({ code: 1006 }) }
}
const socket = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket

let calls: string[]
let fapiPositions: unknown[]
let fapiOrders: unknown[]
let accountPositions: unknown[] | null

function json(payload: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}
const count = (path: string): number => calls.filter((entry) => entry === path).length

const account0 = { assets: [{ asset: 'USDT', walletBalance: '1000', unrealizedProfit: '0', marginBalance: '1000', maintMargin: '0', initialMargin: '0', positionInitialMargin: '0', openOrderInitialMargin: '0', crossWalletBalance: '1000', crossUnPnl: '0', availableBalance: '1000', maxWithdrawAmount: '1000' }], positions: [] as unknown[] }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  session.clear()
  clearToasts()
  i18n.global.locale.value = 'zh-CN'
  calls = []
  fapiPositions = []
  fapiOrders = []
  accountPositions = null
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  setActivePinia(createPinia())
  const market = useFuturesMarketStore()
  const info = normalizePublicInfo({
    contractList: [{ id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } }],
  })
  market.contracts = info.contractList.map(buildContract).filter((entry) => entry !== null)
  market.selectedName = 'E-BTC-USDT'
  session.setToken('jwt')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0] as string
    const method = init?.method ?? 'GET'
    calls.push(path.startsWith('fapi/') ? `${method} ${path}` : path)
    if (path === 'fapi/v1/listenKey') return json(method === 'POST' ? { listenKey: 'k1' } : {})
    if (path === 'fapi/v3/account') return json({ ...account0, positions: accountPositions !== null ? accountPositions : fapiPositions.length > 0 ? [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', notional: '83.7', isolatedWallet: '0' }] : [] })
    if (path === 'fapi/v3/positionRisk') return json(fapiPositions)
    if (path === 'fapi/v1/openOrders') return json(fapiOrders)
    if (path === 'user/get_user_config') return json({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } })
    if (path === 'position/get_assets_list') return json({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000', realizedAmount: '0' }] } })
    if (path === 'order/current_order_list') return json({ code: '0', data: { count: 0, orderList: [] } })
    return json({ code: '0', data: {} })
  }))
})
afterEach(() => {
  useFuturesLiveStore().stop()
  useFuturesAccountStore().stopPolling()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  session.clear()
})

async function boot(): Promise<{ account: ReturnType<typeof useFuturesAccountStore>; orders: ReturnType<typeof useFuturesOrdersStore>; live: ReturnType<typeof useFuturesLiveStore> }> {
  const account = useFuturesAccountStore()
  const orders = useFuturesOrdersStore()
  const live = useFuturesLiveStore()
  await account.refresh()
  account.startPolling()
  live.start()
  await vi.advanceTimersByTimeAsync(0)
  socket().open()
  await vi.advanceTimersByTimeAsync(0)
  return { account, orders, live }
}

const order = (over: Record<string, unknown>): Record<string, unknown> => ({
  e: 'ORDER_TRADE_UPDATE', E: 1790846307330, T: 1790846307326,
  o: { s: 'BTCUSDT', c: '0', S: 'BUY', o: 'LIMIT', f: 'GTC', q: '0.002', p: '75342.2', ap: '0', x: 'NEW', X: 'NEW', i: '3490755423105925120', l: '0', z: '0', L: '0', T: 1790846307326, b: '150.6844', a: '0', R: false, ps: 'LONG', rp: '0', ...over },
})

describe('futures live store', () => {
  it('resyncs from the /fapi snapshots and goes live; the 5 s get_assets_list poll stops', async () => {
    const { account, live } = await boot()
    expect(socket().url).toBe('wss://ws.exchange.invalid/futures-user/ws/k1')
    expect(account.live).toBe(true)
    expect(live.resyncs).toBe(1)
    expect(calls).toContain('GET fapi/v3/account')
    expect(calls).toContain('GET fapi/v1/openOrders')
    const before = count('position/get_assets_list')
    await vi.advanceTimersByTimeAsync(59_000)
    // one legacy read for the legacy-only fields after the resync (≥ 3 s after the bootstrap read), no polling
    expect(count('position/get_assets_list') - before).toBeLessThanOrEqual(1)
    const fapiBefore = count('GET fapi/v3/account')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(count('GET fapi/v3/account')).toBe(fapiBefore + 1)
    expect(count('order/current_order_list')).toBe(0)
  })

  it('open orders follow ORDER_TRADE_UPDATE; a fill raises 「订单已成交」', async () => {
    const { orders } = await boot()
    await orders.load('current')
    expect(orders.lists.current.rows).toHaveLength(0)
    socket().push(order({}))
    expect(orders.lists.current.rows.map((row) => row.id)).toEqual(['3490755423105925120'])
    expect(orders.lists.current.rows[0]).toMatchObject({ volume: '20', price: '75342.2', open: 'OPEN', side: 'BUY', positionType: 1 })
    socket().push(order({ x: 'TRADE', X: 'PARTIALLY_FILLED', l: '0.001', z: '0.001', L: '75342.2', ap: '75342.2' }))
    expect(orders.lists.current.rows[0]?.dealVolume).toBe('10')
    expect(useToasts().value.at(-1)?.message).toContain('订单部分成交')
    socket().push(order({ x: 'TRADE', X: 'FILLED', l: '0.001', z: '0.002', L: '75342.2', ap: '75342.2' }))
    expect(orders.lists.current.rows).toHaveLength(0)
    const toasts = useToasts().value.filter((toast) => toast.key === 'fill:3490755423105925120')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toBe('订单已成交：开多 BTCUSDT 0.002 BTC，成交均价 75,342.2')
    expect(count('order/current_order_list')).toBe(0)
  })

  it('refreshes loaded history on zero-fill terminal events without showing a fill toast', async () => {
    const { orders } = await boot()
    await orders.load('history')
    const before = count('order/history_order_list')
    socket().push(order({ x: 'CANCELED', X: 'CANCELED', f: 'FOK', l: '0', z: '0' }))
    socket().push(order({ x: 'EXPIRED', X: 'EXPIRED', f: 'GTX', i: '3490755423105925121', l: '0', z: '0' }))
    await vi.advanceTimersByTimeAsync(1_001)
    expect(count('order/history_order_list')).toBe(before + 1)
    expect(useToasts().value.filter(toast => toast.key?.startsWith('fill:'))).toHaveLength(0)
  })

  it('ACCOUNT_UPDATE shows the position at once, then one snapshot fills liq / margin', async () => {
    const { account } = await boot()
    fapiPositions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', entryPrice: '83713.1', markPrice: '83719.2', unRealizedProfit: '0.0061', liquidationPrice: '-10004307.66', leverage: '20', marginType: 'cross', isolatedWallet: '0', notional: '83.7192', maintMargin: '0.33487' }]
    socket().push({ e: 'ACCOUNT_UPDATE', E: 1, T: 1, a: { m: 'ORDER', B: [{ a: 'USDT', wb: '999.93', cw: '999.93', bc: '0' }], P: [{ s: 'BTCUSDT', pa: '0.001', ep: '83713.1', up: '0.0007', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    expect(account.positions).toHaveLength(1)
    expect(account.positions[0]).toMatchObject({ positionVolume: '10', openAvgPrice: '83713.1', orderSide: 'BUY' })
    await vi.advanceTimersByTimeAsync(300)
    expect(account.positions[0]?.reducePrice).toBe('-10004307.66')
    expect(account.positions[0]?.positionBalance).toBe('83.7192')
    socket().push({ e: 'ACCOUNT_UPDATE', E: 2, T: 2, a: { m: 'ORDER', P: [{ s: 'BTCUSDT', pa: '0', ep: '0', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    expect(account.positions).toHaveLength(0)
  })

  it('a failed event snapshot is retried (otherwise the incremental values stand until the safety snapshot)', async () => {
    const { account } = await boot()
    let failures = 2
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('fapi/v3/account') && failures > 0) { failures -= 1; throw new TypeError('fetch failed') }
      return base(url, init)
    })
    fapiPositions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', entryPrice: '83713.1', markPrice: '83719.2', unRealizedProfit: '0.0061', liquidationPrice: '-1', leverage: '20', marginType: 'cross', isolatedWallet: '0', notional: '83.7192', maintMargin: '0.33487' }]
    socket().push({ e: 'ACCOUNT_UPDATE', E: 1, T: 1, a: { m: 'ORDER', P: [{ s: 'BTCUSDT', pa: '0.001', ep: '83713.1', up: '0.0007', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    await vi.advanceTimersByTimeAsync(300)
    expect(account.positions[0]?.positionBalance).toBe('')
    await vi.advanceTimersByTimeAsync(4_100)
    expect(account.positions[0]?.positionBalance).toBe('83.7192')
  })

  it('older account responses use full positionRisk during the 10 s risk refresh, never a previous liquidation price', async () => {
    const { account } = await boot()
    fapiPositions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', entryPrice: '83713.1', markPrice: '83719.2', unRealizedProfit: '0.0061', liquidationPrice: '-1', leverage: '20', marginType: 'cross', isolatedWallet: '0', notional: '83.7192', maintMargin: '0.33487' }]
    socket().push({ e: 'ACCOUNT_UPDATE', E: 1, T: 1, a: { m: 'ORDER', P: [{ s: 'BTCUSDT', pa: '0.001', ep: '83713.1', up: '0.0061', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    await vi.advanceTimersByTimeAsync(300)
    expect(account.positions[0]?.positionBalance).toBe('83.7192')
    const accountReads = count('GET fapi/v3/account')
    const riskReads = count('GET fapi/v3/positionRisk')
    // the mark moves: the account snapshot carries the new notional
    accountPositions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', notional: '84.0001', isolatedWallet: '0', unrealizedProfit: '0.287' }]
    fapiPositions = [{ ...fapiPositions[0] as Record<string, unknown>, notional: '84.0001', markPrice: '84000.1', liquidationPrice: '265.25', maintMargin: '0.0251' }]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count('GET fapi/v3/account')).toBe(accountReads + 1)
    expect(count('GET fapi/v3/positionRisk')).toBe(riskReads + 1)
    expect(account.positions[0]?.positionBalance).toBe('84.0001')
    expect(account.positions[0]?.markPrice).toBe('84000.1')
    expect(account.positions[0]?.openAvgPrice).toBe('83713.1')
    expect(account.positions[0]?.reducePrice).toBe('265.25')
  })

  it('commits changed maintenance and liquidation from the same versioned account snapshot without a second read', async () => {
    const { account } = await boot()
    const base = vi.mocked(fetch).getMockImplementation()!
    let maintenance = '0.0245'
    let liquidation = '265.28'
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('fapi/v3/account')) return json({ ...account0, riskSnapshotVersion: 1, positions: [{
        symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.001', entryPrice: '83713.1', markPrice: '83719.2',
        unrealizedProfit: '0.0061', liquidationPrice: liquidation, leverage: '20', marginType: 'cross',
        isolatedWallet: '0', notional: '83.7192', maintMargin: maintenance,
      }] })
      return base(url, init)
    })
    const first = await account.prepareLiveSnapshot()
    if (typeof first === 'function') first()
    const riskReads = count('GET fapi/v3/positionRisk')
    maintenance = '0.0251'; liquidation = '265.25'
    const next = await account.prepareLiveSnapshot()
    expect(account.positions[0]?.reducePrice).toBe('265.28')
    const beforeRate = account.positions[0]?.keepRate
    if (typeof next === 'function') next()
    expect(account.positions[0]?.reducePrice).toBe('265.25')
    expect(account.positions[0]?.keepRate).not.toBe(beforeRate)
    expect(count('GET fapi/v3/positionRisk')).toBe(riskReads)
  })

  it('an older response cannot overwrite a newer completed risk snapshot', async () => {
    const { account } = await boot()
    const base = vi.mocked(fetch).getMockImplementation()!
    let finishOld: ((response: Response) => void) | undefined
    let reads = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('fapi/v3/account')) {
        reads += 1
        if (reads === 1) return new Promise<Response>((resolve) => { finishOld = resolve })
        return json({ ...account0, riskSnapshotVersion: 1, assets: [{ ...account0.assets[0], availableBalance: '777' }] })
      }
      return base(url, init)
    })
    const oldRequest = account.prepareLiveSnapshot()
    const newer = await account.prepareLiveSnapshot()
    if (typeof newer === 'function') newer()
    expect(account.available).toBe('777')
    finishOld?.(json({ ...account0, riskSnapshotVersion: 1 }))
    expect(await oldRequest).toBeNull()
    expect(account.available).toBe('777')
  })

  it('a stream event between preparing and committing a snapshot invalidates the old commit', async () => {
    const { account } = await boot()
    const commit = await account.prepareLiveSnapshot()
    account.applyStreamAccountUpdate({ m: 'TRANSFER', B: [{ a: 'USDT', wb: '998', cw: '998' }] })
    expect(account.account?.totalAmount).toBe('998')
    if (typeof commit === 'function') commit()
    expect(account.account?.totalAmount).toBe('998')
  })

  it('repeated stream changes exhaust bounded retries without ever committing the stale snapshot', async () => {
    const { account } = await boot()
    const base = vi.mocked(fetch).getMockImplementation()!
    let reads = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('fapi/v3/account')) {
        reads += 1
        account.applyStreamAccountUpdate({ m: 'TRANSFER', B: [{ a: 'USDT', wb: '998', cw: '998' }] })
        return json({ ...account0, riskSnapshotVersion: 1 })
      }
      return base(url, init)
    })
    expect(await account.prepareLiveSnapshot()).toBeNull()
    expect(reads).toBe(3)
    expect(account.account?.totalAmount).toBe('998')
  })

  it('ACCOUNT_CONFIG_UPDATE changes the leverage', async () => {
    const { account } = await boot()
    expect(account.leverage).toBe(20)
    socket().push({ e: 'ACCOUNT_CONFIG_UPDATE', E: 1, T: 1, ac: { s: 'BTCUSDT', l: 25 } })
    expect(account.leverage).toBe(25)
  })

  it('a dropped socket falls back to the legacy poll, the reconnect resyncs and stops it again', async () => {
    const { account, live } = await boot()
    socket().drop()
    expect(account.live).toBe(false)
    const before = count('position/get_assets_list')
    await vi.advanceTimersByTimeAsync(900)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(count('position/get_assets_list')).toBeGreaterThan(before)
    socket().open()
    await vi.advanceTimersByTimeAsync(0)
    expect(account.live).toBe(true)
    expect(live.resyncs).toBe(2)
    expect(count('POST fapi/v1/listenKey')).toBe(2)
  })

  it('an order placed while disconnected shows in 当前委托 after the reconnect resync (10-01 live S8)', async () => {
    const { orders } = await boot()
    await orders.load('current')
    socket().drop()
    fapiOrders = [{ avgPrice: '0', executedQty: '0', orderId: 3490815105971470336n.toString(), origQty: '0.003', origType: 'LIMIT', positionSide: 'LONG', price: '75000', reduceOnly: false, side: 'BUY', status: 'NEW', symbol: 'BTCUSDT', time: 1790849782000, timeInForce: 'GTC', type: 'LIMIT', updateTime: 1790849782300 }]
    await vi.advanceTimersByTimeAsync(1_000)
    socket().open()
    await vi.advanceTimersByTimeAsync(0)
    expect(orders.lists.current.rows.map((row) => row.id)).toEqual(['3490815105971470336'])
    expect(orders.lists.current.rows[0]?.volume).toBe('30')
  })

  it('events that arrive during the resync are applied after it', async () => {
    const account = useFuturesAccountStore()
    const orders = useFuturesOrdersStore()
    const live = useFuturesLiveStore()
    await account.refresh()
    await orders.load('current')
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    socket().open()
    socket().push(order({}))
    await vi.advanceTimersByTimeAsync(0)
    expect(account.live).toBe(true)
    expect(orders.lists.current.rows.map((row) => row.id)).toEqual(['3490755423105925120'])
  })

  it('sign-out stops the stream and closes the listenKey with the old session', async () => {
    const { account } = await boot()
    const first = socket()
    session.clear()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.closed).toBe(true)
    expect(account.live).toBe(false)
    expect(count('DELETE fapi/v1/listenKey')).toBe(1)
    const deleteCall = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([, init]) => init?.method === 'DELETE')
    // 10-17: no session key or token header on the wire; the cookie (if still valid) authenticates
    expect((deleteCall?.[1]?.headers as Record<string, string>)['exchange-token']).toBeUndefined()
  })
})

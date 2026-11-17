import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import * as http from '@/modules/api/http'
import type { PublicInfoV4 } from '@/modules/api/types'
import * as marginApi from '@/modules/margin/api'
import { useMarginStore } from '@/stores/margin'
import { useMarginOrdersStore } from '@/stores/marginOrders'
import { useMarketStore } from '@/stores/market'

// Synthetic only: the transport is mocked, nothing reaches a server.
vi.mock('@/modules/api/http', () => ({ request: vi.fn(), requestLanguage: () => 'zh_CN' }))

let pinia: Pinia
beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(http.request).mockResolvedValue({})
  useMarketStore().publicInfo = {
    switch: { lever_open: '1' },
    market: { coinList: {}, market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1 } } } },
  } as unknown as PublicInfoV4
})
afterEach(() => {
  disposePinia(pinia)
  session.clear()
})

function lastCall(): [string, { body?: unknown }] {
  const calls = vi.mocked(http.request).mock.calls
  return calls[calls.length - 1] as [string, { body?: unknown }]
}

describe('margin request contract', () => {
  it('sends lever/order/create with price 0 for market orders and a lower-case symbol', async () => {
    await marginApi.createMarginOrder({ symbol: 'BTCUSDT', side: 'BUY', type: '2', price: '123', volume: '50' })
    expect(lastCall()).toEqual(['lever/order/create', { body: { side: 'BUY', type: '2', volume: '50', price: '0', symbol: 'btcusdt' } }])
    await marginApi.createMarginOrder({ symbol: 'btcusdt', side: 'SELL', type: '1', price: '41000.5', volume: '0.01' })
    expect(lastCall()[1].body).toEqual({ side: 'SELL', type: '1', volume: '0.01', price: '41000.5', symbol: 'btcusdt' })
  })

  it('sends string values to the Map<String, String> lever endpoints', async () => {
    await marginApi.fetchOpenBorrows({ symbol: 'btcusdt', page: 2, pageSize: 10, startTime: '2026-09-01 00:00:00', endTime: '' })
    expect(lastCall()).toEqual(['lever/borrow/new', { body: { page: '2', pageSize: '10', symbol: 'btcusdt', startTime: '2026-09-01 00:00:00' } }])
    await marginApi.fetchMarginHistoryOrders({ symbol: 'btcusdt', page: 1, pageSize: 10, side: 'BUY' })
    expect(lastCall()).toEqual(['lever/order/history', { body: { symbol: 'btcusdt', page: '1', pageSize: '10', isShowCanceled: '1', side: 'BUY' } }])
    await marginApi.repay({ id: '12', amount: '1.5' })
    expect(lastCall()).toEqual(['lever/finance/return', { body: { id: '12', amount: '1.5' } }])
    await marginApi.fetchRepayments('12')
    expect(lastCall()).toEqual(['lever/return/info', { body: { id: '12', page: '1', pageSize: '50' } }])
  })

  it('normalises lever order ids to strings and keeps decimals as strings', async () => {
    vi.mocked(http.request).mockResolvedValueOnce({ count: 1, orderList: [{ id: 42, side: 'buy', status: 1, type: 1, price: 41000.5, volume: '0.01', deal_volume: 0 }] })
    const data = await marginApi.fetchMarginOpenOrders({ symbol: 'btcusdt', page: 1, pageSize: 10 })
    expect(data.orderList?.[0]).toMatchObject({ id: '42', side: 'BUY', price: '41000.5', volume: '0.01', deal_volume: '0' })
  })
})

describe('margin stores', () => {
  it('never borrows, repays or orders while signed out', async () => {
    const margin = useMarginStore()
    const orders = useMarginOrdersStore()
    expect(await margin.borrow('USDT', '10')).not.toBeNull()
    expect(await margin.repay('1', '10')).not.toBeNull()
    expect(await orders.submit({ side: 'BUY', type: '1', price: '1', volume: '1' })).not.toBeNull()
    expect(http.request).not.toHaveBeenCalled()
  })

  it('borrows on the selected margin pair and reports the server message on failure', async () => {
    session.setToken('synthetic-margin-session')
    const margin = useMarginStore()
    expect(margin.currentSymbol).toBe('btcusdt')
    expect(await margin.borrow('USDT', '10')).toBeNull()
    expect(lastCall()).toEqual(['lever/finance/borrow', { body: { symbol: 'btcusdt', coin: 'USDT', amount: '10', requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) } }])
    vi.mocked(http.request).mockRejectedValueOnce(new Error('借款数量小于最小值'))
    expect(await margin.borrow('USDT', '0.1')).toBe('借款数量小于最小值')
  })

  it('drops a margin account response that arrives after the session changed', async () => {
    session.setToken('synthetic-margin-session')
    let resolve!: (value: unknown) => void
    vi.mocked(http.request).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const margin = useMarginStore()
    const pending = margin.loadAccount()
    session.clear()
    session.setToken('other-session')
    resolve({ symbol: 'btcusdt', name: 'BTC/USDT', baseCoin: 'BTC', quoteCoin: 'USDT', riskRate: 150 })
    await pending
    expect(margin.account).toBeNull()
  })
})

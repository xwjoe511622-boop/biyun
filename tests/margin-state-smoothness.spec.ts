/**
 * Margin side of the 2026-09-29 state conventions: pending row + balance move on placement, rollback on refusal,
 * row removal on a confirmed cancel, and one coalesced refresh (open orders + pair account) per action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import type { OrderItem, PublicInfoV4 } from '@/modules/api/types'
import * as marginApi from '@/modules/margin/api'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import { useMarginStore } from '@/stores/margin'
import { useMarginOrdersStore } from '@/stores/marginOrders'
import { useMarketStore } from '@/stores/market'

vi.mock('@/modules/margin/api', () => ({
  fetchMarginOpenOrders: vi.fn(), fetchMarginHistoryOrders: vi.fn(), createMarginOrder: vi.fn(), cancelMarginOrder: vi.fn(), fetchMarginSymbolAccount: vi.fn(),
}))

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const order = (id: string): OrderItem => ({ id, side: 'BUY', type: 1, status: 1, price: '100', volume: '1', deal_volume: '0' })
const account = (quote: string): MarginSymbolAccount => ({ symbol: 'btcusdt', baseCoin: 'BTC', quoteCoin: 'USDT', baseNormalBalance: '1', baseLockBalance: '0', quoteNormalBalance: quote, quoteLockBalance: '0' } as MarginSymbolAccount)

let pinia: Pinia
beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  useMarketStore().publicInfo = {
    switch: { lever_open: '1' },
    market: { coinList: {}, market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1 } } } },
  } as unknown as PublicInfoV4
  session.setToken('synthetic-margin-session')
  vi.mocked(marginApi.fetchMarginOpenOrders).mockResolvedValue({ count: 1, orderList: [order('m1')] })
  vi.mocked(marginApi.fetchMarginHistoryOrders).mockResolvedValue({ count: 0, orderList: [] })
  vi.mocked(marginApi.fetchMarginSymbolAccount).mockResolvedValue(account('500'))
})
afterEach(() => {
  disposePinia(pinia)
  session.clear()
})

describe('margin orders: optimistic actions and one refresh', () => {
  it('pending row and balance at once; one refresh (orders + account) after acceptance', async () => {
    const orders = useMarginOrdersStore()
    const margin = useMarginStore()
    await Promise.all([orders.load('open'), margin.loadAccount()])
    vi.mocked(marginApi.fetchMarginOpenOrders).mockClear()
    vi.mocked(marginApi.fetchMarginSymbolAccount).mockClear()
    let accept!: (value: unknown) => void
    vi.mocked(marginApi.createMarginOrder).mockReturnValueOnce(new Promise((resolve) => { accept = resolve }))
    const placing = orders.submit({ side: 'BUY', type: '1', price: '100', volume: '2' })
    expect(orders.lists.open[0]).toMatchObject({ pending: true, price: '100' })
    expect(orders.counts.open).toBe(2)
    expect(margin.account?.quoteNormalBalance).toBe('300')
    accept({ order_id: 'm2' })
    expect(await placing).toBeNull()
    expect(orders.lists.open[0]).toMatchObject({ id: 'm2', pending: false })
    await wait(220)
    expect(marginApi.fetchMarginOpenOrders).toHaveBeenCalledTimes(1)
    expect(marginApi.fetchMarginSymbolAccount).toHaveBeenCalledTimes(1)
  })

  it('rolls back on refusal and removes the row on a confirmed cancel', async () => {
    const orders = useMarginOrdersStore()
    const margin = useMarginStore()
    await Promise.all([orders.load('open'), margin.loadAccount()])
    vi.mocked(marginApi.createMarginOrder).mockRejectedValueOnce(new Error('余额不足'))
    expect(await orders.submit({ side: 'BUY', type: '1', price: '100', volume: '2' })).toBe('余额不足')
    expect(orders.lists.open.map((row) => row.id)).toEqual(['m1'])
    expect(margin.account?.quoteNormalBalance).toBe('500')
    vi.mocked(marginApi.cancelMarginOrder).mockResolvedValueOnce(undefined as never)
    expect(await orders.cancel('m1')).toBe(true)
    expect(orders.lists.open).toHaveLength(0)
    expect(margin.account?.quoteNormalBalance).toBe('600')
  })
})

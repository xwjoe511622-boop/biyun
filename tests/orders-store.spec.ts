import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'
import * as api from '@/modules/api/order.api'

vi.mock('@/modules/api/order.api', () => ({ fetchOpenOrders: vi.fn(), fetchHistoryOrders: vi.fn(), fetchMyTrades: vi.fn(), createOrder: vi.fn(), cancelOrder: vi.fn() }))
let pinia: Pinia
beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  const symbol = { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01' }
  useMarketStore().publicInfo = { market: { market: { USDT: { 'BTC/USDT': symbol } } } }
})
afterEach(() => { disposePinia(pinia); session.clear() })

describe('order request boundaries', () => {
  it('does not call mutation APIs when logged out', async () => {
    const orders = useOrdersStore()
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '102', volume: '0.01' })).toBe(false)
    expect(await orders.cancelOrder('synthetic-order')).toBe(false)
    expect(api.createOrder).not.toHaveBeenCalled()
    expect(api.cancelOrder).not.toHaveBeenCalled()
  })

  it('rejects stale private order responses after a session change', async () => {
    session.setToken('synthetic-test-session')
    let resolve!: (data: { count: number; orderList: [] }) => void
    vi.mocked(api.fetchOpenOrders).mockReturnValue(new Promise(done => { resolve = done }))
    const orders = useOrdersStore()
    const request = orders.loadOpenOrders()
    session.clear()
    session.setToken('other-synthetic-session')
    resolve({ count: 4, orderList: [] })
    await request
    expect(orders.openCount).toBe(0)
    expect(orders.loading.open).toBe(false)
  })

  it('ignores earlier list requests arriving after the latest refresh', async () => {
    session.setToken('synthetic-test-session')
    let resolve!: (data: { count: number; orderList: [] }) => void
    vi.mocked(api.fetchOpenOrders).mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce({ count: 2, orderList: [] })
    const orders = useOrdersStore()
    const old = orders.loadOpenOrders()
    await orders.loadOpenOrders()
    resolve({ count: 8, orderList: [] })
    await old
    expect(orders.openCount).toBe(2)
  })
})

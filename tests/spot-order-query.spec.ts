// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSpotOrder } from '@/modules/spot/spot-api'
afterEach(() => vi.unstubAllGlobals())
describe('QA148 read-only order query', () => {
  it('uses GET and preserves an order id beyond safe integer range', async () => {
    const response = { symbol: 'BTCUSDT', orderId: '9007199254740993', status: 'FILLED', executedQty: '0.30000000', cummulativeQuoteQty: '0.60000000' }
    const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchSpotOrder('BTCUSDT', response.orderId)).toMatchObject(response)
    expect(fetch).toHaveBeenCalledWith('/api/v3/order?symbol=BTCUSDT&orderId=9007199254740993', expect.objectContaining({ method: 'GET' }))
    expect(fetch).toHaveBeenCalledOnce()
  })
})

// @vitest-environment jsdom
/**
 * Closed spot pairs are hidden (2026-10-02): public_info_v4 keeps a closed pair listed until its cache refreshes and has
 * no open flag; /api/v3/exchangeInfo marks it BREAK at once. The market store hides non-TRADING pairs from discovery while retaining selected metadata
 * so existing orders can still be inspected and cancelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { closedFromExchangeInfo, fetchClosedSpotSymbols, resetExchangeStatusCache } from '@/modules/spot/exchange-status'
import { useMarketStore } from '@/stores/market'

const info = { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }, { symbol: 'AVAXUSDT', status: 'BREAK' }, { symbol: 'SOLUSDT', status: 'TRADING' }] }

beforeEach(() => {
  resetExchangeStatusCache()
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => info }) as unknown as Response))
})
afterEach(() => vi.unstubAllGlobals())

describe('closed spot pairs', () => {
  it('reads non-TRADING symbols, caches 60 s, keeps the last answer on failure', async () => {
    expect([...closedFromExchangeInfo(info)]).toEqual(['AVAXUSDT'])
    expect(closedFromExchangeInfo({})).toEqual(new Set())
    expect([...(await fetchClosedSpotSymbols())]).toEqual(['AVAXUSDT'])
    vi.mocked(fetch).mockRejectedValue(new Error('down'))
    expect([...(await fetchClosedSpotSymbols())]).toEqual(['AVAXUSDT'])
    expect([...(await fetchClosedSpotSymbols(Date.now() + 61_000))]).toEqual(['AVAXUSDT'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('the store hides a closed pair from discovery but retains the selected metadata for cancelling owned orders', async () => {
    const market = useMarketStore()
    const pair = (name: string, symbol: string) => ({ symbol, name, price: 2, volume: 2, depth: '0.01' })
    market.selectedPair = 'AVAX/USDT'
    market.publicInfo = { market: { market: { USDT: { 'BTC/USDT': pair('BTC/USDT', 'btcusdt'), 'AVAX/USDT': pair('AVAX/USDT', 'avaxusdt') } } } }
    expect(market.symbols.map((s) => s.pair)).toEqual(['BTC/USDT', 'AVAX/USDT'])
    await market.loadPublicInfo()
    await vi.waitFor(() => expect(market.symbols.map((s) => s.pair)).toEqual(['BTC/USDT']))
    expect(market.selectedPair).toBe('AVAX/USDT')
    expect(market.currentTradingClosed).toBe(true)
    expect(market.currentSymbol?.symbol).toBe('avaxusdt')
  })
})

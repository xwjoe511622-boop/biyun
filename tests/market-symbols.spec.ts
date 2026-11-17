import { describe, expect, it } from 'vitest'
import type { PublicInfoV4 } from '@/modules/api/types'
import {
  buildMarketSymbols,
  findCoinBalance,
  findSymbolByPair,
  normalizeKlineScales,
  pickDefaultSymbol,
  sellableBalance,
} from '@/modules/market/symbols'

const publicInfo: PublicInfoV4 = {
  msg: { company_name: 'Demo Exchange', logoUrl: '' },
  market: {
    wsUrl: 'wss://ws.exchange.invalid/kline-api/ws',
    klineScale: '1min,5min,1day',
    market: {
      USDT: {
        'BTC/USDT': {
          symbol: 'btcusdt',
          price: 2,
          volume: 8,
          name: 'BTC/USDT',
          depth: '0.00000001,0.000001,0.0001',
          limitPriceMin: '0.01',
          limitVolumeMin: '0.00001',
          marketBuyMin: '10',
          marketSellMin: '0.0001',
          showName: 'BTC/USDT',
          sort: 1,
        },
        'ETH/USDT': {
          symbol: 'ethusdt',
          price: 2,
          volume: 4,
          name: 'ETH/USDT',
          depth: '0.000001,0.0001',
          limitPriceMin: '0.01',
          limitVolumeMin: '0.001',
          marketBuyMin: '10',
          marketSellMin: '0.001',
          sort: 2,
        },
      },
    },
  },
}

describe('market symbols', () => {
  it('projects the server market map into a flat, sorted symbol list', () => {
    const symbols = buildMarketSymbols(publicInfo)
    expect(symbols.map((entry) => entry.pair)).toEqual(['BTC/USDT', 'ETH/USDT'])
    expect(symbols[0].symbol).toBe('btcusdt')
    expect(symbols[0].base).toBe('BTC')
    expect(symbols[0].quote).toBe('USDT')
    expect(symbols[0].depthLevels).toEqual([0, 1, 2])
    expect(symbols[0].rules.marketBuyMin).toBe('10')
  })

  it('defaults to BTC/USDT and falls back to the first pair', () => {
    const symbols = buildMarketSymbols(publicInfo)
    expect(pickDefaultSymbol(symbols)?.pair).toBe('BTC/USDT')
    expect(findSymbolByPair(symbols, 'ethusdt')).toBeUndefined()
    expect(findSymbolByPair(symbols, 'ETH/usdt')?.symbol).toBe('ethusdt')
    expect(pickDefaultSymbol(symbols, 'DOGE/USDT')?.pair).toBe('BTC/USDT')
  })

  it('normalises kline scales and falls back when the server returns an empty string', () => {
    expect(normalizeKlineScales(publicInfo)).toEqual(['1min', '5min', '1day'])
    expect(normalizeKlineScales({ market: { klineScale: '' } })).toContain('30min')
    expect(normalizeKlineScales(null)).toContain('1day')
  })

  it('returns an empty list when public info has no market data', () => {
    expect(buildMarketSymbols(null)).toEqual([])
    expect(buildMarketSymbols({})).toEqual([])
  })

  it('looks up balances case-insensitively and never spends the special overcharge allocation', () => {
    const map = {
      btc: { normal_balance: '0.5', overcharge_balance: '0.25' },
      USDT: { normal_balance: '1000' },
    }
    expect(findCoinBalance(map, 'BTC')?.normal_balance).toBe('0.5')
    expect(findCoinBalance(map, 'usdt')?.normal_balance).toBe('1000')
    expect(findCoinBalance(map, 'DOGE')).toBeUndefined()
    expect(sellableBalance(findCoinBalance(map, 'BTC'))).toBe('0.5')
    expect(sellableBalance({ normal_balance: '5', overcharge_balance: '0' })).toBe('5')
    expect(sellableBalance({ normal_balance: '0', overcharge_balance: '5' })).toBe('0')
    expect(sellableBalance(findCoinBalance(map, 'USDT'))).toBe('1000')
    expect(sellableBalance(undefined)).toBe('')
  })

  it('uses canonical trading symbols instead of long currency descriptions', () => {
    const info = structuredClone(publicInfo)
    info.market!.market!.USDT['BTC/USDT'].showName = 'Bitcoin (synthetic stage)/Tether (synthetic stage)'
    expect(buildMarketSymbols(info)[0].showPair).toBe('BTC/USDT')
    info.market!.market!.USDT['BTC/USDT'].name = 'invalid'
    expect(buildMarketSymbols(info).map(row => row.pair)).toEqual(['ETH/USDT'])
  })
})

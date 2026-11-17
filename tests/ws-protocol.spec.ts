import { describe, expect, it } from 'vitest'
import {
  buildDepthRequest,
  buildKlineRequest,
  buildReviewRequest,
  buildTickerRequest,
  buildTradeRequest,
  depthChannel,
  klineChannel,
  pairToSymbol,
  parseChannel,
  tickerChannel,
  tradeChannel,
} from '@/modules/ws/protocol'
import { SubscriptionRegistry } from '@/modules/ws/subscription-registry'

describe('market ws protocol', () => {
  it('builds the documented channel names', () => {
    expect(pairToSymbol('BTC/USDT')).toBe('btcusdt')
    expect(tickerChannel('BTCUSDT')).toBe('market_btcusdt_ticker')
    expect(tradeChannel('btcusdt')).toBe('market_btcusdt_trade_ticker')
    expect(depthChannel('btcusdt', 8)).toBe('market_btcusdt_depth_step8')
    expect(klineChannel('btcusdt', '1min')).toBe('market_btcusdt_kline_1min')
  })

  it('sends the same envelopes the service expects', () => {
    expect(buildReviewRequest()).toEqual({ event: 'req', params: { channel: 'review' } })
    expect(buildTickerRequest('sub', 'BTCUSDT')).toEqual({
      event: 'sub',
      params: { channel: 'market_btcusdt_ticker', cb_id: 'btcusdt' },
    })
    expect(buildTradeRequest('sub', 'btcusdt', 60)).toEqual({
      event: 'sub',
      params: { channel: 'market_btcusdt_trade_ticker', cb_id: 'btcusdt', top: 60 },
    })
    expect(buildDepthRequest('sub', 'btcusdt', 4)).toEqual({
      event: 'sub',
      params: { channel: 'market_btcusdt_depth_step4', cb_id: 'btcusdt' },
    })
  })

  it('adds the kline pagination cursor only when a history page is requested', () => {
    expect(buildKlineRequest('sub', 'btcusdt', '1min')).toEqual({
      event: 'sub',
      params: { channel: 'market_btcusdt_kline_1min', cb_id: 'btcusdt' },
    })
    expect(buildKlineRequest('req', 'btcusdt', '1min', { pageSize: 300 })).toEqual({
      event: 'req',
      params: { channel: 'market_btcusdt_kline_1min', cb_id: 'btcusdt', pageSize: 300 },
    })
    expect(buildKlineRequest('req', 'btcusdt', '1min', { endIdx: 1700000000, pageSize: 50 })).toEqual({
      event: 'req',
      params: { channel: 'market_btcusdt_kline_1min', cb_id: 'btcusdt', endIdx: 1700000000, pageSize: 50 },
    })
  })

  it('parses inbound channels', () => {
    expect(parseChannel('market_btcusdt_ticker')).toEqual({ kind: 'ticker', symbol: 'btcusdt' })
    expect(parseChannel('market_btcusdt_trade_ticker')).toEqual({ kind: 'trade', symbol: 'btcusdt' })
    expect(parseChannel('market_btcusdt_depth_step8')).toEqual({
      kind: 'depth',
      symbol: 'btcusdt',
      depthLevel: '8',
    })
    expect(parseChannel('market_btcusdt_kline_30min')).toEqual({
      kind: 'kline',
      symbol: 'btcusdt',
      scale: '30min',
    })
    expect(parseChannel('review')).toEqual({ kind: 'review', symbol: '' })
    expect(parseChannel('unknown_channel')).toEqual({ kind: 'unknown', symbol: '' })
  })
})

describe('subscription registry', () => {
  it('keeps req and sub for the same channel apart and replays both', () => {
    const registry = new SubscriptionRegistry()
    registry.set('market_btcusdt_kline_1min', 'req', { channel: 'market_btcusdt_kline_1min' })
    registry.set('market_btcusdt_kline_1min', 'sub', { channel: 'market_btcusdt_kline_1min' })
    registry.set('market_btcusdt_ticker', 'sub', { channel: 'market_btcusdt_ticker' })

    expect(registry.list()).toHaveLength(3)
    expect(registry.has('market_btcusdt_kline_1min', 'req')).toBe(true)
    expect(registry.has('market_btcusdt_kline_1min', 'sub')).toBe(true)

    registry.delete('market_btcusdt_kline_1min')
    expect(registry.list()).toHaveLength(1)
    expect(registry.forChannel('market_btcusdt_kline_1min')).toHaveLength(0)
  })

  it('updates params in place for an existing subscription', () => {
    const registry = new SubscriptionRegistry()
    registry.set('market_btcusdt_trade_ticker', 'sub', { top: 20 })
    registry.set('market_btcusdt_trade_ticker', 'sub', { top: 60 })
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('market_btcusdt_trade_ticker', 'sub')?.params.top).toBe(60)
  })
})

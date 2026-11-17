import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { WsMessage } from '@/modules/ws/protocol'
import { depthChannel, klineChannel, parseChannel, tickerChannel, tradeChannel } from '@/modules/ws/protocol'
import { validateWsMessage } from '@/modules/ws/validation'
import { buildContract, contractWsSymbol, depthDigitToStep } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'

const sockets: { handler: ((message: WsMessage) => void) | null; channels: string[]; url: string }[] = []

vi.mock('@/modules/ws/kline-socket', () => ({
  KlineSocket: class {
    private readonly entry: { handler: ((message: WsMessage) => void) | null; channels: string[]; url: string }
    constructor(options: { url: string }) {
      this.entry = { handler: null, channels: [], url: options.url }
      sockets.push(this.entry)
    }
    get isOpen(): boolean { return true }
    get state(): string { return 'open' }
    connect(): void {}
    close(): void {}
    onMessage(handler: (message: WsMessage) => void): () => void { this.entry.handler = handler; return () => undefined }
    onStateChange(): () => void { return () => undefined }
    registerChannel(channel: string, _params: unknown, kind = 'sub'): void { this.entry.channels.push(`${kind}:${channel}`) }
    unsubscribe(channel: string): void { this.entry.channels = this.entry.channels.filter((entry) => !entry.endsWith(`:${channel}`)) }
    request(): () => void { return () => undefined }
  },
}))

describe('futures channel parsing', () => {
  it('builds the channel symbol from the contract name (legacy future.js)', () => {
    expect(contractWsSymbol('E-BTC-USDT')).toBe('e_btcusdt')
    expect(contractWsSymbol('e-eth-usdt')).toBe('e_ethusdt')
    expect(contractWsSymbol('BTC-USDT')).toBe('')
    expect(contractWsSymbol('E-BTC-US DT')).toBe('')
  })

  it('parses every futures channel with the underscore symbol', () => {
    expect(parseChannel(tickerChannel('e_btcusdt'))).toEqual({ kind: 'ticker', symbol: 'e_btcusdt' })
    expect(parseChannel(tradeChannel('e_btcusdt'))).toEqual({ kind: 'trade', symbol: 'e_btcusdt' })
    expect(parseChannel(depthChannel('e_btcusdt', 1))).toEqual({ kind: 'depth', symbol: 'e_btcusdt', depthLevel: '1' })
    expect(parseChannel(klineChannel('e_btcusdt', '15min'))).toEqual({ kind: 'kline', symbol: 'e_btcusdt', scale: '15min' })
  })

  it('keeps the spot channel shapes unchanged', () => {
    expect(parseChannel('market_btcusdt_ticker')).toEqual({ kind: 'ticker', symbol: 'btcusdt' })
    expect(parseChannel('market_btcusdt_trade_ticker')).toEqual({ kind: 'trade', symbol: 'btcusdt' })
    expect(parseChannel('market_btcusdt_depth_step8')).toEqual({ kind: 'depth', symbol: 'btcusdt', depthLevel: '8' })
    expect(parseChannel('market_btcusdt_kline_1day')).toEqual({ kind: 'kline', symbol: 'btcusdt', scale: '1day' })
    expect(parseChannel('review')).toEqual({ kind: 'review', symbol: '' })
    expect(parseChannel('something_else')).toEqual({ kind: 'unknown', symbol: '' })
  })

  it('validates futures payloads now that the channel kind is recognised', () => {
    expect(validateWsMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: '65000.5', rose: '-0.01' } })).not.toBeNull()
    expect(validateWsMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 'NaN' } })).toBeNull()
    expect(validateWsMessage({ channel: 'market_e_btcusdt_depth_step0', tick: { side: 'asks', price: '1', volume: '-2' } })).toBeNull()
  })

  it('maps depth precision digits to steps', () => {
    expect(depthDigitToStep('0')).toBe('1')
    expect(depthDigitToStep('1')).toBe('0.1')
    expect(depthDigitToStep('4')).toBe('0.0001')
    expect(depthDigitToStep('x')).toBe('')
  })
})

const PUBLIC_INFO = {
  wsUrl: '',
  currentTimeMillis: 1_700_000_000_000,
  marginCoinList: ['USDT'],
  contractList: [
    {
      id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', contractType: 'E', contractSide: 1, multiplier: 0.001,
      multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: 1, base: 'BTC', quote: 'USDT', maxLever: 100, minLever: 1,
      capitalStartTime: 0, capitalFrequency: 8, sort: 1,
      coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4, depth: ['1', '0'], minOrderVolume: 1, maxLimitVolume: 100000, fundsInStatus: 1, fundsOutStatus: 1 },
    },
  ],
}

describe('futures market store routing', () => {
  beforeEach(async () => {
    const { sharedSockets } = await import('@/modules/ws/shared-socket')
    sharedSockets.closeAll()
    sockets.length = 0
    localStorage.clear()
    setActivePinia(createPinia())
  })

  async function prepared(): Promise<ReturnType<typeof import('@/stores/futures-market')['useFuturesMarketStore']>> {
    const { useFuturesMarketStore } = await import('@/stores/futures-market')
    const market = useFuturesMarketStore()
    const info = normalizePublicInfo(PUBLIC_INFO)
    market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
    market.selectedName = 'E-BTC-USDT'
    market.loaded = true
    return market
  }

  it('keeps the fine depth channel and adds the coarse one for the chosen step', async () => {
    const market = await prepared()
    market.resubscribe()
    expect(sockets[0].url).toBe('wss://ws.exchange.invalid/futures-ws')
    expect(sockets[0].channels).toEqual(expect.arrayContaining([
      'sub:market_e_btcusdt_ticker', 'req:market_e_btcusdt_trade_ticker', 'sub:market_e_btcusdt_depth_step0',
    ]))
    // Options follow the price tick (symbolPricePrecision 1 -> 0.1), Binance style ×10 decades.
    expect(market.bookSteps).toEqual(['0.1', '1', '10', '100'])
    market.setDepthStepIndex(1)
    expect(sockets[0].channels).toContain('sub:market_e_btcusdt_depth_step1')
    expect(sockets[0].channels).toContain('sub:market_e_btcusdt_depth_step0')
    // Client-only step 10: the coarsest server channel stays the coarse source.
    market.setDepthStepIndex(2)
    expect(sockets[0].channels).toContain('sub:market_e_btcusdt_depth_step1')
    market.setDepthStepIndex(0)
    expect(sockets[0].channels).not.toContain('sub:market_e_btcusdt_depth_step1')
    expect(sockets[0].channels).toContain('sub:market_e_btcusdt_depth_step0')
  })

  it('groups the fine book client-side at a coarser step without blanking it', async () => {
    vi.useFakeTimers()
    const market = await prepared()
    market.resubscribe()
    const push = sockets[0].handler as (message: WsMessage) => void
    push({ channel: 'market_e_btcusdt_depth_step0', tick: { asks: [['65000.1', '1'], ['65000.9', '2'], ['65003.2', '4']], buys: [['64999.9', '1'], ['64999.1', '3'], ['64991', '5']] } })
    vi.advanceTimersByTime(250)
    expect(market.asks).toHaveLength(3)
    market.setDepthStepIndex(2)
    // Regrouped at once from the fine book (asks round up, bids round down).
    expect(market.asks.map((row) => [row.price, row.amount, row.total])).toEqual([['65010', '7', '7']])
    expect(market.buys.map((row) => [row.price, row.amount, row.total])).toEqual([['64990', '9', '9']])
    // The coarse channel only adds levels beyond the fine range.
    push({ channel: 'market_e_btcusdt_depth_step1', tick: { asks: [['65001', '3'], ['65040', '6']], buys: [['64999', '4'], ['64950', '8']] } })
    vi.advanceTimersByTime(250)
    expect(market.asks.map((row) => [row.price, row.total])).toEqual([['65010', '7'], ['65040', '13']])
    expect(market.buys.map((row) => [row.price, row.total])).toEqual([['64990', '9'], ['64950', '17']])
    vi.useRealTimers()
  })

  it('exposes the mark price for the book mid row', async () => {
    const market = await prepared()
    market.marketInfo = { tagPrice: '65000.3', indexPrice: '', currentFundRate: '', nextFundRate: '' }
    expect(market.markPrice).toBe('65000.3')
  })

  it('shares one futures socket between the store and a chart lease', async () => {
    const market = await prepared()
    market.resubscribe()
    const { sharedSockets } = await import('@/modules/ws/shared-socket')
    const chart = sharedSockets.acquire(market.chartWsUrl())
    expect(sockets).toHaveLength(1)
    chart.release()
    market.disconnect()
  })

  it('routes ticker, trades and book frames for e_btcusdt only', async () => {
    vi.useFakeTimers()
    const market = await prepared()
    market.resubscribe()
    const push = sockets[0].handler as (message: WsMessage) => void
    push({ channel: 'market_e_btcusdt_ticker', tick: { close: '65000.5', high: '66000', low: '64000', vol: '1200', amount: '78000000', rose: '0.012', open: '64200' } })
    push({ channel: 'market_e_ethusdt_ticker', tick: { close: '3000' } })
    expect(market.ticker.close).toBe('65000.5')
    push({ channel: 'market_e_btcusdt_trade_ticker', event_rep: 'rep', data: [{ price: '65000', vol: '3', side: 'BUY', ts: 2 }, { price: '64999', vol: '1', side: 'SELL', ts: 1 }] })
    expect(market.trades.map((trade) => trade.ts)).toEqual([2, 1])
    push({ channel: 'market_e_btcusdt_depth_step0', tick: { asks: [['65001', '4'], ['65002', '1']], buys: [['64999', '2']] } })
    push({ channel: 'market_e_btcusdt_depth_step1', tick: { asks: [['1', '1']], buys: [] } })
    vi.advanceTimersByTime(250)
    expect(market.asks.map((row) => [row.price, row.total])).toEqual([['65001', '4'], ['65002', '5']])
    expect(market.buys[0].price).toBe('64999')
    vi.useRealTimers()
  })

  it('exposes a contract-unit MarketSource symbol and chart channel resolver', async () => {
    const market = await prepared()
    expect(market.currentSymbol?.symbol).toBe('e_btcusdt')
    expect(market.currentSymbol?.rules.depthSteps).toEqual(['0.1', '1'])
    expect(market.chartChannelSymbol({ ticker: 'E-BTC-USDT', pricePrecision: 1, volumePrecision: 0 })).toBe('e_btcusdt')
  })

  it('never shows the WS amount: trade value = vol x multiplier x price, turnover = amount x multiplier (L43)', async () => {
    const market = await prepared()
    market.resubscribe()
    const push = sockets[0].handler as (message: WsMessage) => void
    // Live futures-wss frames: `amount` = vol * price (13 * 84213.13 = 1094770.69), face value missing.
    push({ channel: 'market_e_btcusdt_trade_ticker', event_rep: 'rep', data: [{ price: '84213.13', vol: '13', amount: '1094770.69', side: 'SELL', ts: 1 }] })
    expect(market.trades[0].amount).toBe('1094.77069')
    push({ channel: 'market_e_btcusdt_trade_ticker', tick: { data: [{ price: '65000', vol: '2', amount: '130000', side: 'BUY', ts: 2 }] } })
    expect(market.trades[0].amount).toBe('130')
    push({ channel: 'market_e_btcusdt_ticker', tick: { close: '84030.17', vol: '525', amount: '44167755.6', rose: '0' } })
    expect(market.ticker.amount).toBe('44167.7556')
    push({ channel: 'review', data: { e_btcusdt: { close: '1', vol: '1', amount: '1000' }, e_zzzusdt: { close: '1', amount: '5' } } })
    expect(market.tickers.e_btcusdt.amount).toBe('1')
    // Unknown contract: no multiplier, so no turnover instead of a 1/multiplier-too-large number.
    expect(market.tickers.e_zzzusdt.amount).toBe('')
    expect(market.currentSymbol?.valueMultiplier).toBe('0.001')
  })
})

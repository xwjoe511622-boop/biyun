import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { WsMessage } from '@/modules/ws/protocol'

interface MockSocket {
  handler: ((message: WsMessage) => void) | null
  channels: string[]
  requests: { channel: string; params: Record<string, unknown>; onSettle: (outcome: string, message?: WsMessage) => void }[]
  sent: { event: string; params: Record<string, unknown> }[]
  closed: boolean
}
const sockets: MockSocket[] = []

vi.mock('@/modules/ws/kline-socket', () => ({
  KlineSocket: class {
    private readonly entry: MockSocket = { handler: null, channels: [], requests: [], sent: [], closed: false }
    constructor() { sockets.push(this.entry) }
    get isOpen(): boolean { return true }
    get state(): string { return 'open' }
    connect(): void {}
    close(): void { this.entry.closed = true }
    onMessage(handler: (message: WsMessage) => void): () => void { this.entry.handler = handler; return () => undefined }
    onStateChange(): () => void { return () => undefined }
    registerChannel(channel: string, _params: unknown, kind = 'sub'): void {
      if (!this.entry.channels.includes(`${kind}:${channel}`)) this.entry.channels.push(`${kind}:${channel}`)
    }
    unsubscribe(channel: string): void { this.entry.channels = this.entry.channels.filter((entry) => !entry.endsWith(`:${channel}`)) }
    send(payload: { event: string; params: Record<string, unknown> }): boolean { this.entry.sent.push(payload); return true }
    request(channel: string, params: Record<string, unknown>, options: { onSettle: MockSocket['requests'][number]['onSettle'] }): () => void {
      this.entry.requests.push({ channel, params, onSettle: options.onSettle })
      return () => undefined
    }
  },
}))

const { useMarketStore, REVIEW_REFRESH_MS, TICKER_PUBLISH_INTERVAL_MS, TREND_TTL_MS, TREND_CONCURRENCY } = await import('@/stores/market')
const { sharedSockets } = await import('@/modules/ws/shared-socket')
const { compactDecimal } = await import('@/modules/finance/display')

const BTC = { close: '102', open: '100', high: '104', low: '99', vol: '0.053', amount: '5.41', rose: '0.02' }

function prepare(mode: 'overview' | 'terminal' = 'terminal'): { market: ReturnType<typeof useMarketStore>; stop: () => void } {
  const market = useMarketStore()
  market.publicInfo = {
    market: { market: { USDT: {
      'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01' },
      'ETH/USDT': { symbol: 'ethusdt', name: 'ETH/USDT', price: 2, volume: 4, depth: '0.01' },
    } } },
  }
  market.selectedPair = 'BTC/USDT'
  const stop = market.start(mode)
  return { market, stop }
}

describe('market store — all-pair tickers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sharedSockets.closeAll()
    sessionStorage.clear()
    sockets.length = 0
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes the review channel with the pair channels on the terminal, and no K-line', () => {
    prepare('terminal')
    expect(sockets[0].channels).toEqual(expect.arrayContaining(['req:review', 'sub:review', 'sub:market_btcusdt_ticker', 'sub:market_btcusdt_depth_step0']))
    expect(sockets[0].channels.some((entry) => entry.includes('kline'))).toBe(false)
  })

  it('subscribes only the review channel on overview pages', () => {
    prepare('overview')
    expect(sockets[0].channels).toEqual(['req:review', 'sub:review'])
  })

  it('QA-003: re-requests the review snapshot while shown (the server never broadcasts it) and stops on leave', () => {
    const { stop } = prepare('overview')
    expect(sockets[0].sent).toHaveLength(0)
    vi.advanceTimersByTime(REVIEW_REFRESH_MS * 3)
    expect(sockets[0].sent).toHaveLength(3)
    expect(sockets[0].sent[0]).toMatchObject({ event: 'req', params: { channel: 'review' } })
    stop()
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(REVIEW_REFRESH_MS * 3)
    expect(sockets[0].sent).toHaveLength(3)
  })

  it('QA-003: a review row never overwrites the selected pair once its own ticker channel delivered', () => {
    const { market } = prepare('terminal')
    sockets[0].handler?.({ channel: 'market_btcusdt_ticker', tick: { ...BTC, close: '105' } } as WsMessage)
    sockets[0].handler?.({ channel: 'review', event_rep: 'rep', data: { btcusdt: BTC, ethusdt: { ...BTC, close: '3' } } } as WsMessage)
    vi.advanceTimersByTime(TICKER_PUBLISH_INTERVAL_MS * 2)
    expect(market.tickers.btcusdt.close).toBe('105')
    expect(market.tickers.ethusdt.close).toBe('3')
  })

  it('reuses one socket from home to trade and upgrades the channel set', () => {
    const { market, stop } = prepare('overview')
    stop()
    const stopTrade = market.start('terminal')
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(false)
    expect(sockets[0].channels).toContain('sub:market_btcusdt_ticker')
    stopTrade()
    vi.advanceTimersByTime(60_000)
    expect(sockets[0].closed).toBe(true)
  })

  it('keeps every pair from a review reply and still drives the current ticker', () => {
    const { market } = prepare()
    sockets[0].handler?.({
      channel: 'review',
      event_rep: 'rep',
      data: {
        btcusdt: BTC,
        ETHUSDT: { close: '3.5', open: '3', high: '4', low: '3', vol: '10', amount: '35', rose: '-0.01' },
      },
    } as WsMessage)
    expect(market.tickers.btcusdt.close).toBe('102')
    expect(market.tickers.ethusdt.rose).toBe('-0.01')
    expect(market.ticker.close).toBe('102')
    expect(market.tickerReceived).toBe(true)
    expect(market.tickerLive).toBe(true)
  })

  it('accepts review pushes carried in `tick` and merges instead of replacing', () => {
    const { market } = prepare()
    const handler = sockets[0].handler
    handler?.({ channel: 'review', data: { ethusdt: { close: '3', open: '3', high: '3', low: '3', vol: '1', amount: '3', rose: '0' } } } as WsMessage)
    handler?.({ channel: 'review', tick: { btcusdt: { close: '101', open: '100', high: '101', low: '100', vol: '1', amount: '101', rose: '0.01' } } } as WsMessage)
    vi.advanceTimersByTime(TICKER_PUBLISH_INTERVAL_MS)
    expect(Object.keys(market.tickers).sort()).toEqual(['btcusdt', 'ethusdt'])
  })

  it('mirrors the subscribed pair ticker into the all-pair map', () => {
    const { market } = prepare()
    sockets[0].handler?.({ channel: 'market_btcusdt_ticker', tick: { close: '105', open: '100', high: '106', low: '99', vol: '2', amount: '210', rose: '0.05' } } as WsMessage)
    expect(market.tickers.btcusdt.close).toBe('105')
  })

  it('publishes the first ticker at once and caps later updates at 4 Hz', () => {
    const { market } = prepare('overview')
    const push = (close: string): void => sockets[0].handler?.({ channel: 'review', data: { btcusdt: { ...BTC, close } } } as WsMessage)
    push('1')
    expect(market.ticker.close).toBe('1')
    push('2')
    push('3')
    expect(market.ticker.close).toBe('1')
    vi.advanceTimersByTime(TICKER_PUBLISH_INTERVAL_MS)
    expect(market.ticker.close).toBe('3')
  })

  it('shows the cached tickers of this session before the stream answers', () => {
    const { market, stop } = prepare('overview')
    sockets[0].handler?.({ channel: 'review', data: { btcusdt: BTC } } as WsMessage)
    stop()
    setActivePinia(createPinia())
    const fresh = useMarketStore()
    expect(fresh.tickers.btcusdt?.close).toBe('102')
    expect(fresh.tickerLive).toBe(false)
    expect(market.tickerLive).toBe(false)
  })

  it('shows the selected pair price from the review stream before public info has loaded', () => {
    const market = useMarketStore()
    market.start('overview')
    sockets[0].handler?.({ channel: 'review', data: { btcusdt: BTC } } as WsMessage)
    expect(market.publicInfo).toBeNull()
    expect(market.ticker.close).toBe('102')
    expect(market.tickerReceived).toBe(true)
  })

  it('loads the sparkline with one K-line req and no subscription', () => {
    const { market } = prepare('overview')
    market.loadTrend()
    market.loadTrend()
    expect(sockets[0].requests).toHaveLength(1)
    expect(sockets[0].requests[0].channel).toBe('market_btcusdt_kline_60min')
    expect(sockets[0].channels.some((entry) => entry.includes('kline'))).toBe(false)
    sockets[0].requests[0].onSettle('ok', { channel: 'market_btcusdt_kline_60min', event_rep: 'rep', data: [
      { id: 1, open: '1', high: '2', low: '1', close: '1.5', vol: '1' },
      { id: 2, open: '1', high: '2', low: '1', close: '1.75', vol: '1' },
    ] })
    expect(market.trend).toEqual([1.5, 1.75])
  })
})

function bars(...closes: string[]): WsMessage {
  return { channel: 'kline', event_rep: 'rep', data: closes.map((close, id) => ({ id, open: close, high: close, low: close, close, vol: '1' })) } as WsMessage
}

function preparePairs(pairs: string[]): { market: ReturnType<typeof useMarketStore>; stop: () => void } {
  const market = useMarketStore()
  const book: Record<string, unknown> = {}
  pairs.forEach((pair) => { book[pair] = { symbol: pair.replace('/', '').toLowerCase(), name: pair, price: 2, volume: 4, depth: '0.01' } })
  market.publicInfo = { market: { market: { USDT: book } } } as never
  market.selectedPair = pairs[0]
  const stop = market.start('overview')
  return { market, stop }
}

describe('market store — per-pair trends for the market list', () => {
  const PAIRS = ['BTC/USDT', 'ETH/USDT', 'XAUT/USDT', 'NVDA/USDT', 'TSLA/USDT']
  const SYMBOLS = PAIRS.map((pair) => pair.replace('/', '').toLowerCase())

  beforeEach(() => {
    vi.useFakeTimers()
    sharedSockets.closeAll()
    sessionStorage.clear()
    sockets.length = 0
    setActivePinia(createPinia())
  })
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    vi.useRealTimers()
  })

  it('loads every visible pair with one-shot K-line reqs, two at a time, and no subscription', () => {
    const { market } = preparePairs(PAIRS)
    market.loadTrends(SYMBOLS)
    const requests = sockets[0].requests
    expect(requests).toHaveLength(TREND_CONCURRENCY)
    expect(sockets[0].channels.some((entry) => entry.includes('kline'))).toBe(false)
    let answered = 0
    while (answered < requests.length) {
      requests[answered].onSettle('ok', bars('1', '2', '3'))
      answered += 1
    }
    expect(requests.map((entry) => entry.channel)).toEqual(SYMBOLS.map((symbol) => `market_${symbol}_kline_60min`))
    SYMBOLS.forEach((symbol) => expect(market.trends[symbol]).toEqual([1, 2, 3]))
  })

  it('marks a pair with no K-line data as empty (not loading) and keeps the others', () => {
    const { market } = preparePairs(PAIRS.slice(0, 2))
    market.loadTrends(SYMBOLS.slice(0, 2))
    sockets[0].requests[0].onSettle('ok', bars('5', '6'))
    sockets[0].requests[1].onSettle('ok', bars())
    expect(market.trends.btcusdt).toEqual([5, 6])
    expect(market.trends.ethusdt).toEqual([])
  })

  it('caches per pair for the TTL, then refreshes, and retries a failed pair', () => {
    const { market } = preparePairs(PAIRS.slice(0, 2))
    market.loadTrends(SYMBOLS.slice(0, 2))
    sockets[0].requests[0].onSettle('ok', bars('1', '2'))
    sockets[0].requests[1].onSettle('timeout')
    expect(market.trends.ethusdt).toBeUndefined()
    market.loadTrends(SYMBOLS.slice(0, 2))
    // btc is fresh; eth failed and is asked again.
    expect(sockets[0].requests.map((entry) => entry.channel).slice(2)).toEqual(['market_ethusdt_kline_60min'])
    sockets[0].requests[2].onSettle('ok', bars('3', '4'))
    vi.advanceTimersByTime(TREND_TTL_MS + 1)
    expect(sockets[0].requests.slice(3).map((entry) => entry.channel)).toEqual(['market_btcusdt_kline_60min', 'market_ethusdt_kline_60min'])
  })

  it('requests only the pairs on screen and drops queued pairs that left the view', () => {
    const { market } = preparePairs(PAIRS)
    market.loadTrends(SYMBOLS)
    market.loadTrends(['btcusdt'])
    sockets[0].requests.forEach((entry) => entry.onSettle('ok', bars('1', '2')))
    expect(sockets[0].requests.map((entry) => entry.channel)).toEqual(['market_btcusdt_kline_60min', 'market_ethusdt_kline_60min'])
  })

  it('pauses while the tab is hidden and resumes when it is visible again', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const { market } = preparePairs(PAIRS.slice(0, 2))
    market.loadTrends(SYMBOLS.slice(0, 2))
    expect(sockets[0].requests).toHaveLength(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sockets[0].requests).toHaveLength(2)
  })

  it('queues a list set up before the page took the stream and starts it on start()', () => {
    const market = useMarketStore()
    market.loadTrends(['btcusdt', 'ethusdt'])
    expect(sockets).toHaveLength(0)
    market.start('overview')
    expect(sockets[0].requests).toHaveLength(2)
  })

  it('shares the hero request with the list (one request per pair)', () => {
    const { market } = preparePairs(PAIRS.slice(0, 2))
    market.loadTrend()
    market.loadTrends(SYMBOLS.slice(0, 2))
    expect(sockets[0].requests.map((entry) => entry.channel)).toEqual(['market_btcusdt_kline_60min', 'market_ethusdt_kline_60min'])
  })
})

describe('compactDecimal', () => {
  it('abbreviates large values and never renders missing data as zero', () => {
    expect(compactDecimal('48213345.12')).toBe('48.21M')
    expect(compactDecimal('12345.6')).toBe('12.34K') // Decimal is configured to truncate, never round up
    expect(compactDecimal('5.41')).toBe('5.41')
    expect(compactDecimal('0.0530')).toBe('0.053')
    expect(compactDecimal('')).toBe('--')
    expect(compactDecimal('abc')).toBe('--')
  })
})

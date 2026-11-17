import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KLineData, SymbolInfo } from 'klinecharts'
import {
  KLINE_PAGE_SIZE,
  channelSymbol,
  convertKlineBar,
  countValidBars,
  createKlineDatafeed,
  normalizeBarBatch,
  periodToScale,
  scaleToPeriod,
} from '@/modules/charts/kline-datafeed'
import { KlineSocket, REQUEST_SINK_GRACE_MS, type Transport } from '@/modules/ws/kline-socket'
import { SharedSocketPool } from '@/modules/ws/shared-socket'
import { DEFAULT_KLINE_SCALES } from '@/modules/market/symbols'

const URL_ = 'wss://example.test/kline'
const SYMBOL: SymbolInfo = { ticker: 'btcusdt', pricePrecision: 2, volumePrecision: 6 }
const ETH: SymbolInfo = { ticker: 'ethusdt', pricePrecision: 2, volumePrecision: 6 }
const MINUTE_30 = { type: 'minute', span: 30 } as const
const BTC_CHANNEL = 'market_btcusdt_kline_30min'
const ETH_CHANNEL = 'market_ethusdt_kline_30min'

interface SentFrame {
  event: string
  params: Record<string, unknown>
}

/** A well-formed exchange row, with `id` in seconds. */
function barRow(id: number): Record<string, string | number> {
  return { id, open: '1', high: '2', low: '1', close: '1.5', vol: '1' }
}

/** Fake WebSocket transport under a real `KlineSocket` + shared pool. */
class FakeTransport implements Transport {
  readyState = 0
  sent: string[] = []
  closeCalls = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((data: ArrayBuffer | string) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(message))
  }

  frames(): SentFrame[] {
    return this.sent.map((frame) => JSON.parse(frame) as SentFrame)
  }

  requests(): SentFrame[] {
    return this.frames().filter((frame) => frame.event === 'req')
  }
}

interface HarnessOptions {
  timeoutMs?: number
  /** When false the shared socket starts connecting and the test opens it. */
  open?: boolean
}

interface Harness {
  pool: SharedSocketPool
  /** Every transport the shared socket created, oldest first. */
  transports: FakeTransport[]
  transport: () => FakeTransport
  feed: ReturnType<typeof createKlineDatafeed>
  statuses: string[]
  history: string[]
  reconnectCount: () => number
}

function harness(options: HarnessOptions = {}): Harness {
  const transports: FakeTransport[] = []
  const pool = new SharedSocketPool({
    graceMs: 1_000,
    createSocket: (socketOptions) =>
      new KlineSocket({
        ...socketOptions,
        heartbeatIntervalMs: 60_000,
        random: () => 0,
        transportFactory: () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        },
      }),
  })
  const statuses: string[] = []
  const history: string[] = []
  let reconnects = 0
  const feed = createKlineDatafeed({
    url: URL_,
    acquireSocket: (url) => pool.acquire(url),
    requestTimeoutMs: options.timeoutMs ?? 15_000,
    onStatus: (status) => {
      statuses.push(status)
    },
    onReconnect: () => {
      reconnects += 1
    },
    onHistory: (type, bars) => {
      history.push(`${type}:${bars}`)
    },
  })
  if (options.open ?? true) transports[0].open()
  return {
    pool,
    transports,
    transport: () => transports[transports.length - 1],
    feed,
    statuses,
    history,
    reconnectCount: () => reconnects,
  }
}

function reply(transport: FakeTransport, channel: string, data: unknown[]): void {
  transport.emit({ channel, event_rep: 'rep', data })
}

function getBars(feed: Harness['feed'], symbol: SymbolInfo, type: 'init' | 'forward' | 'backward', timestamp: number | null, sink: KLineData[][], more?: unknown[]): void {
  feed.dataLoader.getBars({
    type,
    timestamp,
    symbol,
    period: MINUTE_30,
    callback: (bars, loadMore) => {
      sink.push(bars)
      more?.push(loadMore)
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('kline bar conversion', () => {
  it('converts exchange seconds to chart milliseconds and keeps exact prices', () => {
    const bar = convertKlineBar({ id: 1790360400, open: '100', high: '104', low: '99', close: '102', vol: 1e-8 })
    expect(bar).toEqual({ timestamp: 1790360400000, open: 100, high: 104, low: 99, close: 102, volume: 0.00000001 })
  })

  it('rejects malformed OHLC and non finite values instead of inventing candles', () => {
    expect(convertKlineBar({ id: 1, open: '100', high: '90', low: '99', close: '102', vol: 0 })).toBeNull()
    expect(convertKlineBar({ id: 1, open: '100', high: '104', low: '99', close: '102', vol: -1 })).toBeNull()
    expect(convertKlineBar({ id: 1, open: '100', high: '104', low: '99', close: '102', vol: 'NaN' })).toBeNull()
    expect(convertKlineBar({ id: 1, open: '100', high: '104', low: '99', close: '102', vol: '' })).toBeNull()
    expect(convertKlineBar({ id: 0, open: '100', high: '104', low: '99', close: '102', vol: 0 })).toBeNull()
    expect(convertKlineBar(null)).toBeNull()
  })

  it('normalizes a page into unique, ascending bars', () => {
    const bars = normalizeBarBatch([
      { id: 3, open: '3', high: '4', low: '2', close: '3', vol: 1 },
      { id: 1, open: '1', high: '2', low: '1', close: '2', vol: 1 },
      { id: 3, open: '3', high: '5', low: '2', close: '4', vol: 2 },
      { id: 2, open: '2', high: '3', low: '2', close: '3', vol: 1 },
    ])
    expect(bars.map((bar) => bar.timestamp)).toEqual([1000, 2000, 3000])
    expect(bars[2].high).toBe(5)
  })

  it('drops bars that overlap the range already on the chart', () => {
    const page = [
      { id: 1, open: '1', high: '1', low: '1', close: '1', vol: 0 },
      { id: 2, open: '2', high: '2', low: '2', close: '2', vol: 0 },
      { id: 3, open: '3', high: '3', low: '3', close: '3', vol: 0 },
    ]
    expect(normalizeBarBatch(page, { olderThan: 2000 }).map((bar) => bar.timestamp)).toEqual([1000])
    expect(normalizeBarBatch(page, { newerThan: 2000 }).map((bar) => bar.timestamp)).toEqual([3000])
    expect(countValidBars(page)).toBe(3)
    expect(countValidBars('nope')).toBe(0)
  })
})

describe('scale mapping', () => {
  it('round trips every configured scale', () => {
    DEFAULT_KLINE_SCALES.forEach((scale) => {
      const period = scaleToPeriod(scale)
      expect(period, scale).not.toBeNull()
      expect(periodToScale(period)).toBe(scale)
    })
  })

  it('maps the exchange scales the UI exposes', () => {
    expect(scaleToPeriod('30min')).toEqual({ type: 'minute', span: 30 })
    expect(scaleToPeriod('4h')).toEqual({ type: 'hour', span: 4 })
    expect(scaleToPeriod('1day')).toEqual({ type: 'day', span: 1 })
    expect(scaleToPeriod('1month')).toEqual({ type: 'month', span: 1 })
    expect(scaleToPeriod('7min')).toBeNull()
    expect(periodToScale({ type: 'minute', span: 7 })).toBeNull()
    expect(periodToScale(null)).toBeNull()
  })

  it('normalizes display pairs and tickers to the channel symbol', () => {
    expect(channelSymbol({ ticker: 'BTC/USDT', pricePrecision: 2, volumePrecision: 4 })).toBe('btcusdt')
    expect(channelSymbol({ ticker: 'BTC_USDT', pricePrecision: 2, volumePrecision: 4 })).toBe('btcusdt')
    expect(channelSymbol({ ticker: '', pricePrecision: 2, volumePrecision: 4 })).toBe('')
    expect(channelSymbol(null)).toBe('')
  })
})

describe('history loading', () => {
  it('requests the newest page on init over the shared socket and sorts the reply', () => {
    const { feed, transports } = harness()
    const received: KLineData[][] = []
    const more: unknown[] = []
    getBars(feed, SYMBOL, 'init', null, received, more)

    // One socket for everything: no per-page connection.
    expect(transports).toHaveLength(1)
    expect(transports[0].requests()).toEqual([
      { event: 'req', params: { channel: BTC_CHANNEL, cb_id: 'btcusdt', pageSize: KLINE_PAGE_SIZE } },
    ])

    reply(transports[0], BTC_CHANNEL, [
      { id: 1790360700, open: '102', high: '103', low: '101', close: '102.5', vol: '2' },
      { id: 1790360400, open: '100', high: '104', low: '99', close: '102', vol: '1' },
    ])

    expect(received).toHaveLength(1)
    expect(received[0].map((bar) => bar.timestamp)).toEqual([1790360400000, 1790360700000])
    expect(more[0]).toEqual({ forward: false, backward: false })
    expect(transports[0].closeCalls).toBe(0)
  })

  it('waits for the socket to open before sending the single req', () => {
    const { feed, transports } = harness({ open: false })
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, received)
    expect(transports[0].sent).toHaveLength(0)
    transports[0].open()
    expect(transports[0].requests()).toHaveLength(1)
  })

  it('reports an empty init page so the chart can say history is missing (futures: 0 bars)', () => {
    const { feed, transports, history, statuses } = harness()
    getBars(feed, SYMBOL, 'init', null, [])
    reply(transports[0], BTC_CHANNEL, [])
    expect(history).toEqual(['init:0'])
    expect(statuses).toContain('empty')
    getBars(feed, SYMBOL, 'init', null, [])
    reply(transports[0], BTC_CHANNEL, [barRow(1790360400)])
    expect(history).toEqual(['init:0', 'init:1'])
  })

  it('paginates older history with endIdx converted from milliseconds to seconds', () => {
    const { feed, transports } = harness()
    getBars(feed, SYMBOL, 'init', null, [])
    reply(transports[0], BTC_CHANNEL, [])

    getBars(feed, SYMBOL, 'forward', 1790360400000, [])
    expect(transports[0].requests()[1]).toEqual({
      event: 'req',
      params: { channel: BTC_CHANNEL, cb_id: 'btcusdt', endIdx: 1790360400, pageSize: KLINE_PAGE_SIZE },
    })
  })

  it('reports older history only for a full page and never past the cursor', () => {
    const { feed, transports } = harness()
    const received: KLineData[][] = []
    const more: unknown[] = []
    const newest = 1_790_360_400_000
    getBars(feed, SYMBOL, 'forward', newest, received, more)

    const page = Array.from({ length: KLINE_PAGE_SIZE }, (_value, index) => barRow(newest / 1000 - index * 1800))
    reply(transports[0], BTC_CHANNEL, page)

    // The cursor bar itself belongs to the page already on the chart.
    expect(received[0]).toHaveLength(KLINE_PAGE_SIZE - 1)
    expect(more[0]).toEqual({ forward: true, backward: false })

    // A short page means the server has nothing older.
    getBars(feed, SYMBOL, 'forward', 1_700_000_100_000, received, more)
    reply(transports[0], BTC_CHANNEL, [barRow(1_700_000_000)])
    expect(more[1]).toEqual({ forward: false, backward: false })
  })

  it('loads newer bars from the newest page and stops once it reaches the live end', () => {
    const { feed, transports } = harness()
    const received: KLineData[][] = []
    const more: unknown[] = []
    const cursor = 1_790_360_400_000
    const step = 1_800_000
    getBars(feed, SYMBOL, 'backward', cursor, received, more)

    // `endIdx` pages backwards (older rows), so newer loading must ask for the newest page.
    expect(transports[0].requests()[0]).toEqual({
      event: 'req',
      params: { channel: BTC_CHANNEL, cb_id: 'btcusdt', pageSize: KLINE_PAGE_SIZE },
    })
    const newerPage = Array.from({ length: KLINE_PAGE_SIZE }, (_value, index) => barRow(cursor / 1000 + (index + 1) * 1800))
    reply(transports[0], BTC_CHANNEL, newerPage)
    expect(received[0]).toHaveLength(KLINE_PAGE_SIZE)
    expect(received[0].every((bar) => bar.timestamp > cursor)).toBe(true)
    expect(received[0][0].timestamp).toBe(cursor + step)
    expect(more[0]).toEqual({ forward: false, backward: true })

    const reachedPage = Array.from({ length: KLINE_PAGE_SIZE }, (_value, index) => barRow(cursor / 1000 - 1800 + index * 1800))
    getBars(feed, SYMBOL, 'backward', cursor, received, more)
    reply(transports[0], BTC_CHANNEL, reachedPage)
    expect(received[1]).toHaveLength(KLINE_PAGE_SIZE - 2)
    expect(received[1].every((bar) => bar.timestamp > cursor)).toBe(true)
    expect(more[1]).toEqual({ forward: false, backward: false })
  })

  it('ignores replies for another channel and never lets a settled page answer again', () => {
    const { feed, transports } = harness()
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, received)

    reply(transports[0], ETH_CHANNEL, [barRow(1)])
    expect(received).toHaveLength(0)
    reply(transports[0], BTC_CHANNEL, [barRow(2)])
    expect(received).toHaveLength(1)
    reply(transports[0], BTC_CHANNEL, [barRow(3)])
    expect(received).toHaveLength(1)
  })

  it('settles a page on timeout with an error and keeps the shared socket open', () => {
    const { feed, statuses, transports } = harness({ timeoutMs: 1_000 })
    const received: KLineData[][] = []
    const more: unknown[] = []
    getBars(feed, SYMBOL, 'init', null, received, more)

    vi.advanceTimersByTime(1_001)
    expect(received).toEqual([[]])
    expect(more[0]).toEqual({ forward: false, backward: false })
    expect(statuses.at(-1)).toBe('error')
    // The bug this replaces closed/reopened a socket on every timeout.
    expect(transports).toHaveLength(1)
    expect(transports[0].closeCalls).toBe(0)
  })

  it('requires a cursor for pagination instead of sending a naive request', () => {
    const { feed, transports } = harness()
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'forward', null, received)
    expect(transports[0].requests()).toHaveLength(0)
    expect(received).toEqual([[]])
  })
})

describe('request correlation on the shared socket', () => {
  it('never lets a late A-B-A frame enter the new series', () => {
    const { feed, transports } = harness()
    const firstA: KLineData[][] = []
    const forB: KLineData[][] = []
    const secondA: KLineData[][] = []
    const transport = transports[0]

    getBars(feed, SYMBOL, 'init', null, firstA)
    getBars(feed, ETH, 'init', null, forB)
    // The superseded btcusdt page settles empty before switching.
    expect(firstA).toEqual([[]])

    getBars(feed, SYMBOL, 'init', null, secondA)
    expect(forB).toEqual([[]])
    // The second btcusdt req waits: the first one is still on the wire for the same channel.
    expect(transport.requests().filter((frame) => frame.params.channel === BTC_CHANNEL)).toHaveLength(1)

    // The late reply to the first btcusdt req is swallowed, then the fresh req goes out.
    reply(transport, BTC_CHANNEL, [barRow(1_000_000)])
    expect(secondA).toEqual([])
    expect(transport.requests().filter((frame) => frame.params.channel === BTC_CHANNEL)).toHaveLength(2)

    reply(transport, BTC_CHANNEL, [barRow(2_000_000)])
    expect(secondA).toHaveLength(1)
    expect(secondA[0][0].timestamp).toBe(2_000_000_000)
  })

  it('does not let a timed-out request answer a later one', () => {
    const { feed, transports } = harness({ timeoutMs: 1_000 })
    const first: KLineData[][] = []
    const second: KLineData[][] = []
    const transport = transports[0]
    getBars(feed, SYMBOL, 'init', null, first)
    vi.advanceTimersByTime(1_001)
    expect(first).toEqual([[]])

    getBars(feed, SYMBOL, 'init', null, second)
    // The timed-out req still owns the channel for its grace window.
    expect(transport.requests()).toHaveLength(1)
    reply(transport, BTC_CHANNEL, [barRow(1_000_000)])
    expect(second).toEqual([])
    expect(transport.requests()).toHaveLength(2)

    reply(transport, BTC_CHANNEL, [barRow(2_000_000)])
    expect(second).toHaveLength(1)
    expect(second[0][0].timestamp).toBe(2_000_000_000)
  })

  it('frees the channel after the grace window when a timed-out reply never comes', () => {
    const { feed, transports } = harness({ timeoutMs: 10_000 })
    const second: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, [])
    vi.advanceTimersByTime(10_001)
    getBars(feed, SYMBOL, 'init', null, second)
    expect(transports[0].requests()).toHaveLength(1)
    vi.advanceTimersByTime(REQUEST_SINK_GRACE_MS)
    expect(transports[0].requests()).toHaveLength(2)
    reply(transports[0], BTC_CHANNEL, [barRow(2_000_000)])
    expect(second).toHaveLength(1)
  })

  it('fails an in-flight page when the transport drops and never re-sends it', () => {
    const { feed, transports, statuses } = harness()
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, received)
    expect(transports[0].requests()).toHaveLength(1)

    transports[0].drop()
    expect(received).toEqual([[]])
    expect(statuses.at(-1)).toBe('error')

    vi.advanceTimersByTime(1_000)
    transports[1].open()
    expect(transports[1].requests()).toHaveLength(0)
  })
})

describe('live subscription', () => {
  it('subscribes on the shared socket and forwards ticks to the chart', () => {
    const { feed, transports } = harness()
    const live: KLineData[] = []
    feed.dataLoader.subscribeBar?.({ symbol: SYMBOL, period: MINUTE_30, callback: (bar) => live.push(bar) })

    expect(transports[0].frames()).toEqual([{ event: 'sub', params: { channel: BTC_CHANNEL, cb_id: 'btcusdt' } }])

    transports[0].emit({ channel: BTC_CHANNEL, tick: { id: 1790360400, open: '100', high: '104', low: '99', close: '102', vol: '1' } })
    expect(live.map((bar) => bar.timestamp)).toEqual([1790360400000])

    // A stale tick (older than the last one) is dropped, an unchanged bar is forwarded.
    transports[0].emit({ channel: BTC_CHANNEL, tick: { id: 1790350000, open: '1', high: '1', low: '1', close: '1', vol: '1' } })
    expect(live).toHaveLength(1)
    transports[0].emit({ channel: BTC_CHANNEL, tick: { id: 1790360400, open: '100', high: '105', low: '99', close: '104', vol: '2' } })
    expect(live).toHaveLength(2)
    expect(live[1].close).toBe(104)
  })

  it('unsubscribes on unsubscribeBar and ignores foreign channels', () => {
    const { feed, transports } = harness()
    const live: KLineData[] = []
    feed.dataLoader.subscribeBar?.({ symbol: SYMBOL, period: MINUTE_30, callback: (bar) => live.push(bar) })
    transports[0].emit({ channel: ETH_CHANNEL, tick: { id: 1790360400, open: '1', high: '1', low: '1', close: '1', vol: '1' } })
    expect(live).toHaveLength(0)

    feed.dataLoader.unsubscribeBar?.({ symbol: SYMBOL, period: MINUTE_30 })
    expect(transports[0].frames().at(-1)).toEqual({ event: 'unsub', params: { channel: BTC_CHANNEL, cb_id: 'btcusdt' } })
    transports[0].emit({ channel: BTC_CHANNEL, tick: { id: 1790360400, open: '1', high: '1', low: '1', close: '1', vol: '1' } })
    expect(live).toHaveLength(0)
  })

  it('signals onReconnect and keeps live time monotonic instead of clearing the cursor', () => {
    const { feed, transports, reconnectCount } = harness()
    const live: KLineData[] = []
    feed.dataLoader.subscribeBar?.({ symbol: SYMBOL, period: MINUTE_30, callback: (bar) => live.push(bar) })
    transports[0].emit({ channel: BTC_CHANNEL, tick: { id: 1790360700, open: '1', high: '1', low: '1', close: '1', vol: '1' } })

    transports[0].drop()
    expect(reconnectCount()).toBe(0)
    vi.advanceTimersByTime(1_000)
    transports[1].open()
    expect(reconnectCount()).toBe(1)
    // The shared socket replays the live subscription by itself.
    expect(transports[1].frames()).toEqual([{ event: 'sub', params: { channel: BTC_CHANNEL, cb_id: 'btcusdt' } }])

    transports[1].emit({ channel: BTC_CHANNEL, tick: { id: 1790360400, open: '1', high: '1', low: '1', close: '1', vol: '1' } })
    expect(live).toHaveLength(1)

    // `resetData()` re-subscribes the fresh series, which starts counting from zero again.
    feed.dataLoader.subscribeBar?.({ symbol: SYMBOL, period: MINUTE_30, callback: (bar) => live.push(bar) })
    transports[1].emit({ channel: BTC_CHANNEL, tick: { id: 1790360400, open: '1', high: '1', low: '1', close: '1', vol: '1' } })
    expect(live).toHaveLength(2)
  })
})

describe('teardown', () => {
  it('settles the pending callback, unsubscribes and returns its lease on dispose', () => {
    const { feed, transports, pool } = harness()
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, received)
    feed.dataLoader.subscribeBar?.({ symbol: SYMBOL, period: MINUTE_30, callback: () => undefined })

    feed.dispose()
    expect(received).toEqual([[]])
    expect(transports[0].frames().at(-1)).toEqual({ event: 'unsub', params: { channel: BTC_CHANNEL, cb_id: 'btcusdt' } })
    expect(pool.leaseCount(URL_)).toBe(0)

    // Anything arriving after dispose is ignored; the socket itself closes after the grace period.
    reply(transports[0], BTC_CHANNEL, [barRow(1_000_000)])
    expect(received).toEqual([[]])
    expect(transports[0].closeCalls).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(transports[0].closeCalls).toBe(1)
  })

  it('ignores work after dispose', () => {
    const { feed, transports } = harness()
    feed.dispose()
    const received: KLineData[][] = []
    getBars(feed, SYMBOL, 'init', null, received)
    expect(received).toEqual([[]])
    expect(transports[0].requests()).toHaveLength(0)
  })

  it('fails an unsupported period without touching the socket', () => {
    const { feed, transports, statuses } = harness()
    const received: KLineData[][] = []
    feed.dataLoader.getBars({
      type: 'init',
      timestamp: null,
      symbol: SYMBOL,
      period: { type: 'minute', span: 7 },
      callback: (bars) => {
        received.push(bars)
      },
    })
    expect(received).toEqual([[]])
    expect(transports[0].sent).toHaveLength(0)
    expect(statuses.at(-1)).toBe('error')
  })
})

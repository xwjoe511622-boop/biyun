import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KlineSocket, type RequestOutcome, type Transport } from '@/modules/ws/kline-socket'
import { SharedSocketPool } from '@/modules/ws/shared-socket'
import type { WsMessage } from '@/modules/ws/protocol'

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

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(message))
  }

  frames(): Array<{ event: string; params: Record<string, unknown> }> {
    return this.sent.map((frame) => JSON.parse(frame) as { event: string; params: Record<string, unknown> })
  }
}

const URL_A = 'wss://ws.example.test/kline-api/ws'
const URL_B = 'wss://ws.example.test/futures-ws'
const REVIEW = { channel: 'review' }
const TICKER = 'market_btcusdt_ticker'
const KLINE = 'market_btcusdt_kline_60min'

function createPool(graceMs = 5_000): { pool: SharedSocketPool; transports: FakeTransport[] } {
  const transports: FakeTransport[] = []
  const pool = new SharedSocketPool({
    graceMs,
    createSocket: (options) =>
      new KlineSocket({
        ...options,
        heartbeatIntervalMs: 60_000,
        random: () => 0,
        transportFactory: () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        },
      }),
  })
  return { pool, transports }
}

describe('SharedSocketPool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens one socket per URL however many consumers lease it', () => {
    const { pool, transports } = createPool()
    const store = pool.acquire(URL_A)
    const chart = pool.acquire(URL_A)
    const futures = pool.acquire(URL_B)
    expect(transports).toHaveLength(2)
    expect(pool.leaseCount(URL_A)).toBe(2)
    store.release()
    chart.release()
    futures.release()
  })

  it('keeps a channel on the wire while any lease still wants it', () => {
    const { pool, transports } = createPool()
    const home = pool.acquire(URL_A)
    const trade = pool.acquire(URL_A)
    transports[0].open()
    home.registerChannel('review', REVIEW)
    trade.registerChannel('review', REVIEW)
    trade.registerChannel(TICKER, { channel: TICKER, cb_id: 'btcusdt' })
    // The second registration of the same channel is not re-sent.
    expect(transports[0].frames().filter((frame) => frame.params.channel === 'review')).toHaveLength(1)

    home.unsubscribeAll()
    expect(transports[0].frames().some((frame) => frame.event === 'unsub')).toBe(false)

    trade.unsubscribe('review')
    expect(transports[0].frames().at(-1)).toEqual({ event: 'unsub', params: { channel: 'review', cb_id: '' } })
    // A lease never drops what another lease registered.
    home.unsubscribe(TICKER)
    expect(transports[0].frames().filter((frame) => frame.event === 'unsub')).toHaveLength(1)
  })

  it('reuses the open socket across a route change within the grace period', () => {
    const { pool, transports } = createPool(5_000)
    const home = pool.acquire(URL_A)
    transports[0].open()
    home.release()
    vi.advanceTimersByTime(4_000)
    expect(transports[0].closeCalls).toBe(0)

    const trade = pool.acquire(URL_A)
    vi.advanceTimersByTime(10_000)
    expect(transports).toHaveLength(1)
    expect(transports[0].closeCalls).toBe(0)
    expect(trade.isOpen).toBe(true)
    trade.release()
  })

  it('closes the socket once the grace period passes with no lease', () => {
    const { pool, transports } = createPool(5_000)
    pool.acquire(URL_A).release()
    vi.advanceTimersByTime(5_000)
    expect(transports[0].closeCalls).toBe(1)
    expect(pool.size).toBe(0)
    pool.acquire(URL_A)
    expect(transports).toHaveLength(2)
  })

  it('stops delivering to a released lease and cancels its pending requests', () => {
    const { pool, transports } = createPool()
    const keep = pool.acquire(URL_A)
    const gone = pool.acquire(URL_A)
    transports[0].open()
    const seen: WsMessage[] = []
    const outcomes: RequestOutcome[] = []
    gone.onMessage((message) => seen.push(message))
    gone.request(KLINE, { channel: KLINE, cb_id: 'btcusdt' }, { timeoutMs: 10_000, onSettle: (outcome) => outcomes.push(outcome) })
    gone.release()
    expect(outcomes).toEqual(['cancelled'])
    transports[0].emit({ channel: TICKER, tick: { close: '1' } })
    expect(seen).toHaveLength(0)
    keep.release()
  })

  it('answers correlated requests in order and times out without closing the socket', () => {
    const { pool, transports } = createPool()
    const lease = pool.acquire(URL_A)
    const outcomes: Array<[RequestOutcome, unknown]> = []
    const settle = (outcome: RequestOutcome, message?: WsMessage): void => {
      outcomes.push([outcome, message?.data])
    }
    lease.request(KLINE, { channel: KLINE, cb_id: 'btcusdt' }, { timeoutMs: 10_000, onSettle: settle })
    lease.request(KLINE, { channel: KLINE, cb_id: 'btcusdt', endIdx: 5 }, { timeoutMs: 10_000, onSettle: settle })
    // Nothing is sent before the socket is open, and only one req per channel is on the wire.
    expect(transports[0].sent).toHaveLength(0)
    transports[0].open()
    expect(transports[0].frames()).toEqual([{ event: 'req', params: { channel: KLINE, cb_id: 'btcusdt' } }])

    const bar = { id: 1, open: '1', high: '1', low: '1', close: '1', vol: '1' }
    transports[0].emit({ channel: KLINE, event_rep: 'rep', data: [bar] })
    expect(outcomes).toEqual([['ok', [bar]]])
    expect(transports[0].frames().at(-1)).toEqual({ event: 'req', params: { channel: KLINE, cb_id: 'btcusdt', endIdx: 5 } })

    vi.advanceTimersByTime(10_000)
    expect(outcomes.at(-1)).toEqual(['timeout', undefined])
    expect(transports[0].closeCalls).toBe(0)
    expect(lease.isOpen).toBe(true)
    lease.release()
  })
})

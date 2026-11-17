import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  SEQ_DEPTH_STORAGE_KEY,
  SeqDepthClient,
  isFuturesSeqDepthEnabled,
  type SeqDepthBook,
  type SeqDepthOptions,
  type SeqDepthStatus,
  type SeqSocket,
} from '@/modules/ws/seq-depth'
import type { WsMessage } from '@/modules/ws/protocol'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'

class FakeSocket implements SeqSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: ((event?: unknown) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

interface Snapshot {
  lastUpdateId: number
  bids: [string, string][]
  asks: [string, string][]
}

type FetchReply = Snapshot | number | Error

function ev(U: number, u: number, b: [string, string][] = [], a: [string, string][] = []): Record<string, unknown> {
  return { e: 'depthUpdate', E: 1, T: 1, s: 'e_btcusdt', U, u, b, a }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function setup(replies: FetchReply[], options: Partial<SeqDepthOptions> = {}) {
  const sockets: FakeSocket[] = []
  const books: SeqDepthBook[] = []
  const statuses: { status: SeqDepthStatus; reason?: string }[] = []
  const urls: string[] = []
  // Each fetch resolves only when the test releases it, so events can be buffered first.
  const pending: (() => void)[] = []
  const fetchImpl = vi.fn((url: string) => {
    urls.push(url)
    const reply = replies.shift() ?? 503
    return new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve, reject) => {
      pending.push(() => {
        if (reply instanceof Error) reject(reply)
        else if (typeof reply === 'number') resolve({ ok: false, status: reply, json: async () => ({}) })
        else resolve({ ok: true, status: 200, json: async () => ({ symbol: 'e_btcusdt', E: 1, ...reply }) })
      })
    })
  })
  const client = new SeqDepthClient({
    wsUrl: 'wss://ws.example/fmd/v1/ws',
    snapshotUrl: '/fmd/v1/depth',
    emitIntervalMs: 0,
    idleCheckMs: 0,
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    fetch: fetchImpl,
    onBook: (book) => books.push(book),
    onStatus: (status, reason) => statuses.push({ status, reason }),
    ...options,
  })
  const release = async (): Promise<void> => {
    const next = pending.shift()
    if (next === undefined) throw new Error('no pending snapshot request')
    next()
    await flush()
  }
  return { client, sockets, books, statuses, urls, fetchImpl, release, pending }
}

const last = <T>(items: T[]): T => items[items.length - 1]
const rows = (book: SeqDepthBook, side: 'bids' | 'asks'): [string, string][] => book[side].map((level) => [level.price, level.amount])

describe('SeqDepthClient sync algorithm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes, fetches the snapshot and applies buffered events in order, dropping stale ones', async () => {
    const t = setup([{ lastUpdateId: 100, bids: [['99', '5'], ['98', '1']], asks: [['101', '2'], ['102', '3']] }])
    t.client.start('E_BTCUSDT')
    t.sockets[0].open()
    expect(JSON.parse(t.sockets[0].sent[0])).toEqual({ method: 'SUBSCRIBE', params: ['e_btcusdt@depth'], id: 1 })
    expect(t.urls[0]).toBe('/fmd/v1/depth?symbol=e_btcusdt&limit=500')
    t.sockets[0].push({ result: null, id: 1 })
    t.sockets[0].push(ev(90, 95, [['99', '1']]))          // stale (u <= 100): dropped
    t.sockets[0].push(ev(96, 100, [['98', '9']]))         // stale: dropped
    t.sockets[0].push(ev(99, 103, [['99', '7']], [['101', '0']])) // bracket: 99 <= 101 <= 103
    t.sockets[0].push(ev(104, 104, [['97.50', '4']]))
    expect(t.books).toHaveLength(0)
    await t.release()
    expect(last(t.statuses).status).toBe('live')
    const book = last(t.books)
    expect(book.lastUpdateId).toBe(104)
    expect(rows(book, 'bids')).toEqual([['99', '7'], ['98', '1'], ['97.5', '4']])
    expect(rows(book, 'asks')).toEqual([['102', '3']])
    // Live continuity.
    t.sockets[0].push(ev(105, 106, [], [['100.5', '1']]))
    expect(rows(last(t.books), 'asks')).toEqual([['100.5', '1'], ['102', '3']])
    expect(last(t.books).asks[0].diff).toBe(1)
  })

  it('throttles emits on the leading edge: a change after a quiet interval is emitted at once (09-30 book latency)', async () => {
    const t = setup([{ lastUpdateId: 10, bids: [['99', '5']], asks: [['101', '2']] }], { emitIntervalMs: 100, now: () => Date.now() })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    expect(t.books).toHaveLength(1) // snapshot emit
    vi.advanceTimersByTime(150)
    t.sockets[0].push(ev(11, 11, [], [['101', '1']]))
    expect(t.books).toHaveLength(2) // quiet for >= interval: synchronous, no 100-200 ms wait
    expect(rows(last(t.books), 'asks')).toEqual([['101', '1']])
    t.sockets[0].push(ev(12, 12, [], [['101', '0']])) // burst: coalesced into one trailing emit
    t.sockets[0].push(ev(13, 13, [], [['102', '4']]))
    expect(t.books).toHaveLength(2)
    vi.advanceTimersByTime(99)
    expect(t.books).toHaveLength(2)
    vi.advanceTimersByTime(1) // one interval after the leading emit
    expect(t.books).toHaveLength(3)
    expect(rows(last(t.books), 'asks')).toEqual([['102', '4']])
  })

  it('removes a level on qty "0" and ignores other symbols', async () => {
    const t = setup([{ lastUpdateId: 10, bids: [['99', '5']], asks: [['101', '2'], ['102', '3']] }])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].push(ev(11, 11, [['99', '0']], [['101', '0']]))
    expect(rows(last(t.books), 'bids')).toEqual([])
    expect(rows(last(t.books), 'asks')).toEqual([['102', '3']])
    const count = t.books.length
    t.sockets[0].push({ ...ev(12, 12, [['50', '1']]), s: 'e_ethusdt' })
    expect(t.books).toHaveLength(count)
  })

  it('refetches the snapshot when the first event does not bracket lastUpdateId+1 (buffer kept)', async () => {
    const t = setup([
      { lastUpdateId: 100, bids: [['99', '1']], asks: [] },
      { lastUpdateId: 110, bids: [['99', '2']], asks: [] },
    ])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    t.sockets[0].push(ev(105, 110, [['98', '1']])) // U=105 > 101: snapshot is behind the stream
    t.sockets[0].push(ev(111, 112, [['97', '1']]))
    await t.release()
    expect(t.books).toHaveLength(0)
    expect(t.fetchImpl).toHaveBeenCalledTimes(2)
    await t.release()
    // Second snapshot at 110: event 105-110 is stale, 111-112 brackets 111.
    expect(last(t.statuses).status).toBe('live')
    expect(last(t.books).lastUpdateId).toBe(112)
    expect(rows(last(t.books), 'bids')).toEqual([['99', '2'], ['97', '1']])
  })

  it('also applies the bracket rule to the first live event after an empty buffer', async () => {
    const t = setup([
      { lastUpdateId: 100, bids: [['99', '1']], asks: [] },
      { lastUpdateId: 120, bids: [['99', '3']], asks: [] },
    ])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].push(ev(98, 102, [['99', '2']])) // 98 <= 101 <= 102: ok
    expect(last(t.books).lastUpdateId).toBe(102)
    t.sockets[0].push(ev(110, 111)) // gap
    expect(last(t.statuses).status).toBe('syncing')
    expect(t.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('detects a gap, discards the local book and resyncs from a new snapshot', async () => {
    const t = setup([
      { lastUpdateId: 100, bids: [['99', '1'], ['98', '1']], asks: [['101', '1']] },
      { lastUpdateId: 200, bids: [['95', '4']], asks: [['105', '1']] },
    ])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].push(ev(101, 101, [['99', '2']]))
    t.sockets[0].push(ev(103, 104, [['99', '3']])) // expected U=102
    expect(t.statuses.map((entry) => entry.status)).toEqual(['connecting', 'syncing', 'live', 'syncing'])
    const count = t.books.length
    t.sockets[0].push(ev(199, 201, [['96', '1']])) // buffered during resync
    await t.release()
    expect(t.books.length).toBe(count + 1)
    expect(rows(last(t.books), 'bids')).toEqual([['96', '1'], ['95', '4']])
    expect(last(t.books).lastUpdateId).toBe(201)
    expect(t.sockets).toHaveLength(1) // same socket
  })

  it('resyncs on the server {"e":"resync"} message', async () => {
    const t = setup([
      { lastUpdateId: 1, bids: [['1', '1']], asks: [] },
      { lastUpdateId: 50, bids: [['2', '1']], asks: [] },
    ])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].push({ e: 'resync' })
    expect(last(t.statuses).status).toBe('syncing')
    await t.release()
    expect(last(t.statuses).status).toBe('live')
    expect(rows(last(t.books), 'bids')).toEqual([['2', '1']])
  })

  it('fails (fallback) when the snapshot endpoint answers 503, then retries after failRetryMinMs (5 s, not a flat minute)', async () => {
    const t = setup([503, { lastUpdateId: 5, bids: [['1', '1']], asks: [] }], { failRetryMs: 60_000 })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    expect(last(t.statuses)).toEqual({ status: 'failed', reason: 'snapshot-http-503' })
    expect(t.sockets[0].closed).toBe(true)
    expect(t.books).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4_900)
    expect(t.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(t.sockets).toHaveLength(2)
    t.sockets[1].open()
    await t.release()
    expect(last(t.statuses).status).toBe('live')
  })

  it('consecutive failures back off 5 → 10 → 20 s (capped at failRetryMs); live resets it', async () => {
    const t = setup([503, 503, 503, { lastUpdateId: 5, bids: [['1', '1']], asks: [] }, 503, { lastUpdateId: 9, bids: [['1', '1']], asks: [] }], { failRetryMs: 15_000 })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    await vi.advanceTimersByTimeAsync(5_000)
    t.sockets[1].open()
    await t.release()
    await vi.advanceTimersByTimeAsync(9_900)
    expect(t.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    t.sockets[2].open()
    await t.release()
    // third failure: 20 s capped at 15 s
    await vi.advanceTimersByTimeAsync(15_000)
    expect(t.sockets).toHaveLength(4)
    t.sockets[3].open()
    await t.release()
    expect(last(t.statuses).status).toBe('live')
  })

  it('fails when the snapshot request throws (network error)', async () => {
    const t = setup([new TypeError('Failed to fetch')])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    expect(last(t.statuses)).toEqual({ status: 'failed', reason: 'snapshot-error' })
  })

  it('fails when the socket does not open within connectTimeoutMs', async () => {
    const t = setup([], { connectTimeoutMs: 3_000 })
    t.client.start('e_btcusdt')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(last(t.statuses)).toEqual({ status: 'failed', reason: 'ws-connect-timeout' })
    expect(t.fetchImpl).not.toHaveBeenCalled()
  })

  it('reconnects with backoff after a drop and resyncs from a new snapshot', async () => {
    const t = setup([
      { lastUpdateId: 10, bids: [['1', '1']], asks: [] },
      { lastUpdateId: 90, bids: [['3', '1']], asks: [] },
    ], { reconnectBaseDelayMs: 1_000 })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].drop()
    expect(last(t.statuses).status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(999)
    expect(t.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sockets).toHaveLength(2)
    t.sockets[1].open()
    expect(t.fetchImpl).toHaveBeenCalledTimes(2)
    await t.release()
    expect(last(t.statuses).status).toBe('live')
    expect(last(t.books).lastUpdateId).toBe(90)
  })

  it('gives up (fallback) after repeated resyncs within the window', async () => {
    const snapshot = { lastUpdateId: 100, bids: [['1', '1']] as [string, string][], asks: [] }
    const t = setup(Array.from({ length: 10 }, () => ({ ...snapshot })), { maxResyncs: 2 })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    for (let round = 0; round < 3; round += 1) {
      await t.release()
      t.sockets[0].push(ev(500, 501)) // always a gap
    }
    expect(last(t.statuses).status).toBe('failed')
    expect(last(t.statuses).reason).toBe('resync-limit:gap')
  })

  it('emits only the snapshot-covered range of a truncated side', async () => {
    const t = setup([{ lastUpdateId: 1, bids: [['99', '1'], ['98', '1']], asks: [['101', '1'], ['102', '1']] }], { snapshotLimit: 2, minKnownLevels: 1 })
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    await t.release()
    t.sockets[0].push(ev(2, 2, [['90', '5']], [['110', '5'], ['101.5', '2']]))
    expect(rows(last(t.books), 'bids')).toEqual([['99', '1'], ['98', '1']])
    expect(rows(last(t.books), 'asks')).toEqual([['101', '1'], ['101.5', '2'], ['102', '1']])
  })

  it('stop() closes the socket and ignores a late snapshot', async () => {
    const t = setup([{ lastUpdateId: 1, bids: [['1', '1']], asks: [] }])
    t.client.start('e_btcusdt')
    t.sockets[0].open()
    t.client.stop()
    await t.release()
    expect(t.sockets[0].closed).toBe(true)
    expect(t.books).toHaveLength(0)
    expect(last(t.statuses).status).toBe('idle')
  })
})

describe('isFuturesSeqDepthEnabled', () => {
  beforeEach(() => localStorage.clear())
  it('defaults on, honours the env switch and the localStorage override', () => {
    expect(isFuturesSeqDepthEnabled('')).toBe(true)
    expect(isFuturesSeqDepthEnabled('0')).toBe(false)
    expect(isFuturesSeqDepthEnabled('off')).toBe(false)
    localStorage.setItem(SEQ_DEPTH_STORAGE_KEY, '1')
    expect(isFuturesSeqDepthEnabled('0')).toBe(true)
    localStorage.setItem(SEQ_DEPTH_STORAGE_KEY, '0')
    expect(isFuturesSeqDepthEnabled('')).toBe(false)
  })
})

describe('futures market store with the sequenced feed', () => {
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
  const seqSockets: FakeSocket[] = []
  let snapshotReply: FetchReply = 503

  beforeEach(async () => {
    vi.useFakeTimers()
    const { sharedSockets } = await import('@/modules/ws/shared-socket')
    sharedSockets.closeAll()
    localStorage.clear()
    localStorage.setItem(SEQ_DEPTH_STORAGE_KEY, '1')
    seqSockets.length = 0
    setActivePinia(createPinia())
    // Legacy frames are pushed through `handleMessage` directly; every socket is a fake.
    vi.stubGlobal('WebSocket', class extends FakeSocket {
      constructor(url: string) {
        super(url)
        seqSockets.push(this)
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      const reply = snapshotReply
      if (reply instanceof Error) throw reply
      if (typeof reply === 'number') return { ok: false, status: reply, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ symbol: 'e_btcusdt', E: 1, ...reply }) }
    }))
  })
  afterEach(async () => {
    const { useFuturesMarketStore } = await import('@/stores/futures-market')
    useFuturesMarketStore().disconnect()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
  })

  async function prepared() {
    const { useFuturesMarketStore } = await import('@/stores/futures-market')
    const market = useFuturesMarketStore()
    const info = normalizePublicInfo(PUBLIC_INFO)
    market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
    market.selectedName = 'E-BTC-USDT'
    market.loaded = true
    return market
  }

  const seqSocket = (): FakeSocket => {
    const socket = seqSockets.find((entry) => entry.url.includes('/fmd/v1/ws'))
    if (socket === undefined) throw new Error('no sequenced socket')
    return socket
  }

  it('uses the sequenced book when live and falls back to step0 on failure', async () => {
    snapshotReply = { lastUpdateId: 10, bids: [['64999.9', '3'], ['64999', '1']], asks: [['65000.1', '2']] }
    const market = await prepared()
    market.resubscribe()
    const push = (message: WsMessage): void => market.handleMessage(message)
    push({ channel: 'market_e_btcusdt_depth_step0', tick: { asks: [['65005', '9']], buys: [['64990', '9']] } })
    await vi.advanceTimersByTimeAsync(250)
    expect(market.depthFeed).toBe('legacy')
    expect(market.asks.map((row) => row.price)).toEqual(['65005'])

    seqSocket().open()
    await vi.advanceTimersByTimeAsync(0)
    expect(market.seqDepthStatus).toBe('live')
    expect(market.depthFeed).toBe('seq')
    expect(market.asks.map((row) => [row.price, row.amount])).toEqual([['65000.1', '2']])
    expect(market.buys.map((row) => [row.price, row.total])).toEqual([['64999.9', '3'], ['64999', '4']])
    expect(market.readBookTop().bids).toEqual(['64999.9', '64999'])
    // Grouped client-side at step 1 from the sequenced book (bids floor).
    market.setDepthStepIndex(1)
    expect(market.buys.map((row) => [row.price, row.amount])).toEqual([['64999', '4']])
    market.setDepthStepIndex(0)

    // step0 frames no longer drive the book, but keep it warm.
    push({ channel: 'market_e_btcusdt_depth_step0', tick: { side: 'asks', price: '65004', volume: '1' } })
    await vi.advanceTimersByTimeAsync(250)
    expect(market.asks.map((row) => row.price)).toEqual(['65000.1'])

    // A gap with the snapshot endpoint down: immediate fallback to the step0 book.
    snapshotReply = 503
    seqSocket().push(ev(50, 51))
    await vi.advanceTimersByTimeAsync(0)
    expect(market.seqDepthStatus).toBe('failed')
    expect(market.depthFeed).toBe('legacy')
    expect(market.asks.map((row) => row.price)).toEqual(['65004', '65005'])
  })

  it('stays on step0 when the flag is off', async () => {
    localStorage.setItem(SEQ_DEPTH_STORAGE_KEY, '0')
    const market = await prepared()
    market.resubscribe()
    expect(seqSockets.some((entry) => entry.url.includes('/fmd/'))).toBe(false)
    expect(market.seqDepthStatus).toBe('idle')
  })
})

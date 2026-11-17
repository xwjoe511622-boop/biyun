import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { WsMessage } from '@/modules/ws/protocol'

// Spot book with the sequenced feed (spot-md `/smd/v1`): live -> exact book; failure -> step0 channel at once.

interface MockSocket {
  handler: ((message: WsMessage) => void) | null
  channels: string[]
}
const legacySockets: MockSocket[] = []

vi.mock('@/modules/ws/kline-socket', () => ({
  KlineSocket: class {
    private readonly entry: MockSocket = { handler: null, channels: [] }
    constructor() { legacySockets.push(this.entry) }
    get isOpen(): boolean { return true }
    get state(): string { return 'open' }
    connect(): void {}
    close(): void {}
    onMessage(handler: (message: WsMessage) => void): () => void { this.entry.handler = handler; return () => undefined }
    onStateChange(): () => void { return () => undefined }
    registerChannel(channel: string, _params: unknown, kind = 'sub'): void {
      if (!this.entry.channels.includes(`${kind}:${channel}`)) this.entry.channels.push(`${kind}:${channel}`)
    }
    unsubscribe(channel: string): void { this.entry.channels = this.entry.channels.filter((entry) => !entry.endsWith(`:${channel}`)) }
    request(): () => void { return () => undefined }
  },
}))

const { useMarketStore } = await import('@/stores/market')
const { sharedSockets } = await import('@/modules/ws/shared-socket')
const { SPOT_SEQ_DEPTH_STORAGE_KEY, isSpotSeqDepthEnabled } = await import('@/modules/ws/seq-depth')

class FakeSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: ((event?: unknown) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true; this.readyState = 3 }
  open(): void { this.readyState = 1; this.onopen?.() }
  push(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }) }
}

type FetchReply = { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] } | number

describe('spot market store with the sequenced feed', () => {
  const seqSockets: FakeSocket[] = []
  let snapshotReply: FetchReply = 503

  beforeEach(() => {
    vi.useFakeTimers()
    sharedSockets.closeAll()
    localStorage.clear()
    sessionStorage.clear()
    legacySockets.length = 0
    seqSockets.length = 0
    setActivePinia(createPinia())
    vi.stubGlobal('WebSocket', class extends FakeSocket {
      constructor(url: string) { super(url); seqSockets.push(this) }
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const reply = snapshotReply
      if (typeof reply === 'number') return { ok: false, status: reply, json: async () => ({}) }
      expect(url).toContain('/smd/v1/depth?symbol=btcusdt')
      return { ok: true, status: 200, json: async () => ({ symbol: 'btcusdt', E: 1, ...reply }) }
    }))
  })
  afterEach(() => {
    useMarketStore().disconnect()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
  })

  function prepared(): ReturnType<typeof useMarketStore> {
    const market = useMarketStore()
    market.publicInfo = { market: { market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01,0.1,1' } } } } }
    market.selectedPair = 'BTC/USDT'
    market.start('terminal')
    return market
  }

  const seqSocket = (): FakeSocket => {
    const socket = seqSockets.find((entry) => entry.url.includes('/smd/v1/ws'))
    if (socket === undefined) throw new Error('no sequenced socket')
    return socket
  }

  it('subscribes step0 (finest) and step index channels, uses the sequenced book when live, falls back on failure', async () => {
    snapshotReply = { lastUpdateId: 10, bids: [['83000.12', '0.3'], ['83000.01', '0.1']], asks: [['83001.5', '0.2']] }
    const market = prepared()
    expect(legacySockets[0].channels).toContain('sub:market_btcusdt_depth_step0')
    const push = (message: WsMessage): void => legacySockets[0].handler?.(message)
    push({ channel: 'market_btcusdt_depth_step0', tick: { asks: [['83005', '9']], buys: [['82990', '9']] } })
    await vi.advanceTimersByTimeAsync(250)
    expect(market.depthFeed).toBe('legacy')
    expect(market.asks.map((row) => row.price)).toEqual(['83005'])

    seqSocket().open()
    expect(JSON.parse(seqSocket().sent[0])).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@depth'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(market.seqDepthStatus).toBe('live')
    expect(market.depthFeed).toBe('seq')
    expect(market.asks.map((row) => [row.price, row.amount])).toEqual([['83001.5', '0.2']])
    expect(market.buys.map((row) => [row.price, row.total])).toEqual([['83000.12', '0.3'], ['83000.01', '0.4']])

    // step 0.1 groups the sequenced book client-side (bids floor) and subscribes the step1 channel as coarse source
    market.setDepthStepIndex(1)
    expect(legacySockets[0].channels).toContain('sub:market_btcusdt_depth_step1')
    expect(market.buys.map((row) => [row.price, row.amount])).toEqual([['83000.1', '0.3'], ['83000', '0.1']])
    market.setDepthStepIndex(2)
    expect(legacySockets[0].channels).toContain('sub:market_btcusdt_depth_step2')
    market.setDepthStepIndex(0)

    // an update id gap with the snapshot endpoint down: immediate fallback to the step0 book
    snapshotReply = 503
    seqSocket().push({ e: 'depthUpdate', E: 1, T: 1, s: 'btcusdt', U: 50, u: 51, b: [], a: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(market.seqDepthStatus).toBe('failed')
    expect(market.depthFeed).toBe('legacy')
    expect(market.asks.map((row) => row.price)).toEqual(['83005'])
  })

  it('stays on step0 when the flag is off', () => {
    localStorage.setItem(SPOT_SEQ_DEPTH_STORAGE_KEY, '0')
    const market = prepared()
    expect(seqSockets.some((entry) => entry.url.includes('/smd/'))).toBe(false)
    expect(market.seqDepthStatus).toBe('idle')
    expect(isSpotSeqDepthEnabled('')).toBe(false)
    localStorage.removeItem(SPOT_SEQ_DEPTH_STORAGE_KEY)
    expect(isSpotSeqDepthEnabled('')).toBe(true)
    expect(isSpotSeqDepthEnabled('off')).toBe(false)
  })
})

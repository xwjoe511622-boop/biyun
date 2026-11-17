import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deflate } from 'pako'
import { KlineSocket, decodeFrame, type Transport, type TransportFactory } from '@/modules/ws/kline-socket'
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

  emitOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  emitMessage(data: ArrayBuffer | string): void {
    this.onmessage?.(data)
  }

  emitClose(): void {
    this.readyState = 3
    this.onclose?.()
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
  }
}

function createSocket(): { socket: KlineSocket; transports: FakeTransport[] } {
  const transports: FakeTransport[] = []
  const factory: TransportFactory = () => {
    const transport = new FakeTransport()
    transports.push(transport)
    return transport
  }
  const socket = new KlineSocket({
    url: 'wss://ws.exchange.invalid/kline-api/ws',
    transportFactory: factory,
    heartbeatIntervalMs: 1_000,
    reconnectBaseDelayMs: 1_000,
    reconnectMaxDelayMs: 8_000,
    random: () => 0,
  })
  return { socket, transports }
}

const TICKER = 'market_btcusdt_ticker'
const TICKER_PARAMS = { channel: TICKER, cb_id: 'btcusdt' }

describe('KlineSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes once the socket is open and routes frames to the channel handler', () => {
    const { socket, transports } = createSocket()
    const seen: WsMessage[] = []

    socket.connect()
    socket.subscribe(TICKER, TICKER_PARAMS, (message) => {
      seen.push(message)
    })

    const transport = transports[0]
    expect(transport.frames()).toEqual([])

    transport.emitOpen()
    expect(transport.frames()).toEqual([{ event: 'sub', params: TICKER_PARAMS }])

    transport.emitMessage(JSON.stringify({ channel: TICKER, ts: 1, tick: { close: '65000' } }))
    expect(seen).toHaveLength(1)
    expect(seen[0].tick).toEqual({ close: '65000' })

    transport.emitMessage(JSON.stringify({ channel: 'market_btcusdt_depth_step8', ts: 2, tick: {} }))
    expect(seen).toHaveLength(1)
  })

  it('sends an unsubscribe frame when the last handler goes away', () => {
    const { socket, transports } = createSocket()
    const handler = (): void => undefined
    socket.connect()
    transports[0].emitOpen()

    socket.subscribe(TICKER, TICKER_PARAMS, handler)
    expect(socket.subscribedChannels()).toContain(TICKER)

    socket.unsubscribe(TICKER, handler)

    expect(socket.subscribedChannels()).not.toContain(TICKER)
    expect(transports[0].frames().at(-1)).toEqual({
      event: 'unsub',
      params: { channel: TICKER, cb_id: 'btcusdt' },
    })
  })

  it('keeps the subscription while another handler still listens', () => {
    const { socket, transports } = createSocket()
    const first = (): void => undefined
    const second = (): void => undefined
    socket.connect()
    transports[0].emitOpen()

    socket.subscribe(TICKER, TICKER_PARAMS, first)
    socket.subscribe(TICKER, TICKER_PARAMS, second)
    expect(transports[0].frames()).toHaveLength(1)

    socket.unsubscribe(TICKER, first)
    expect(socket.subscribedChannels()).toContain(TICKER)
  })

  it('reconnects with backoff and replays every subscription (req and sub)', async () => {
    const { socket, transports } = createSocket()
    const kline = 'market_btcusdt_kline_1min'

    socket.connect()
    transports[0].emitOpen()
    socket.registerChannel(TICKER, TICKER_PARAMS)
    socket.registerChannel(kline, { channel: kline, cb_id: 'btcusdt', pageSize: 300 }, 'req')
    socket.registerChannel(kline, { channel: kline, cb_id: 'btcusdt' })

    transports[0].emitClose()
    expect(transports).toHaveLength(1)
    expect(socket.state).toBe('closed')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(transports).toHaveLength(2)

    transports[1].emitOpen()
    expect(transports[1].frames()).toEqual([
      { event: 'sub', params: TICKER_PARAMS },
      { event: 'req', params: { channel: kline, cb_id: 'btcusdt', pageSize: 300 } },
      { event: 'sub', params: { channel: kline, cb_id: 'btcusdt' } },
    ])
    expect(socket.state).toBe('open')
  })

  it('never reconnects after an explicit close', async () => {
    const { socket, transports } = createSocket()
    socket.connect()
    transports[0].emitOpen()

    socket.close()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(transports).toHaveLength(1)
    expect(transports[0].closeCalls).toBe(1)
    expect(socket.state).toBe('closed')
  })

  it('answers a server ping with the literal pong frame', () => {
    const { socket, transports } = createSocket()
    socket.connect()
    transports[0].emitOpen()

    transports[0].emitMessage(JSON.stringify({ ping: 1730000000000 }))

    expect(transports[0].sent.at(-1)).toBe(JSON.stringify({ pong: 1730000000000 }))
  })

  it('closes and reconnects when the heartbeat watchdog fires', async () => {
    const { socket, transports } = createSocket()
    socket.connect()
    transports[0].emitOpen()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(transports[0].closeCalls).toBe(1)
    expect(socket.state).toBe('closed')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(transports).toHaveLength(2)
  })

  it('keeps the watchdog alive while frames keep arriving', async () => {
    const { socket, transports } = createSocket()
    socket.connect()
    transports[0].emitOpen()

    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(700)
      transports[0].emitMessage(JSON.stringify({ channel: TICKER, tick: {} }))
    }

    expect(transports[0].closeCalls).toBe(0)
    expect(transports).toHaveLength(1)
  })
})

describe('decodeFrame', () => {
  it('inflates the deflate frames the market service sends', () => {
    const payload = { channel: TICKER, ts: 12, tick: { close: '65000.5' } }
    const compressed = deflate(JSON.stringify(payload))
    const buffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
    expect(decodeFrame(buffer as ArrayBuffer)).toEqual(payload)
  })

  it('still accepts a plain JSON text frame', () => {
    expect(decodeFrame('{"ping":7}')).toEqual({ ping: 7 })
  })

  it('returns null for undecodable frames instead of throwing', () => {
    expect(decodeFrame('not json')).toBeNull()
    expect(decodeFrame(new Uint8Array([1, 2, 3]).buffer)).toBeNull()
  })
})

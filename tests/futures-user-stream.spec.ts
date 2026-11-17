/**
 * Futures user data stream lifecycle (2026-10-01, docs/04-design/futures-user-stream.md): listenKey POST → socket,
 * resync on every open, keepalive PUT, re-POST on -1125 / listenKeyExpired, backoff reconnect, pause while the tab is
 * hidden for long, DELETE on logout. Ids above 2^53 survive parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/core/errors'
import { parseLosslessJson } from '@/modules/futures/fapi'
import { HIDDEN_CLOSE_MS, KEEPALIVE_MS, UserStream, type SocketLike, type UserStreamEvent, type UserStreamStatus } from '@/modules/futures/user-stream'

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false
  sent: string[] = []
  constructor(readonly url: string) {}
  close(): void { this.closed = true }
  send(data: string): void { this.sent.push(data) }
  open(): void { this.onopen?.({}) }
  emit(text: string): void { this.onmessage?.({ data: text }) }
  drop(): void { this.closed = true; this.onclose?.({ code: 1006 }) }
}

class FakeVisibility {
  hidden = false
  private listeners = new Set<() => void>()
  addEventListener(_type: 'visibilitychange', listener: () => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void { this.listeners.delete(listener) }
  set(hidden: boolean): void { this.hidden = hidden; this.listeners.forEach((listener) => listener()) }
}

let sockets: FakeSocket[]
let keys: number
let createKey: ReturnType<typeof vi.fn>
let keepAlive: ReturnType<typeof vi.fn>
let closeKey: ReturnType<typeof vi.fn>
let visibility: FakeVisibility
let events: UserStreamEvent[]
let opens: boolean[]
let statuses: UserStreamStatus[]

function make(): UserStream {
  return new UserStream({
    createKey: createKey as unknown as () => Promise<string>,
    keepAlive: keepAlive as unknown as () => Promise<void>,
    closeKey: closeKey as unknown as () => Promise<void>,
    wsBase: 'wss://ws.example/futures-user/ws',
    socket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    visibility,
    random: () => 0,
  }, {
    onEvent: (event) => events.push(event),
    onOpen: ({ reconnect }) => opens.push(reconnect),
    onStatus: (status) => statuses.push(status),
  })
}

const last = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  keys = 0
  createKey = vi.fn(async () => `key${++keys}`)
  keepAlive = vi.fn(async () => undefined)
  closeKey = vi.fn(async () => undefined)
  visibility = new FakeVisibility()
  events = []
  opens = []
  statuses = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('lossless JSON', () => {
  it('keeps order ids above 2^53 exact and leaves small numbers alone', () => {
    const parsed = parseLosslessJson('{"e":"ORDER_TRADE_UPDATE","E":1790846303705,"o":{"i":3490755354386448384,"t":0,"q":"0.001"}}') as { E: number; o: { i: string; t: number } }
    expect(parsed.o.i).toBe('3490755354386448384')
    expect(parsed.o.t).toBe(0)
    expect(parsed.E).toBe(1790846303705)
    const rows = parseLosslessJson('[{"orderId":3490755423105925120,"time":1790846307000}]') as { orderId: string }[]
    expect(rows[0]?.orderId).toBe('3490755423105925120')
  })
})

describe('UserStream lifecycle', () => {
  it('POSTs a listenKey, opens the socket and asks for a resync on the first open', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(createKey).toHaveBeenCalledTimes(1)
    expect(last().url).toBe('wss://ws.example/futures-user/ws/key1')
    last().open()
    expect(opens).toEqual([false])
    expect(stream.state).toBe('open')
    last().emit('{"e":"ORDER_TRADE_UPDATE","E":1,"o":{"i":3490755354386448384}}')
    expect((events[0]?.o as { i: string }).i).toBe('3490755354386448384')
    stream.stop()
  })

  it('reconnects with backoff after a drop, re-POSTs and resyncs (reconnect = true)', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    last().drop()
    expect(stream.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(createKey).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
    last().open()
    expect(opens).toEqual([false, true])
    stream.stop()
  })

  it('backs off 1 s, 2 s, 4 s while the listenKey POST fails, and resets after an open', async () => {
    createKey.mockRejectedValue(new ApiError({ kind: 'http', code: '-1001', message: 'Internal error' }))
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(createKey).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createKey).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(createKey).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(createKey).toHaveBeenCalledTimes(3)
    createKey.mockImplementation(async () => `key${++keys}`)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(createKey).toHaveBeenCalledTimes(4)
    last().open()
    last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createKey).toHaveBeenCalledTimes(5)
    stream.stop()
  })

  it('a handshake refused (key lost on a gateway restart) retries with a fresh POST', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createKey).toHaveBeenCalledTimes(2)
    expect(last().url.endsWith('/key2')).toBe(true)
    stream.stop()
  })

  it('keeps the key alive every 30 min; -1125 drops the socket and re-POSTs', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(keepAlive).toHaveBeenCalledTimes(1)
    expect(createKey).toHaveBeenCalledTimes(1)
    keepAlive.mockRejectedValueOnce(new ApiError({ kind: 'http', code: '-1125', message: 'This listenKey does not exist.', status: 400 }))
    const first = last()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(first.closed).toBe(true)
    expect(createKey).toHaveBeenCalledTimes(2)
    last().open()
    expect(opens).toEqual([false, true])
    stream.stop()
  })

  it('a keepalive failure other than -1125 keeps the socket', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    keepAlive.mockRejectedValueOnce(new ApiError({ kind: 'network', code: '', message: 'offline' }))
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(last().closed).toBe(false)
    expect(createKey).toHaveBeenCalledTimes(1)
    stream.stop()
  })

  it('listenKeyExpired → reconnect at once with a new POST (not passed on as an event)', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    last().emit('{"e":"listenKeyExpired","E":1790847600000,"listenKey":"key1"}')
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([])
    expect(createKey).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
    stream.stop()
  })

  it('closes the socket after the tab is hidden for 5 min and reconnects (resync) when visible again', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    visibility.set(true)
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1)
    expect(last().closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(last().closed).toBe(true)
    expect(stream.state).toBe('paused')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(createKey).toHaveBeenCalledTimes(1)
    visibility.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(createKey).toHaveBeenCalledTimes(2)
    last().open()
    expect(opens).toEqual([false, true])
    stream.stop()
  })

  it('a short hide does not close the socket', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    visibility.set(true)
    await vi.advanceTimersByTimeAsync(60_000)
    visibility.set(false)
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS)
    expect(last().closed).toBe(false)
    expect(sockets).toHaveLength(1)
    stream.stop()
  })

  it('stop({ logout }) closes the socket, DELETEs the key and never reconnects', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    stream.stop({ logout: true })
    expect(last().closed).toBe(true)
    expect(closeKey).toHaveBeenCalledTimes(1)
    expect(stream.state).toBe('stopped')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(createKey).toHaveBeenCalledTimes(1)
  })

  it('a stop while the POST is in flight opens no socket', async () => {
    let release!: (key: string) => void
    createKey.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const stream = make()
    stream.start()
    stream.stop()
    release('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(0)
  })

  it('sends a heartbeat frame every 25 s while open (the public route drops idle sockets at ~60 s)', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    await vi.advanceTimersByTimeAsync(75_000)
    expect(last().sent).toEqual(['{}', '{}', '{}'])
    const first = last()
    first.drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.sent).toHaveLength(3)
    stream.stop()
  })

  it('ignores frames that are not JSON events', async () => {
    const stream = make()
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    last().open()
    last().emit('not json')
    last().emit('{"no":"type"}')
    expect(events).toEqual([])
    expect(statuses).toContain('open')
    stream.stop()
  })
})

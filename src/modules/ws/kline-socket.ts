import { inflate } from 'pako'
import { parseJsonLossless } from '@/core/lossless-json'
import type { WsMessage } from './protocol'
import { validateWsMessage } from './validation'
import { SubscriptionRegistry, subscriptionKey, type SubscriptionEntry } from './subscription-registry'

/**
 * Market WebSocket connection with reconnect, heartbeat and unsubscribe handling.
 *
 * - Reconnect: exponential backoff with jitter (1s, 2s, 4s ... capped); a manual `close()`
 *   never reconnects.
 * - Heartbeat: the server pushes `{ ping: n }` and expects `{ pong: n }`; a watchdog also closes
 *   the socket when no frame arrives within `heartbeatIntervalMs`, which triggers the reconnect path.
 * - Replay: after a reconnect every desired subscription is restored from the registry
 *   (`req` for one-shot snapshots, `sub` for live channels) and nothing else is re-sent.
 * - Correlated requests (`request`): `rep` frames carry no request id (the server does not echo
 *   `cb_id`), only the channel, and replies arrive in send order. So at most one correlated `req`
 *   per channel is in flight; the next one is sent only after the previous reply (or after its
 *   grace window, when it timed out or was cancelled), which makes channel + order an exact
 *   correlation key. A request timeout never closes the socket.
 *
 * The transport is injectable so reconnect/heartbeat/subscribe behaviour is unit-testable
 * without a real socket.
 */

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed'

export const WS_OPEN = 1
export const WS_CLOSED = 3

export interface Transport {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((data: ArrayBuffer | string) => void) | null
}

export type TransportFactory = (url: string) => Transport

export function defaultTransportFactory(url: string): Transport {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  const transport: Transport = {
    get readyState(): number {
      return socket.readyState
    },
    send(data: string): void {
      socket.send(data)
    },
    close(): void {
      socket.close()
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  }
  socket.onopen = () => {
    transport.onopen?.()
  }
  socket.onclose = () => {
    transport.onclose?.()
  }
  socket.onerror = () => {
    transport.onerror?.()
  }
  socket.onmessage = (event: MessageEvent) => {
    transport.onmessage?.(event.data as ArrayBuffer | string)
  }
  return transport
}

/** Decodes a frame: zlib deflate for binary frames, plain JSON for text frames. */
export function decodeFrame(raw: ArrayBuffer | string): WsMessage | null {
  try {
    if (typeof raw === 'string') {
      return raw === '' ? null : validateWsMessage(parseJsonLossless(raw))
    }
    const text = new TextDecoder().decode(inflate(new Uint8Array(raw)))
    return text === '' ? null : validateWsMessage(parseJsonLossless(text))
  } catch {
    return null
  }
}

export type MessageHandler = (message: WsMessage) => void
export type StateListener = (state: SocketState) => void

export type RequestOutcome = 'ok' | 'timeout' | 'closed' | 'cancelled'

export interface SocketRequestOptions {
  timeoutMs: number
  /** Called exactly once; `message` is the `rep` frame for `ok`. */
  onSettle: (outcome: RequestOutcome, message?: WsMessage) => void
}

interface PendingRequest {
  channel: string
  params: Record<string, unknown>
  onSettle: SocketRequestOptions['onSettle']
  sent: boolean
  settled: boolean
  /** A settled-but-unanswered request keeps the channel until its reply arrives or this deadline. */
  sinkTimer: ReturnType<typeof setTimeout> | null
  timer: ReturnType<typeof setTimeout> | null
}

/** How long an abandoned (timed out / cancelled) request still owns its channel's next reply. */
export const REQUEST_SINK_GRACE_MS = 5_000

export interface KlineSocketOptions {
  url: string
  transportFactory?: TransportFactory
  /** Watchdog interval; the legacy client used 30s. */
  heartbeatIntervalMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  maxReconnectAttempts?: number
  /** Injectable RNG for deterministic backoff in tests. */
  random?: () => number
  /** Injectable decoder for tests. */
  decode?: (raw: ArrayBuffer | string) => WsMessage | null
  onStateChange?: (state: SocketState) => void
}

export class KlineSocket {
  private readonly url: string
  private readonly transportFactory: TransportFactory
  private readonly heartbeatIntervalMs: number
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly maxReconnectAttempts: number
  private readonly random: () => number
  private readonly decode: (raw: ArrayBuffer | string) => WsMessage | null
  private readonly stateCallback: ((state: SocketState) => void) | undefined
  private readonly registry = new SubscriptionRegistry()
  private readonly handlers = new Map<string, Set<MessageHandler>>()
  private readonly globalHandlers = new Set<MessageHandler>()
  private readonly stateListeners = new Set<StateListener>()
  /** Correlated requests per channel, oldest first; only the head may be on the wire. */
  private readonly requests = new Map<string, PendingRequest[]>()

  private transport: Transport | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private disposed = false
  private currentState: SocketState = 'idle'

  constructor(options: KlineSocketOptions) {
    this.url = options.url
    this.transportFactory = options.transportFactory ?? defaultTransportFactory
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY
    this.random = options.random ?? Math.random
    this.decode = options.decode ?? decodeFrame
    this.stateCallback = options.onStateChange
  }

  get state(): SocketState {
    return this.currentState
  }

  get isOpen(): boolean {
    return this.transport !== null && this.transport.readyState === WS_OPEN
  }

  /** Reconnect attempts scheduled since the last successful open. */
  get attempts(): number {
    return this.reconnectAttempts
  }

  connect(): void {
    if (this.disposed) {
      return
    }
    if (this.transport !== null && this.transport.readyState !== WS_CLOSED) {
      return
    }
    this.setState('connecting')
    const transport = this.transportFactory(this.url)
    this.transport = transport
    transport.onopen = () => {
      this.reconnectAttempts = 0
      this.setState('open')
      this.flushSubscriptions()
      this.pumpAllRequests()
      this.armHeartbeat()
    }
    transport.onclose = () => {
      this.clearHeartbeat()
      this.transport = null
      this.dropInFlightRequests()
      this.setState('closed')
      this.scheduleReconnect()
    }
    transport.onerror = () => {
      // A close event always follows an error; reconnection is handled there only.
    }
    transport.onmessage = (data) => {
      this.armHeartbeat()
      const message = this.decode(data)
      if (message !== null) {
        this.handleMessage(message)
      }
    }
  }

  /** Closes the socket and disables reconnection. */
  close(): void {
    this.disposed = true
    this.clearHeartbeat()
    this.clearReconnectTimer()
    const transport = this.transport
    this.transport = null
    this.cancelAllRequests()
    if (transport !== null) {
      transport.onopen = null
      transport.onclose = null
      transport.onerror = null
      transport.onmessage = null
      transport.close()
    }
    this.setState('closed')
  }

  /**
   * Registers a channel for (re)subscription without a channel-scoped handler.
   * The subscribe frame is sent only the first time, so repeated calls are idempotent.
   */
  registerChannel(channel: string, params: Record<string, unknown>, kind: SubscriptionEntry['kind'] = 'sub'): void {
    const isNew = !this.registry.has(channel, kind)
    this.registry.set(channel, kind, params)
    if (isNew) {
      this.send({ event: kind, params })
    }
  }

  /** Same as `registerChannel` plus a handler for frames on that channel. */
  subscribe(
    channel: string,
    params: Record<string, unknown>,
    handler: MessageHandler,
    kind: SubscriptionEntry['kind'] = 'sub',
  ): void {
    this.registerChannel(channel, params, kind)
    const key = subscriptionKey(channel, kind)
    const existing = this.handlers.get(key)
    if (existing === undefined) {
      this.handlers.set(key, new Set([handler]))
    } else {
      existing.add(handler)
    }
  }

  /** Removes one handler; the channel is unsubscribed only when no handler is left. */
  unsubscribe(channel: string, handler?: MessageHandler): void {
    const entries = this.registry.forChannel(channel)
    if (entries.length === 0) {
      return
    }
    if (handler !== undefined) {
      entries.forEach((entry) => {
        this.handlers.get(subscriptionKey(entry.channel, entry.kind))?.delete(handler)
      })
      const stillUsed = entries.some((entry) => {
        const set = this.handlers.get(subscriptionKey(entry.channel, entry.kind))
        return set !== undefined && set.size > 0
      })
      if (stillUsed) {
        return
      }
    }
    this.registry.delete(channel)
    entries.forEach((entry) => {
      this.handlers.delete(subscriptionKey(entry.channel, entry.kind))
    })
    this.send({ event: 'unsub', params: { channel, cb_id: String(entries[0].params.cb_id ?? '') } })
  }

  /** Removes every subscription (used when switching pairs). */
  unsubscribeAll(): void {
    this.subscribedChannels().forEach((channel) => {
      this.unsubscribe(channel)
    })
    this.registry.clear()
    this.handlers.clear()
  }

  /** Adds a state listener (several consumers share one socket). */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /**
   * One-shot correlated `req` (e.g. a K-line history page). Queued until the socket is open and
   * the channel is free; settles exactly once with `ok`, `timeout`, `closed` (the transport dropped
   * while it was in flight) or `cancelled`. Returns a cancel function. Never touches the registry,
   * so a reconnect does not replay it.
   */
  request(channel: string, params: Record<string, unknown>, options: SocketRequestOptions): () => void {
    const entry: PendingRequest = {
      channel,
      params,
      onSettle: options.onSettle,
      sent: false,
      settled: false,
      sinkTimer: null,
      timer: null,
    }
    if (this.disposed) {
      entry.settled = true
      options.onSettle('closed')
      return () => undefined
    }
    const queue = this.requests.get(channel)
    if (queue === undefined) this.requests.set(channel, [entry])
    else queue.push(entry)
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.abandonRequest(entry, 'timeout')
    }, options.timeoutMs)
    this.pumpRequests(channel)
    return () => {
      this.abandonRequest(entry, 'cancelled')
    }
  }

  /** Correlated requests still owning a channel (in flight, queued or waiting out a grace window). */
  pendingRequestCount(): number {
    let count = 0
    this.requests.forEach((queue) => {
      count += queue.length
    })
    return count
  }

  /** Registers a handler for every inbound message (book/ticker routing). */
  onMessage(handler: MessageHandler): () => void {
    this.globalHandlers.add(handler)
    return () => {
      this.globalHandlers.delete(handler)
    }
  }

  /** Raw send; returns `false` while the socket is not open (the registry replays later). */
  send(payload: { event: string; params: Record<string, unknown> }): boolean {
    const transport = this.transport
    if (transport === null || transport.readyState !== WS_OPEN) {
      return false
    }
    transport.send(JSON.stringify(payload))
    return true
  }

  subscribedChannels(): string[] {
    return [...new Set(this.registry.list().map((entry) => entry.channel))]
  }

  private setState(state: SocketState): void {
    if (this.currentState === state) {
      return
    }
    this.currentState = state
    this.stateCallback?.(state)
    this.stateListeners.forEach((listener) => {
      listener(state)
    })
  }

  private settleRequest(entry: PendingRequest, outcome: RequestOutcome, message?: WsMessage): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.onSettle(outcome, message)
  }

  private removeRequest(entry: PendingRequest): void {
    if (entry.sinkTimer !== null) {
      clearTimeout(entry.sinkTimer)
      entry.sinkTimer = null
    }
    const queue = this.requests.get(entry.channel)
    if (queue === undefined) return
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.requests.delete(entry.channel)
  }

  /**
   * Timeout or cancel. An unsent request simply leaves the queue. A sent one settles now but keeps
   * the channel for a short grace window, so its late reply is swallowed instead of being handed to
   * the next request on the same channel.
   */
  private abandonRequest(entry: PendingRequest, outcome: 'timeout' | 'cancelled'): void {
    if (entry.settled) return
    this.settleRequest(entry, outcome)
    if (!entry.sent) {
      this.removeRequest(entry)
      this.pumpRequests(entry.channel)
      return
    }
    entry.sinkTimer = setTimeout(() => {
      entry.sinkTimer = null
      this.removeRequest(entry)
      this.pumpRequests(entry.channel)
    }, REQUEST_SINK_GRACE_MS)
  }

  /** Sends the head of the channel queue when nothing for that channel is on the wire. */
  private pumpRequests(channel: string): void {
    const head = this.requests.get(channel)?.[0]
    if (head === undefined || head.sent) return
    if (this.send({ event: 'req', params: head.params })) head.sent = true
  }

  private pumpAllRequests(): void {
    ;[...this.requests.keys()].forEach((channel) => {
      this.pumpRequests(channel)
    })
  }

  /** Replies to frames sent on a dead transport never arrive: fail them and free their channels. */
  private dropInFlightRequests(): void {
    this.requests.forEach((queue) => {
      queue.filter((entry) => entry.sent).forEach((entry) => {
        this.settleRequest(entry, 'closed')
        this.removeRequest(entry)
      })
    })
  }

  private cancelAllRequests(): void {
    this.requests.forEach((queue) => {
      ;[...queue].forEach((entry) => {
        this.settleRequest(entry, 'cancelled')
        this.removeRequest(entry)
      })
    })
    this.requests.clear()
  }

  /** Routes a `rep` frame to the in-flight correlated request of its channel, if any. */
  private resolveRequest(message: WsMessage): void {
    const channel = message.channel
    if (message.event_rep !== 'rep' || channel === undefined) return
    const head = this.requests.get(channel)?.[0]
    if (head === undefined || !head.sent) return
    this.removeRequest(head)
    this.settleRequest(head, 'ok', message)
    this.pumpRequests(channel)
  }

  private handleMessage(message: WsMessage): void {
    if (message.ping !== undefined) {
      // The server expects the literal `{ pong: <ping> }` frame.
      this.transport?.send(JSON.stringify({ pong: message.ping }))
    }
    this.resolveRequest(message)
    this.globalHandlers.forEach((handler) => {
      handler(message)
    })
    const channel = message.channel
    if (channel === undefined) {
      return
    }
    this.registry.forChannel(channel).forEach((entry) => {
      this.handlers.get(subscriptionKey(entry.channel, entry.kind))?.forEach((handler) => {
        handler(message)
      })
    })
  }

  private flushSubscriptions(): void {
    this.registry.list().forEach((entry) => {
      this.send({ event: entry.kind, params: entry.params })
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) {
      return
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return
    }
    const exponent = Math.min(this.reconnectAttempts, 5)
    const base = Math.min(this.reconnectBaseDelayMs * 2 ** exponent, this.reconnectMaxDelayMs)
    const delay = base + Math.floor(this.random() * this.reconnectBaseDelayMs)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private armHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      // No frame received in time: force a close so the reconnect path runs.
      this.transport?.close()
    }, this.heartbeatIntervalMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

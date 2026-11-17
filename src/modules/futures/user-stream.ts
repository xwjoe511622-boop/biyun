import { isApiError } from '@/core/errors'
import { parseLosslessJson } from './fapi'

/**
 * Futures user data stream client (Binance USDⓈ-M style; contract docs/04-design/futures-user-stream.md).
 *
 * Lifecycle:
 * - connect: `POST listenKey` (returns the user's existing key and extends it, so every (re)connect re-POSTs — this
 *   also covers keys lost on a gateway restart, which then refuse the handshake) → `wss://…/futures-user/ws/<key>`.
 * - every successful open calls `onOpen({ reconnect })`: the caller rebuilds state from REST snapshots (no replay).
 * - keepalive `PUT listenKey` every `keepAliveMs` (30 min, key lives 60 min); `-1125` → drop the socket, re-POST.
 * - `listenKeyExpired` event → close and reconnect at once (re-POST).
 * - unexpected close (incl. the 24 h socket cap) → reconnect with backoff 1 s … 30 s (+ jitter).
 * - tab hidden for `hiddenCloseMs` (5 min) → socket closed (status `paused`); visible again → reconnect + resync.
 * - heartbeat: a `{}` text frame every `heartbeatMs` (25 s). The public route cuts a socket after ~60 s without
 *   traffic (2026-10-01: idle socket closed 1006 at 64 s; with a 20 s client frame still open at 150 s) and fgw 0.3.1
 *   sends no pings; fgw ignores client text frames.
 * - `stop({ logout: true })` → `DELETE listenKey` (best effort, with the token the stream was opened with).
 */

export type UserStreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'paused' | 'stopped'

export interface UserStreamEvent {
  e: string
  E?: number
  [key: string]: unknown
}

export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(code?: number, reason?: string): void
  send?(data: string): void
}

export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface UserStreamDeps {
  createKey(): Promise<string>
  keepAlive(): Promise<void>
  closeKey(): Promise<void>
  /** `wss://ws.ttexxx.xyz/futures-user/ws` (no trailing slash). */
  wsBase: string
  socket(url: string): SocketLike
  visibility?: VisibilitySource | null
  random?: () => number
}

export interface UserStreamHandlers {
  onEvent(event: UserStreamEvent): void
  /** Socket open: rebuild from snapshots. `reconnect` false only for the first open after `start()`. */
  onOpen(info: { reconnect: boolean }): void
  onStatus?(status: UserStreamStatus): void
}

export const KEEPALIVE_MS = 30 * 60_000
export const HIDDEN_CLOSE_MS = 5 * 60_000
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
export const HEARTBEAT_MS = 25_000

export interface UserStreamOptions {
  keepAliveMs?: number
  heartbeatMs?: number
  hiddenCloseMs?: number
  backoffMs?: readonly number[]
}

export class UserStream {
  private socket: SocketLike | null = null
  private status: UserStreamStatus = 'idle'
  private started = false
  private paused = false
  private openedOnce = false
  private attempt = 0
  /** Bumped on every connect / close so late callbacks of an old socket or key request are ignored. */
  private epoch = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly keepAliveMs: number
  private readonly heartbeatMs: number
  private readonly hiddenCloseMs: number
  private readonly backoff: readonly number[]
  private readonly onVisibility = (): void => this.visibilityChanged()

  constructor(private readonly deps: UserStreamDeps, private readonly handlers: UserStreamHandlers, options: UserStreamOptions = {}) {
    this.keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.hiddenCloseMs = options.hiddenCloseMs ?? HIDDEN_CLOSE_MS
    this.backoff = options.backoffMs ?? BACKOFF_MS
  }

  get state(): UserStreamStatus {
    return this.status
  }

  get isOpen(): boolean {
    return this.status === 'open'
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.paused = false
    this.openedOnce = false
    this.attempt = 0
    this.deps.visibility?.addEventListener('visibilitychange', this.onVisibility)
    if (this.deps.visibility?.hidden === true) this.armHiddenTimer()
    void this.connect()
  }

  /** Stops everything; `logout` also closes the listenKey on the server. */
  stop(options: { logout?: boolean } = {}): void {
    if (!this.started) return
    this.started = false
    this.deps.visibility?.removeEventListener('visibilitychange', this.onVisibility)
    this.clearTimer('hidden')
    this.dropSocket()
    this.setStatus('stopped')
    if (options.logout === true) void this.deps.closeKey().catch(() => undefined)
  }

  /** Forces a reconnect now (e.g. the caller saw a gap); the next open resyncs. */
  reconnectNow(): void {
    if (!this.started || this.paused) return
    this.dropSocket()
    this.attempt = 0
    void this.connect()
  }

  private setStatus(next: UserStreamStatus): void {
    if (next === this.status) return
    this.status = next
    this.handlers.onStatus?.(next)
  }

  private clearTimer(which: 'reconnect' | 'keepalive' | 'hidden'): void {
    if (which === 'reconnect' && this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (which === 'keepalive' && this.keepAliveTimer !== null) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null }
    if (which === 'keepalive' && this.heartbeatTimer !== null) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (which === 'hidden' && this.hiddenTimer !== null) { clearTimeout(this.hiddenTimer); this.hiddenTimer = null }
  }

  /** Closes the current socket without triggering a reconnect (its callbacks are detached by the epoch bump). */
  private dropSocket(): void {
    this.epoch += 1
    this.clearTimer('reconnect')
    this.clearTimer('keepalive')
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try { socket.close(1000, 'client') } catch { /* already closed */ }
    }
  }

  private async connect(): Promise<void> {
    if (!this.started || this.paused) return
    const epoch = ++this.epoch
    this.clearTimer('reconnect')
    this.setStatus(this.openedOnce ? 'reconnecting' : 'connecting')
    let key: string
    try {
      key = await this.deps.createKey()
    } catch {
      if (epoch === this.epoch) this.scheduleReconnect()
      return
    }
    if (epoch !== this.epoch || !this.started || this.paused) return
    let socket: SocketLike
    try {
      socket = this.deps.socket(`${this.deps.wsBase}/${key}`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (epoch !== this.epoch) return
      const reconnect = this.openedOnce
      this.openedOnce = true
      this.attempt = 0
      this.setStatus('open')
      this.armKeepAlive(epoch)
      this.heartbeatTimer = setInterval(() => {
        if (epoch !== this.epoch) return
        try { socket.send?.('{}') } catch { /* closing; onclose reconnects */ }
      }, this.heartbeatMs)
      this.handlers.onOpen({ reconnect })
    }
    socket.onmessage = (message) => {
      if (epoch !== this.epoch) return
      this.receive(message.data)
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (epoch !== this.epoch) return
      this.socket = null
      this.clearTimer('keepalive')
      if (this.started && !this.paused) this.scheduleReconnect()
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let event: unknown
    try {
      event = parseLosslessJson(data)
    } catch {
      return
    }
    if (event === null || typeof event !== 'object' || typeof (event as { e?: unknown }).e !== 'string') return
    const typed = event as UserStreamEvent
    if (typed.e === 'listenKeyExpired') {
      // The server closes right after; reconnect at once with a fresh POST (no backoff).
      this.dropSocket()
      this.attempt = 0
      void this.connect()
      return
    }
    this.handlers.onEvent(typed)
  }

  private scheduleReconnect(): void {
    if (!this.started || this.paused) return
    this.clearTimer('reconnect')
    this.setStatus('reconnecting')
    const base = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 30_000
    this.attempt += 1
    const jitter = Math.round(base * 0.3 * (this.deps.random ?? Math.random)())
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, base + jitter)
  }

  private armKeepAlive(epoch: number): void {
    this.clearTimer('keepalive')
    this.keepAliveTimer = setInterval(() => {
      if (epoch !== this.epoch) return
      void this.deps.keepAlive().catch((error_: unknown) => {
        if (epoch !== this.epoch) return
        // -1125 (key unknown: gateway restart / expired) → reconnect re-POSTs. Other failures: next interval retries.
        if (isApiError(error_) && error_.code === '-1125') this.reconnectNow()
      })
    }, this.keepAliveMs)
  }

  private armHiddenTimer(): void {
    this.clearTimer('hidden')
    this.hiddenTimer = setTimeout(() => {
      this.hiddenTimer = null
      if (!this.started) return
      this.paused = true
      this.dropSocket()
      this.setStatus('paused')
    }, this.hiddenCloseMs)
  }

  private visibilityChanged(): void {
    if (!this.started) return
    if (this.deps.visibility?.hidden === true) {
      this.armHiddenTimer()
      return
    }
    this.clearTimer('hidden')
    if (this.paused) {
      this.paused = false
      this.attempt = 0
      void this.connect()
    }
  }
}

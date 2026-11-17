import {
  KlineSocket,
  type KlineSocketOptions,
  type MessageHandler,
  type SocketRequestOptions,
  type SocketState,
  type StateListener,
} from './kline-socket'
import type { SubscriptionEntry } from './subscription-registry'

/**
 * One market WebSocket per URL per tab.
 *
 * The spot market store, the spot chart, the futures store and the futures chart all used to open
 * their own sockets (plus one per chart history page). Each new socket costs a TLS + upgrade
 * handshake (1.3–1.8 s through the owner's proxy), so they now share one `KlineSocket` per URL:
 *
 * - `acquire(url)` returns a lease; the socket is reference counted across leases.
 * - Channels are owned per lease: `unsubscribe`/`unsubscribeAll` only drop what that lease
 *   registered, and a channel is unsubscribed on the wire only when no lease still wants it.
 * - Releasing the last lease closes the socket after a grace period, so a route change between two
 *   pages that both need the market (home -> trade) reuses the open connection.
 *
 * Reconnect, heartbeat and resubscribe stay in `KlineSocket`; the socket factory is injectable.
 */

export const SOCKET_RELEASE_GRACE_MS = 15_000

export interface SocketLease {
  readonly url: string
  readonly state: SocketState
  readonly isOpen: boolean
  onMessage(handler: MessageHandler): () => void
  onStateChange(listener: StateListener): () => void
  registerChannel(channel: string, params: Record<string, unknown>, kind?: SubscriptionEntry['kind']): void
  unsubscribe(channel: string): void
  /** Drops every channel this lease registered (other leases keep theirs). */
  unsubscribeAll(): void
  request(channel: string, params: Record<string, unknown>, options: SocketRequestOptions): () => void
  send(payload: { event: string; params: Record<string, unknown> }): boolean
  /** Reconnects when the shared socket is closed (no-op while connecting/open). */
  connect(): void
  /** Returns the lease; safe to call twice. */
  release(): void
}

export type SharedSocketFactory = (options: KlineSocketOptions) => KlineSocket

export interface SharedSocketPoolOptions {
  createSocket?: SharedSocketFactory
  graceMs?: number
}

interface PoolEntry {
  socket: KlineSocket
  leases: number
  owners: Map<string, Set<object>>
  closeTimer: ReturnType<typeof setTimeout> | null
}

export class SharedSocketPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly createSocket: SharedSocketFactory
  private readonly graceMs: number

  constructor(options: SharedSocketPoolOptions = {}) {
    this.createSocket = options.createSocket ?? ((socketOptions) => new KlineSocket(socketOptions))
    this.graceMs = options.graceMs ?? SOCKET_RELEASE_GRACE_MS
  }

  /** Number of live sockets (tests / diagnostics). */
  get size(): number {
    return this.entries.size
  }

  leaseCount(url: string): number {
    return this.entries.get(url)?.leases ?? 0
  }

  acquire(url: string): SocketLease {
    let entry = this.entries.get(url)
    if (entry === undefined) {
      entry = { socket: this.createSocket({ url }), leases: 0, owners: new Map(), closeTimer: null }
      this.entries.set(url, entry)
    }
    if (entry.closeTimer !== null) {
      clearTimeout(entry.closeTimer)
      entry.closeTimer = null
    }
    entry.leases += 1
    entry.socket.connect()
    return this.createLease(url, entry)
  }

  /** Closes every socket immediately (tests, page unload). */
  closeAll(): void {
    this.entries.forEach((entry) => {
      if (entry.closeTimer !== null) clearTimeout(entry.closeTimer)
      entry.socket.close()
    })
    this.entries.clear()
  }

  private createLease(url: string, entry: PoolEntry): SocketLease {
    const token = {}
    const owned = new Set<string>()
    const offs = new Set<() => void>()
    const cancels = new Set<() => void>()
    let released = false
    const socket = entry.socket

    const dropChannel = (channel: string): void => {
      owned.delete(channel)
      const owners = entry.owners.get(channel)
      owners?.delete(token)
      if (owners === undefined || owners.size === 0) {
        entry.owners.delete(channel)
        socket.unsubscribe(channel)
      }
    }
    const track = (off: () => void): (() => void) => {
      offs.add(off)
      return () => {
        offs.delete(off)
        off()
      }
    }

    const lease: SocketLease = {
      url,
      get state(): SocketState {
        return socket.state
      },
      get isOpen(): boolean {
        return socket.isOpen
      },
      onMessage: (handler) => (released ? () => undefined : track(socket.onMessage(handler))),
      onStateChange: (listener) => (released ? () => undefined : track(socket.onStateChange(listener))),
      registerChannel: (channel, params, kind = 'sub') => {
        if (released) return
        owned.add(channel)
        const owners = entry.owners.get(channel)
        if (owners === undefined) entry.owners.set(channel, new Set([token]))
        else owners.add(token)
        socket.registerChannel(channel, params, kind)
      },
      unsubscribe: (channel) => {
        if (!released && owned.has(channel)) dropChannel(channel)
      },
      unsubscribeAll: () => {
        ;[...owned].forEach(dropChannel)
      },
      request: (channel, params, options) => {
        if (released) {
          options.onSettle('cancelled')
          return () => undefined
        }
        let cancel: () => void = () => undefined
        const settleOnce: SocketRequestOptions['onSettle'] = (outcome, message) => {
          cancels.delete(cancel)
          options.onSettle(outcome, message)
        }
        cancel = socket.request(channel, params, { timeoutMs: options.timeoutMs, onSettle: settleOnce })
        cancels.add(cancel)
        return cancel
      },
      send: (payload) => (released ? false : socket.send(payload)),
      connect: () => {
        if (!released) socket.connect()
      },
      release: () => {
        if (released) return
        lease.unsubscribeAll()
        released = true
        ;[...cancels].forEach((cancel) => cancel())
        cancels.clear()
        offs.forEach((off) => off())
        offs.clear()
        this.releaseEntry(url, entry)
      },
    }
    return lease
  }

  private releaseEntry(url: string, entry: PoolEntry): void {
    entry.leases = Math.max(0, entry.leases - 1)
    if (entry.leases > 0 || entry.closeTimer !== null) return
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null
      if (entry.leases > 0 || this.entries.get(url) !== entry) return
      this.entries.delete(url)
      entry.socket.close()
    }, this.graceMs)
  }
}

/** The tab-wide pool used by the market stores and the chart datafeed. */
export const sharedSockets = new SharedSocketPool()

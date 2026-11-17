import type { WsEvent } from './protocol'

/** A channel the client wants to be subscribed to. Kept after a disconnect so it can be replayed. */
export interface SubscriptionEntry {
  channel: string
  /** `sub` for live streams, `req` for the K-line history request. */
  kind: Exclude<WsEvent, 'unsub'>
  params: Record<string, unknown>
}

/**
 * `sub:market_btcusdt_ticker` — the kind is part of the key because one channel can hold both a
 * history request (`req`) and a live subscription (`sub`).
 */
export function subscriptionKey(channel: string, kind: SubscriptionEntry['kind']): string {
  return `${kind}:${channel}`
}

/**
 * Tracks desired subscriptions independently of the socket, so a reconnect restores exactly the
 * same channel set (and only that set).
 */
export class SubscriptionRegistry {
  private readonly entries = new Map<string, SubscriptionEntry>()

  set(channel: string, kind: SubscriptionEntry['kind'], params: Record<string, unknown>): void {
    this.entries.set(subscriptionKey(channel, kind), { channel, kind, params })
  }

  has(channel: string, kind: SubscriptionEntry['kind']): boolean {
    return this.entries.has(subscriptionKey(channel, kind))
  }

  get(channel: string, kind: SubscriptionEntry['kind']): SubscriptionEntry | undefined {
    return this.entries.get(subscriptionKey(channel, kind))
  }

  /** Removes one kind of subscription, or every kind when `kind` is omitted. */
  delete(channel: string, kind?: SubscriptionEntry['kind']): boolean {
    if (kind !== undefined) {
      return this.entries.delete(subscriptionKey(channel, kind))
    }
    let removed = false
    this.forChannel(channel).forEach((entry) => {
      removed = this.entries.delete(subscriptionKey(entry.channel, entry.kind)) || removed
    })
    return removed
  }

  list(): SubscriptionEntry[] {
    return [...this.entries.values()]
  }

  /** Entries for one channel (both `req` and `sub`). */
  forChannel(channel: string): SubscriptionEntry[] {
    return this.list().filter((entry) => entry.channel === channel)
  }

  clear(): void {
    this.entries.clear()
  }
}

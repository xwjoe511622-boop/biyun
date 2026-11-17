import { canonicalDecimal, isDecimalString, toDecString } from '@/modules/finance/decimal'
import type { RawLevel } from '@/modules/market/book-aggregate'

/**
 * Sequenced futures depth client (futures-md `/fmd/v1`, Binance "diff depth" style).
 *
 *   REST  GET <snapshotUrl>?symbol=e_btcusdt&limit=N -> {symbol,lastUpdateId,E,bids:[[p,q]..],asks:[[p,q]..]}
 *         (503 until the server has seen a full book)
 *   WS    <wsUrl>, plain JSON text frames (not gzip):
 *         -> {"method":"SUBSCRIBE","params":["e_btcusdt@depth"],"id":1}
 *         <- {"result":null,"id":1}
 *         <- {"e":"depthUpdate","E":ms,"T":ms,"s":"e_btcusdt","U":first,"u":last,"b":[[p,q]..],"a":[[p,q]..]}
 *         <- {"e":"resync"}  (server-side lag: the client must resync)
 *
 * Sync (Binance): open the socket and subscribe, buffer events, fetch the snapshot, drop buffered
 * events with `u <= lastUpdateId`; the first applied event must satisfy `U <= lastUpdateId+1 <= u`
 * (else the snapshot is refetched, the buffer kept); afterwards every event must have
 * `U == previous u + 1`, otherwise the local book is discarded and resynced. Quantity "0" removes
 * a level. Quantities are contracts (same unit as the old `depth_step` channel).
 *
 * Failure policy (the caller shows its fallback book whenever the status is not `live`):
 *   - snapshot HTTP error / network error / timeout             -> `failed`
 *   - socket not open within `connectTimeoutMs` (first connect) -> `failed`
 *   - socket drop after it worked: reconnect with backoff; more than `maxReconnectAttempts`
 *     consecutive failed attempts                               -> `failed`
 *   - more than `maxResyncs` resyncs within `resyncWindowMs`     -> `failed`
 * While started, a `failed` client retries from scratch after `failRetryMinMs` (5 s), doubling per consecutive failure up
 * to `failRetryMs` (15 s); a sync that reaches `live` resets it. (10-02: a flat 60 s left the sequenced book off for
 * 28–44 s after a simulated 40 s md / gateway outage ended; the fallback book showed the whole time.)
 *
 * Diffs cover the whole book but the snapshot only the top `snapshotLimit` levels: when a side of
 * the snapshot was truncated, only levels inside its price range are emitted (levels beyond it are
 * known only partially); if that range thins out below `minKnownLevels` the snapshot is refreshed.
 */

export type SeqDepthStatus = 'idle' | 'connecting' | 'syncing' | 'live' | 'failed'

export interface SeqDepthBook {
  symbol: string
  lastUpdateId: number
  /** Nearest the spread first (bids descending, asks ascending); `diff` = change since the last emit. */
  bids: RawLevel[]
  asks: RawLevel[]
}

/** Minimal WebSocket surface used by the client (the browser `WebSocket` satisfies it). */
export interface SeqSocket {
  readonly readyState: number
  onopen: ((event?: unknown) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

export type SeqFetch = (url: string, init?: { signal?: AbortSignal; cache?: RequestCache; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface SeqDepthOptions {
  wsUrl: string
  /** Snapshot endpoint without query, e.g. `/fmd/v1/depth`. */
  snapshotUrl: string
  onBook: (book: SeqDepthBook) => void
  onStatus?: (status: SeqDepthStatus, reason?: string) => void
  snapshotLimit?: number
  /** Max levels per side handed to `onBook`. */
  maxLevels?: number
  /**
   * Book emits are throttled to at most one per interval (0 = emit synchronously): leading edge (the first change after
   * a quiet interval is emitted at once) plus a trailing emit for the rest of a burst.
   */
  emitIntervalMs?: number
  connectTimeoutMs?: number
  snapshotTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  maxReconnectAttempts?: number
  maxResyncs?: number
  resyncWindowMs?: number
  failRetryMs?: number
  /** First retry delay after a failure (doubles per consecutive failure up to `failRetryMs`). */
  failRetryMinMs?: number
  /** No event for this long while live: compare with a fresh snapshot to detect a silent socket. */
  idleCheckMs?: number
  minKnownLevels?: number
  maxBuffer?: number
  createSocket?: (url: string) => SeqSocket
  fetch?: SeqFetch
  now?: () => number
}

interface DepthEvent {
  U: number
  u: number
  b: unknown
  a: unknown
}

const OPEN = 1

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readLevels(rows: unknown, apply: (price: string, qty: string) => void): boolean {
  if (!Array.isArray(rows)) return rows === undefined || rows === null
  for (const row of rows) {
    if (!Array.isArray(row)) return false
    const price = canonicalDecimal(toDecString(row[0]))
    const qty = canonicalDecimal(toDecString(row[1]))
    if (!isDecimalString(price) || !isDecimalString(qty)) return false
    apply(price, qty)
  }
  return true
}

export class SeqDepthClient {
  private readonly opts: Required<Omit<SeqDepthOptions, 'onStatus'>> & Pick<SeqDepthOptions, 'onStatus'>
  private symbol = ''
  private running = false
  private status: SeqDepthStatus = 'idle'
  private socket: SeqSocket | null = null
  private everOpen = false
  private reconnectAttempts = 0
  /** Consecutive `failed` rounds (retry backoff); reset when a sync reaches `live`. */
  private failures = 0
  private resyncTimes: number[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private lastEventAt = 0
  private subscribeId = 0
  /** Bumped whenever a snapshot request becomes obsolete (resync, stop, reconnect). */
  private syncToken = 0
  private snapshotAbort: AbortController | null = null

  private readonly bids = new Map<string, string>()
  private readonly asks = new Map<string, string>()
  private readonly flash = new Map<string, 0 | 1 | 2>()
  /** Worst price of a truncated snapshot side (levels beyond are only partially known). */
  private bidEdge: number | null = null
  private askEdge: number | null = null
  private lastU = 0
  private synced = false
  /** First event after the snapshot: bracket rule instead of strict continuity. */
  private needFirst = true
  private buffer: DepthEvent[] = []

  constructor(options: SeqDepthOptions) {
    this.opts = {
      snapshotLimit: 500,
      maxLevels: 500,
      emitIntervalMs: 100,
      connectTimeoutMs: 5_000,
      snapshotTimeoutMs: 5_000,
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 15_000,
      maxReconnectAttempts: 3,
      maxResyncs: 5,
      resyncWindowMs: 60_000,
      failRetryMs: 15_000,
      failRetryMinMs: 5_000,
      idleCheckMs: 30_000,
      minKnownLevels: 20,
      maxBuffer: 5_000,
      createSocket: (url: string) => new WebSocket(url) as unknown as SeqSocket,
      fetch: ((url, init) => fetch(url, init)) as SeqFetch,
      now: () => Date.now(),
      ...options,
    }
  }

  get currentStatus(): SeqDepthStatus {
    return this.status
  }

  get currentSymbol(): string {
    return this.symbol
  }

  /** Starts (or restarts) the feed for `symbol` (`e_btcusdt`). */
  start(symbol: string): void {
    this.stop()
    this.symbol = symbol.trim().toLowerCase()
    if (this.symbol === '') return
    this.running = true
    this.everOpen = false
    this.reconnectAttempts = 0
    this.failures = 0
    this.resyncTimes = []
    this.connect()
  }

  stop(): void {
    this.running = false
    this.teardown()
    this.setStatus('idle')
  }

  // ---- connection ------------------------------------------------------------------------------

  private connect(): void {
    this.closeSocket()
    this.resetBook()
    this.setStatus('connecting')
    let socket: SeqSocket
    try {
      socket = this.opts.createSocket(this.opts.wsUrl)
    } catch {
      this.onSocketLost(null, 'ws-create')
      return
    }
    this.socket = socket
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.socket === socket && socket.readyState !== OPEN) this.onSocketLost(socket, 'ws-connect-timeout')
    }, this.opts.connectTimeoutMs)
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.clearConnectTimer()
      this.everOpen = true
      this.subscribeId += 1
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${this.symbol}@depth`], id: this.subscribeId }))
      // Also the reconnect path: every (re)connect starts from a fresh snapshot.
      this.beginSync()
    }
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onFrame(event.data)
    }
    socket.onerror = () => {
      // `onclose` follows; nothing to do here.
    }
    socket.onclose = () => {
      if (this.socket === socket) this.onSocketLost(socket, 'ws-closed')
    }
  }

  private onSocketLost(socket: SeqSocket | null, reason: string): void {
    if (socket !== null && this.socket !== socket) return
    this.closeSocket()
    if (!this.running) return
    this.resetBook()
    if (!this.everOpen) {
      this.fail(reason)
      return
    }
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > this.opts.maxReconnectAttempts) {
      this.fail(reason)
      return
    }
    this.setStatus('connecting')
    const delay = Math.min(this.opts.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1), this.opts.reconnectMaxDelayMs)
    this.later(() => {
      if (this.running && this.socket === null) this.connect()
    }, delay)
  }

  private closeSocket(): void {
    this.clearConnectTimer()
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private teardown(): void {
    this.syncToken += 1
    this.snapshotAbort?.abort()
    this.snapshotAbort = null
    this.closeSocket()
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    if (this.emitTimer !== null) clearTimeout(this.emitTimer)
    this.emitTimer = null
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.resetBook()
  }

  private fail(reason: string): void {
    this.teardown()
    this.setStatus('failed', reason)
    if (!this.running) return
    this.failures += 1
    const delay = Math.min(this.opts.failRetryMs, this.opts.failRetryMinMs * 2 ** (this.failures - 1))
    this.later(() => {
      if (!this.running) return
      this.everOpen = false
      this.reconnectAttempts = 0
      this.resyncTimes = []
      this.connect()
    }, delay)
  }

  private later(run: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, delay)
    this.timers.add(timer)
  }

  private setStatus(status: SeqDepthStatus, reason?: string): void {
    if (status === this.status && status !== 'failed') return
    this.status = status
    this.opts.onStatus?.(status, reason)
  }

  // ---- frames ----------------------------------------------------------------------------------

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (parsed === null || typeof parsed !== 'object') return
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    this.lastEventAt = this.opts.now()
    if (message.e === 'resync') {
      this.resync('server-resync')
      return
    }
    if (message.e === 'depthUpdate') {
      if (typeof message.s === 'string' && message.s.toLowerCase() !== this.symbol) return
      if (!isSeq(message.U) || !isSeq(message.u) || message.U > message.u) return
      this.onEvent({ U: message.U, u: message.u, b: message.b, a: message.a })
      return
    }
    if (message.error !== undefined && message.id === this.subscribeId) this.fail('subscribe-rejected')
  }

  private onEvent(event: DepthEvent): void {
    if (!this.synced) {
      this.buffer.push(event)
      if (this.buffer.length > this.opts.maxBuffer) this.resync('buffer-overflow')
      return
    }
    const result = this.accept(event)
    if (result === 'gap' || result === 'invalid') this.resync(result)
    else if (result === 'applied') this.scheduleEmit()
  }

  /** Continuity check + apply. */
  private accept(event: DepthEvent): 'stale' | 'gap' | 'applied' | 'invalid' {
    if (event.u <= this.lastU) return 'stale'
    const next = this.lastU + 1
    if (this.needFirst ? event.U > next : event.U !== next) return 'gap'
    if (!this.applyLevels(event.b, this.bids) || !this.applyLevels(event.a, this.asks)) return 'invalid'
    this.lastU = event.u
    this.needFirst = false
    return 'applied'
  }

  private applyLevels(rows: unknown, map: Map<string, string>): boolean {
    return readLevels(rows, (price, qty) => {
      const previous = map.get(price)
      if (qty === '0') {
        if (previous !== undefined) {
          map.delete(price)
          this.flash.set(price, 2)
        }
        return
      }
      this.flash.set(price, previous === undefined ? 1 : Number(qty) > Number(previous) ? 1 : Number(qty) < Number(previous) ? 2 : 0) // float-ok: flash direction (UI), the qty string is stored
      map.set(price, qty)
    })
  }

  // ---- snapshot sync ---------------------------------------------------------------------------

  private resetBook(): void {
    this.bids.clear()
    this.asks.clear()
    this.flash.clear()
    this.bidEdge = null
    this.askEdge = null
    this.lastU = 0
    this.synced = false
    this.needFirst = true
    this.buffer = []
  }

  private beginSync(keepBuffer = false): void {
    const buffer = keepBuffer ? this.buffer : []
    this.resetBook()
    this.buffer = buffer
    this.setStatus('syncing')
    void this.loadSnapshot()
  }

  /** Discards the local book and syncs again from a new snapshot (socket kept). */
  private resync(reason: string, keepBuffer = false): void {
    if (!this.running || this.socket === null) return
    const now = this.opts.now()
    this.resyncTimes = this.resyncTimes.filter((at) => now - at < this.opts.resyncWindowMs)
    this.resyncTimes.push(now)
    if (this.resyncTimes.length > this.opts.maxResyncs) {
      this.fail(`resync-limit:${reason}`)
      return
    }
    this.syncToken += 1
    this.snapshotAbort?.abort()
    this.snapshotAbort = null
    this.beginSync(keepBuffer)
  }

  private snapshotRequestUrl(): string {
    const separator = this.opts.snapshotUrl.includes('?') ? '&' : '?'
    return `${this.opts.snapshotUrl}${separator}symbol=${encodeURIComponent(this.symbol)}&limit=${this.opts.snapshotLimit}`
  }

  private async fetchSnapshot(): Promise<{ lastUpdateId: number; bids: unknown; asks: unknown }> {
    const abort = typeof AbortController === 'undefined' ? null : new AbortController()
    this.snapshotAbort = abort
    const timer = setTimeout(() => abort?.abort(), this.opts.snapshotTimeoutMs)
    try {
      const response = await this.opts.fetch(this.snapshotRequestUrl(), {
        signal: abort?.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`snapshot-http-${response.status}`)
      const body = (await response.json()) as Record<string, unknown> | null
      if (body === null || typeof body !== 'object' || !isSeq(body.lastUpdateId)) throw new Error('snapshot-invalid')
      return { lastUpdateId: body.lastUpdateId, bids: body.bids, asks: body.asks }
    } finally {
      clearTimeout(timer)
      if (this.snapshotAbort === abort) this.snapshotAbort = null
    }
  }

  private async loadSnapshot(): Promise<void> {
    const token = (this.syncToken += 1)
    let snapshot: { lastUpdateId: number; bids: unknown; asks: unknown }
    try {
      snapshot = await this.fetchSnapshot()
    } catch (error) {
      if (token !== this.syncToken || !this.running) return
      const reason = error instanceof Error && error.message.startsWith('snapshot-') ? error.message : 'snapshot-error'
      this.fail(reason)
      return
    }
    if (token !== this.syncToken || !this.running) return
    this.bids.clear()
    this.asks.clear()
    this.flash.clear()
    let bidCount = 0
    let askCount = 0
    let worstBid: number | null = null
    let worstAsk: number | null = null
    const bidsOk = readLevels(snapshot.bids, (price, qty) => {
      bidCount += 1
      worstBid = worstBid === null ? Number(price) : Math.min(worstBid, Number(price)) // float-ok: snapshot edge for book display trimming; level strings kept
      if (qty !== '0') this.bids.set(price, qty)
    })
    const asksOk = readLevels(snapshot.asks, (price, qty) => {
      askCount += 1
      worstAsk = worstAsk === null ? Number(price) : Math.max(worstAsk, Number(price)) // float-ok: snapshot edge for book display trimming; level strings kept
      if (qty !== '0') this.asks.set(price, qty)
    })
    if (!bidsOk || !asksOk) {
      this.fail('snapshot-invalid')
      return
    }
    this.bidEdge = bidCount >= this.opts.snapshotLimit ? worstBid : null
    this.askEdge = askCount >= this.opts.snapshotLimit ? worstAsk : null
    this.lastU = snapshot.lastUpdateId
    this.needFirst = true

    const pending = this.buffer
    this.buffer = []
    for (let index = 0; index < pending.length; index += 1) {
      const result = this.accept(pending[index])
      if (result === 'gap') {
        if (this.needFirst) {
          // Snapshot older than the buffered stream: refetch, keeping the events not yet applied.
          this.buffer = pending.slice(index)
          this.resync('snapshot-behind', true)
        } else {
          this.resync('gap')
        }
        return
      }
      if (result === 'invalid') {
        this.resync('invalid')
        return
      }
    }
    this.synced = true
    this.reconnectAttempts = 0
    this.failures = 0
    this.lastEventAt = this.opts.now()
    this.startIdleCheck()
    this.setStatus('live')
    this.emit()
  }

  private startIdleCheck(): void {
    if (this.idleTimer !== null || this.opts.idleCheckMs <= 0) return
    this.idleTimer = setInterval(() => {
      if (this.status !== 'live' || this.opts.now() - this.lastEventAt < this.opts.idleCheckMs) return
      const token = this.syncToken
      const seen = this.lastU
      this.fetchSnapshot().then(
        (snapshot) => {
          // The server moved on without us hearing about it: the socket is silently dead.
          if (token === this.syncToken && this.running && snapshot.lastUpdateId > seen && this.lastU === seen) {
            this.onSocketLost(this.socket, 'ws-idle')
          } else {
            this.lastEventAt = this.opts.now()
          }
        },
        () => undefined,
      )
    }, Math.max(1_000, Math.floor(this.opts.idleCheckMs / 2)))
  }

  // ---- output ----------------------------------------------------------------------------------

  private scheduleEmit(): void {
    if (this.opts.emitIntervalMs <= 0) {
      this.emit()
      return
    }
    if (this.emitTimer !== null) return
    const wait = this.lastEmitAt + this.opts.emitIntervalMs - this.opts.now()
    if (wait <= 0) {
      this.emit()
      return
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit()
    }, wait)
  }

  private side(map: Map<string, string>, side: 'bid' | 'ask'): RawLevel[] {
    const edge = side === 'bid' ? this.bidEdge : this.askEdge
    const entries: { price: string; value: number; amount: string }[] = []
    map.forEach((amount, price) => {
      const value = Number(price) // float-ok: book display ordering / edge filter; price string kept
      if (edge === null || (side === 'bid' ? value >= edge : value <= edge)) entries.push({ price, value, amount })
    })
    entries.sort((left, right) => (side === 'bid' ? right.value - left.value : left.value - right.value))
    return entries.slice(0, this.opts.maxLevels).map((entry) => ({ price: entry.price, amount: entry.amount, diff: this.flash.get(entry.price) ?? 0 }))
  }

  private emit(): void {
    if (this.emitTimer !== null) clearTimeout(this.emitTimer)
    this.emitTimer = null
    if (!this.synced || this.status !== 'live') return
    const bids = this.side(this.bids, 'bid')
    const asks = this.side(this.asks, 'ask')
    this.flash.clear()
    this.lastEmitAt = this.opts.now()
    const thin = (this.bidEdge !== null && bids.length < this.opts.minKnownLevels) || (this.askEdge !== null && asks.length < this.opts.minKnownLevels)
    this.opts.onBook({ symbol: this.symbol, lastUpdateId: this.lastU, bids, asks })
    // The known (snapshot-covered) range has thinned out: refresh it.
    if (thin) this.resync('known-range-thin')
  }
}

/**
 * Feature switch: `localStorage['picat.futures.seqDepth']` = '1' / '0' (debug override) wins over the
 * build-time `VITE_FUTURES_SEQ_DEPTH` ('0' / 'false' / 'off' disables); default on.
 */
export const SEQ_DEPTH_STORAGE_KEY = 'picat.futures.seqDepth'

export function isFuturesSeqDepthEnabled(env: string | undefined = import.meta.env.VITE_FUTURES_SEQ_DEPTH): boolean {
  return seqDepthSwitch(SEQ_DEPTH_STORAGE_KEY, env)
}

/** Spot book: `localStorage['picat.spot.seqDepth']` / build-time `VITE_SPOT_SEQ_DEPTH` (spot-md `/smd/v1`); default on. */
export const SPOT_SEQ_DEPTH_STORAGE_KEY = 'picat.spot.seqDepth'

export function isSpotSeqDepthEnabled(env: string | undefined = import.meta.env.VITE_SPOT_SEQ_DEPTH): boolean {
  return seqDepthSwitch(SPOT_SEQ_DEPTH_STORAGE_KEY, env)
}

function seqDepthSwitch(storageKey: string, env: string | undefined): boolean {
  try {
    const override = localStorage.getItem(storageKey)
    if (override === '1' || override === 'true' || override === 'on') return true
    if (override === '0' || override === 'false' || override === 'off') return false
  } catch {
    // Storage blocked: build setting only.
  }
  const value = (env ?? '').trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'off')
}

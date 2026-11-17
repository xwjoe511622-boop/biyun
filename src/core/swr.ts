import { shallowRef, type ShallowRef } from 'vue'
import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'

/**
 * Front-end state conventions for trading data (2026-09-29, "下单后页面闪一下"). One small toolbox shared by the spot,
 * margin and futures stores; see docs/03-reference/frontend/frontend-modernization.md §前端状态管理约定.
 *
 * 1. Stale-while-revalidate — a refetch never swaps a table for a loading block. `listPhase()` decides what a panel
 *    shows: rows win whenever there are rows; the full loading state is only for the very first load (`loaded=false`).
 * 2. Fetch → commit — a loader first fetches and returns a *commit* closure; a batch awaits every fetch and then runs
 *    all commits synchronously (`commitAll`), so one refresh after an action is one render, not three or four.
 * 3. Coalesced refresh — actions call `request('open', 'account', …)` instead of awaiting loaders; requests inside a
 *    short window (and any made while a run is in flight) are merged into one trailing run.
 * 4. Merge by id — `mergeById` keeps the previous row objects when nothing changed, so Vue patches only changed cells
 *    and the list keeps its DOM (keys are always the order/position id).
 * 5. Optimistic balance — `createBalanceOverlay` adds signed deltas on top of the last server snapshot until a server
 *    snapshot requested after the action settled replaces them; a failed action rolls its delta back.
 */

export type ListPhase = 'loading' | 'error' | 'empty' | 'ready'

/** What a list panel shows. Rows win (a refetch or a failed refresh keeps them); a loading block only before the first answer. */
export function listPhase(state: { rows: number; loaded: boolean; error: string | null }): ListPhase {
  if (state.rows > 0) return 'ready'
  if (state.error !== null) return 'error'
  return state.loaded ? 'empty' : 'loading'
}

/** A fetch that resolves to a commit closure, or `null` when the answer is stale / was handled. */
export type Commit = (() => void) | null

/** Runs every commit in one synchronous block, so Vue renders the whole batch once. */
export function commitAll(commits: readonly Commit[]): void {
  for (const commit of commits) commit?.()
}

function shallowEqual(left: object, right: object): boolean {
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

/**
 * The server's `next` list in the server's order, reusing the previous object for every row whose fields did not
 * change. Returns `previous` itself when nothing changed at all (a no-op for a `shallowRef`).
 */
export function mergeById<T extends object>(previous: readonly T[], next: readonly T[], key: (row: T) => string): T[] {
  const byId = new Map(previous.map((row) => [key(row), row]))
  let changed = previous.length !== next.length
  const merged = next.map((row, index) => {
    const old = byId.get(key(row))
    const keep = old !== undefined && shallowEqual(old, row) ? old : row
    if (keep !== previous[index]) changed = true
    return keep
  })
  return changed ? merged : (previous as T[])
}

export interface CoalescedRefresh<K extends string> {
  /** Adds parts to the next run; resolves when a run containing them has finished. */
  request(...parts: K[]): Promise<void>
  /** Drops anything scheduled (logout / reset); an in-flight run finishes but nothing follows it. */
  cancel(): void
}

/**
 * One trailing run for all requests made within `delayMs` (and for requests made while a run is in flight, which get
 * exactly one follow-up run). `run` receives the union of the requested parts.
 */
export function createCoalescedRefresh<K extends string>(run: (parts: ReadonlySet<K>) => Promise<void>, delayMs = 120): CoalescedRefresh<K> {
  let pending = new Set<K>()
  let waiters: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  function schedule(): void {
    if (timer !== null || running) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delayMs)
  }

  async function flush(): Promise<void> {
    if (pending.size === 0) return
    const parts = pending
    const done = waiters
    pending = new Set()
    waiters = []
    running = true
    try {
      await run(parts)
    } catch {
      // Loaders report their own errors; a failed refresh must not break the next one.
    } finally {
      running = false
      done.forEach((resolve) => resolve())
      if (pending.size > 0) schedule()
    }
  }

  return {
    request(...parts: K[]): Promise<void> {
      parts.forEach((part) => pending.add(part))
      const promise = new Promise<void>((resolve) => waiters.push(resolve))
      schedule()
      return promise
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = new Set()
      const done = waiters
      waiters = []
      done.forEach((resolve) => resolve())
    },
  }
}

export interface OverlayHandle {
  /** The server accepted the action: the delta stays until a snapshot requested after this moment arrives. */
  settle(): void
  /** The action failed: the delta disappears at once. */
  rollback(): void
}

export interface BalanceOverlay {
  readonly entries: ShallowRef<readonly OverlayEntry[]>
  /** Adds signed deltas, e.g. `{ 'USDT:available': '-12', 'USDT:locked': '12' }`. */
  apply(changes: Record<string, string>): OverlayHandle
  /** `value` plus every live delta for `key`; an unknown value (`''`) stays unknown. */
  adjust(key: string, value: string): string
  /** Call when a server snapshot request starts; pass the stamp to `reconcile` when its answer is committed. */
  stamp(): number
  reconcile(stamp: number): void
  clear(): void
}

export interface OverlayEntry {
  id: number
  changes: Record<string, string>
  settledAt: number | null
}

const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/

/** Optimistic balance deltas over the last server snapshot (see convention 5 above). */
export function createBalanceOverlay(): BalanceOverlay {
  const entries = shallowRef<readonly OverlayEntry[]>([])
  let clock = 0
  let ids = 0

  function apply(changes: Record<string, string>): OverlayHandle {
    const entry: OverlayEntry = { id: ++ids, changes, settledAt: null }
    entries.value = [...entries.value, entry]
    return {
      settle(): void {
        if (!entries.value.includes(entry)) return
        entries.value = entries.value.map((row) => (row === entry ? { ...row, settledAt: ++clock } : row))
      },
      rollback(): void {
        entries.value = entries.value.filter((row) => row.id !== entry.id)
      },
    }
  }

  function adjust(key: string, value: string): string {
    const base = canonicalDecimal(value)
    if (!isDecimalString(base)) return value
    let total = new Decimal(base)
    let touched = false
    for (const entry of entries.value) {
      const delta = entry.changes[key]
      if (delta === undefined || !SIGNED_DECIMAL.test(delta)) continue
      total = total.plus(delta)
      touched = true
    }
    if (!touched) return value
    // An optimistic estimate never shows a negative balance; the server snapshot settles the exact figure.
    return canonicalDecimal(Decimal.max(total, 0).toFixed())
  }

  return {
    entries,
    apply,
    adjust,
    stamp: () => clock,
    reconcile(stamp: number): void {
      const kept = entries.value.filter((entry) => entry.settledAt === null || entry.settledAt > stamp)
      if (kept.length !== entries.value.length) entries.value = kept
    },
    clear(): void {
      if (entries.value.length > 0) entries.value = []
    },
  }
}

let tempIds = 0
/** Id for an optimistic row until the server answers with the real one. */
export function pendingId(): string {
  tempIds += 1
  return `pending-${Date.now().toString(36)}-${tempIds}`
}

export function isPendingId(id: string): boolean {
  return id.startsWith('pending-')
}

/** `YYYY-MM-DD HH:mm:ss` in UTC (the spot list's `created_at` format) for an optimistic row. */
export function utcTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/**
 * Orders-centre data model (pure, framework-free so it is unit-testable).
 *
 * The spot/lever order and fill endpoints are sharded per pair: `order/list/new`, `order/entrust_history`,
 * `trade/list`, `lever/order/list/new`, `lever/order/history` all reject a request without `symbol`
 * (OrderAct.java:475/793/940, LeverOrderAct.java:370/450), and `order/list/all` also requires it
 * (OrderAct.java:1051). An "all pairs" view therefore reads every pair page by page and merges the rows
 * by time. The merged feed keeps a per-pair cursor so "load more" fetches only pairs with rows left.
 */

export interface FeedPage<T> {
  count: number
  rows: T[]
}

export type FeedFetcher<T> = (symbol: string, page: number, pageSize: number) => Promise<FeedPage<T>>

export interface FeedCursor {
  symbol: string
  /** Last page fetched (0 = nothing yet). */
  page: number
  /** Server `count` for the pair (`-1` = unknown yet). */
  count: number
  loaded: number
  error: string | null
}

export interface FeedRow<T> {
  /** Lower-case pair symbol the row came from. */
  symbol: string
  item: T
  /** Epoch ms used for merging / date filtering (`null` = unknown, sorts last). */
  time: number | null
}

/** Column used both for rendering and CSV export, so the file always matches the screen. */
export interface FeedColumn<R> {
  key: string
  label: string
  value: (row: FeedRow<R>) => string
  className?: (row: FeedRow<R>) => string
  align?: 'left' | 'right'
}

export interface MergedFeed<T> {
  cursors: FeedCursor[]
  rows: FeedRow<T>[]
}

export function emptyFeed<T>(symbols: string[]): MergedFeed<T> {
  return { cursors: symbols.map(symbol => ({ symbol, page: 0, count: -1, loaded: 0, error: null })), rows: [] }
}

export function hasMore(feed: MergedFeed<unknown>): boolean {
  return feed.cursors.some(cursor => cursor.error === null && (cursor.count === -1 || cursor.loaded < cursor.count))
}

export function totalCount(feed: MergedFeed<unknown>): number {
  return feed.cursors.reduce((total, cursor) => total + Math.max(0, cursor.count), 0) // float-ok: record count
}

function byTimeDesc<T>(left: FeedRow<T>, right: FeedRow<T>): number {
  if (left.time === right.time) return 0
  if (left.time === null) return 1
  if (right.time === null) return -1
  return right.time - left.time
}

async function mapLimit<I, O>(items: I[], limit: number, task: (item: I) => Promise<O>): Promise<O[]> {
  const results: O[] = new Array<O>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Fetches the next page of every pair that still has rows and merges everything by time (desc).
 * Per-pair failures are recorded on the cursor and never fabricate rows.
 */
export async function loadNextPages<T>(
  feed: MergedFeed<T>,
  fetcher: FeedFetcher<T>,
  options: { pageSize: number; timeOf: (item: T) => number | null; concurrency?: number },
): Promise<MergedFeed<T>> {
  const pending = feed.cursors.filter(cursor => cursor.error === null && (cursor.count === -1 || cursor.loaded < cursor.count))
  const results = await mapLimit(pending, options.concurrency ?? 4, async (cursor) => {
    try {
      const page = await fetcher(cursor.symbol, cursor.page + 1, options.pageSize)
      return { symbol: cursor.symbol, page, error: null as string | null }
    } catch (error_) {
      return { symbol: cursor.symbol, page: null, error: error_ instanceof Error ? error_.message : String(error_) }
    }
  })
  const bySymbol = new Map(results.map(result => [result.symbol, result]))
  const newRows: FeedRow<T>[] = []
  const cursors = feed.cursors.map((cursor) => {
    const result = bySymbol.get(cursor.symbol)
    if (result === undefined) return cursor
    if (result.page === null) return { ...cursor, error: result.error }
    result.page.rows.forEach(item => newRows.push({ symbol: cursor.symbol, item, time: options.timeOf(item) }))
    const loaded = cursor.loaded + result.page.rows.length
    // An empty page means the pair is exhausted even if `count` disagrees (API-token users get a fixed count).
    const count = result.page.rows.length === 0 ? loaded : Math.max(result.page.count, loaded)
    return { ...cursor, page: cursor.page + 1, count, loaded, error: null }
  })
  return { cursors, rows: [...feed.rows, ...newRows].sort(byTimeDesc) }
}

export interface RowFilter {
  side: '' | 'BUY' | 'SELL'
  /** `YYYY-MM-DD` (local), inclusive; empty = open. */
  from: string
  to: string
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** UTC-midnight epoch ms for `YYYY-MM-DD`, or `null`. `endOfDay` returns 23:59:59.999. */
export function dateBoundary(value: string, endOfDay = false): number | null {
  const match = DATE.exec(value.trim())
  if (match === null) return null
  const date = endOfDay
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)) // float-ok: date parts (year/month/day)
    : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)) // float-ok: date parts (year/month/day)
  if (Number.isNaN(date.getTime())) return null
  const actual = `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  return actual === value.trim() ? date.getTime() : null
}

export function filterRows<T>(rows: FeedRow<T>[], filter: RowFilter, sideOf: (item: T) => string): FeedRow<T>[] {
  const from = dateBoundary(filter.from)
  const to = dateBoundary(filter.to, true)
  return rows.filter((row) => {
    if (filter.side !== '' && sideOf(row.item).toUpperCase() !== filter.side) return false
    if (from !== null && (row.time === null || row.time < from)) return false
    if (to !== null && (row.time === null || row.time > to)) return false
    return true
  })
}

export interface PageSlice<T> {
  rows: T[]
  page: number
  pages: number
}

export function paginate<T>(rows: T[], page: number, pageSize: number): PageSlice<T> {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(Math.max(1, Math.trunc(page)), pages)
  return { rows: rows.slice((current - 1) * pageSize, current * pageSize), page: current, pages }
}

/** `yyyy-MM-dd HH:mm:ss` in UTC (the server's DateUtils.FORMAT_LONG), `--` when unknown. */
export function formatDateTime(time: number | null | undefined): string {
  if (time === null || time === undefined || !Number.isFinite(time) || time <= 0) return '--'
  const date = new Date(time)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/** Server-side date filter strings for lever/borrow/* (DateUtils.parse, `yyyy-MM-dd HH:mm:ss`). */
export function toServerDate(value: string, endOfDay = false): string {
  const boundary = dateBoundary(value, endOfDay)
  return boundary === null ? '' : formatDateTime(endOfDay ? boundary - 999 : boundary)
}

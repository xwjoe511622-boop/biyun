import { describe, expect, it, vi } from 'vitest'
import { csvCell, toCsv } from '@/components/orders/csv'
import { dateBoundary, emptyFeed, filterRows, hasMore, loadNextPages, paginate, toServerDate, totalCount, type FeedRow } from '@/components/orders/model'

interface Row { id: string; t: number; side: string }

function rows(symbol: string, times: number[]): Row[] {
  return times.map(time => ({ id: `${symbol}-${time}`, t: time, side: time % 2 === 0 ? 'BUY' : 'SELL' }))
}

describe('merged per-pair feed', () => {
  it('fetches every pair, merges by time desc and tracks per-pair cursors', async () => {
    const data: Record<string, Row[]> = { btcusdt: rows('btc', [50, 30, 10]), ethusdt: rows('eth', [40, 20]) }
    const fetcher = vi.fn(async (symbol: string, page: number, size: number) => ({
      count: data[symbol].length,
      rows: data[symbol].slice((page - 1) * size, page * size),
    }))
    let feed = emptyFeed<Row>(['btcusdt', 'ethusdt'])
    expect(hasMore(feed)).toBe(true)
    feed = await loadNextPages(feed, fetcher, { pageSize: 2, timeOf: row => row.t })
    expect(fetcher).toHaveBeenCalledWith('btcusdt', 1, 2)
    expect(fetcher).toHaveBeenCalledWith('ethusdt', 1, 2)
    expect(feed.rows.map(row => row.item.t)).toEqual([50, 40, 30, 20])
    expect(totalCount(feed)).toBe(5)
    expect(hasMore(feed)).toBe(true)

    fetcher.mockClear()
    feed = await loadNextPages(feed, fetcher, { pageSize: 2, timeOf: row => row.t })
    // Only the pair with rows left is requested again.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('btcusdt', 2, 2)
    expect(feed.rows.map(row => row.item.t)).toEqual([50, 40, 30, 20, 10])
    expect(hasMore(feed)).toBe(false)
  })

  it('records a failing pair without fabricating rows and keeps the others', async () => {
    const fetcher = vi.fn(async (symbol: string) => {
      if (symbol === 'bad') throw new Error('boom')
      return { count: 1, rows: rows('ok', [5]) }
    })
    const feed = await loadNextPages(emptyFeed<Row>(['ok', 'bad']), fetcher, { pageSize: 10, timeOf: row => row.t })
    expect(feed.rows).toHaveLength(1)
    expect(feed.cursors.find(cursor => cursor.symbol === 'bad')?.error).toBe('boom')
    expect(hasMore(feed)).toBe(false)
  })

  it('treats an empty page as exhausted even when count claims more', async () => {
    const fetcher = vi.fn(async () => ({ count: 20, rows: [] as Row[] }))
    const feed = await loadNextPages(emptyFeed<Row>(['x']), fetcher, { pageSize: 10, timeOf: row => row.t })
    expect(hasMore(feed)).toBe(false)
  })
})

describe('filters and pagination', () => {
  const day = (text: string, hour: number): number => new Date(`${text}T${String(hour).padStart(2, '0')}:00:00Z`).getTime()
  const sample: FeedRow<Row>[] = [
    { symbol: 'a', item: { id: '1', t: 0, side: 'BUY' }, time: day('2026-09-20', 10) },
    { symbol: 'a', item: { id: '2', t: 0, side: 'SELL' }, time: day('2026-09-21', 23) },
    { symbol: 'a', item: { id: '3', t: 0, side: 'buy' }, time: day('2026-09-22', 0) },
    { symbol: 'a', item: { id: '4', t: 0, side: 'SELL' }, time: null },
  ]

  it('filters by side (case-insensitive) and inclusive UTC dates', () => {
    expect(filterRows(sample, { side: 'BUY', from: '', to: '' }, row => row.side).map(row => row.item.id)).toEqual(['1', '3'])
    expect(filterRows(sample, { side: '', from: '2026-09-21', to: '2026-09-21' }, row => row.side).map(row => row.item.id)).toEqual(['2'])
    expect(filterRows(sample, { side: '', from: '', to: '' }, row => row.side)).toHaveLength(4)
    expect(dateBoundary('bad')).toBeNull()
  })

  it('paginates with clamping', () => {
    const list = Array.from({ length: 23 }, (_, index) => index)
    expect(paginate(list, 1, 10)).toEqual({ rows: list.slice(0, 10), page: 1, pages: 3 })
    expect(paginate(list, 3, 10).rows).toEqual([20, 21, 22])
    expect(paginate(list, 9, 10).page).toBe(3)
    expect(paginate([], 1, 10)).toEqual({ rows: [], page: 1, pages: 1 })
  })

  it('formats server date filters as yyyy-MM-dd HH:mm:ss', () => {
    expect(toServerDate('2026-09-21')).toBe('2026-09-21 00:00:00')
    expect(toServerDate('2026-09-21', true)).toBe('2026-09-21 23:59:59')
    expect(toServerDate('')).toBe('')
  })
})

describe('csv export', () => {
  it('quotes separators and neutralises spreadsheet formulas but keeps numbers', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-12.5')).toBe('-12.5')
  })

  it('builds header + rows with CRLF', () => {
    const csv = toCsv([{ label: '时间', value: (row: { a: string }) => row.a }, { label: 'x', value: () => '1' }], [{ a: '2026-09-21 10:00:00' }])
    expect(csv).toBe('时间,x\r\n2026-09-21 10:00:00,1')
    expect(toCsv([{ label: 'avg', value: () => '--' }], [{}])).toBe('avg\r\n')
  })
})

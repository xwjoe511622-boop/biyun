import { add, canonicalDecimal, cmp, toDecString } from '@/modules/finance/decimal'
import type { DepthDelta, DepthSnapshot } from '@/modules/ws/protocol'
import type { DepthLevel } from '@/stores/market'
import type { RawLevel } from './book-aggregate'

/**
 * Order book state for one depth channel: full snapshot then per-level deltas (spot and futures
 * use the same framing, legacy `futureWebsocket.js:273-330`). Levels are keyed by canonical price
 * strings.
 */
export class DepthBook {
  private readonly asks = new Map<string, string>()
  private readonly bids = new Map<string, string>()
  private readonly flash = new Map<string, 0 | 1 | 2>()

  get size(): { asks: number; bids: number } {
    return { asks: this.asks.size, bids: this.bids.size }
  }

  clear(): void {
    this.asks.clear()
    this.bids.clear()
    this.flash.clear()
  }

  applySnapshot(tick: DepthSnapshot): void {
    this.clear()
    const load = (rows: DepthSnapshot['asks'], map: Map<string, string>): void => {
      ;(rows ?? []).forEach((row) => {
        const price = canonicalDecimal(toDecString(row[0]))
        const amount = canonicalDecimal(toDecString(row[1]))
        if (price !== '' && amount !== '' && amount !== '0') map.set(price, amount)
      })
    }
    load(tick.asks, this.asks)
    load(tick.buys, this.bids)
  }

  applyDelta(tick: DepthDelta): void {
    const price = canonicalDecimal(toDecString(tick.price))
    const amount = canonicalDecimal(toDecString(tick.volume))
    if (price === '' || amount === '') return
    const map = tick.side === 'asks' ? this.asks : this.bids
    const previous = map.get(price)
    if (amount === '0') {
      map.delete(price)
      this.flash.set(price, 2)
      return
    }
    this.flash.set(price, previous === undefined ? 1 : cmp(amount, previous) > 0 ? 1 : cmp(amount, previous) < 0 ? 2 : 0)
    map.set(price, amount)
    // A new level through the other side (e.g. a crossing taker order pushed before the fills
    // that consumed the resting levels) means those opposite levels are gone: the newest update
    // wins, so the book is never shown locked/crossed until the next snapshot.
    const other = tick.side === 'asks' ? this.bids : this.asks
    for (const level of [...other.keys()]) {
      const crossed = tick.side === 'asks' ? cmp(level, price) >= 0 : cmp(level, price) <= 0
      if (crossed) other.delete(level)
    }
  }

  /** Raw levels of one side, nearest the spread first, with their flash markers (kept). */
  levels(side: 'ask' | 'bid'): RawLevel[] {
    const map = side === 'ask' ? this.asks : this.bids
    const ascending = side === 'ask'
    return [...map.keys()]
      .sort((left, right) => (ascending ? cmp(left, right) : cmp(right, left)))
      .map((price) => ({ price, amount: map.get(price) ?? '0', diff: this.flash.get(price) ?? 0 }))
  }

  clearFlash(): void {
    this.flash.clear()
  }

  /** Rows nearest the spread first, with running totals; clears the flash markers. */
  build(maxRows: number): { asks: DepthLevel[]; buys: DepthLevel[] } {
    const rows = (side: 'ask' | 'bid'): DepthLevel[] => {
      let running = '0'
      return this.levels(side).slice(0, maxRows).map((level) => {
        running = add(running, level.amount)
        return { price: level.price, amount: level.amount, total: running, diff: level.diff ?? 0 }
      })
    }
    const result = { asks: rows('ask'), buys: rows('bid') }
    this.flash.clear()
    return result
  }
}

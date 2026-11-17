// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, reactive, type App } from 'vue'
import OrderBook from '@/components/trade/OrderBook.vue'
import { MARKET_SOURCE, type MarketSource } from '@/components/trade/market-source'
import { i18n } from '@/i18n'
import { SKIN } from '@/core/skin'
import { bidShare, bookSpread, bucketPrice, coarseChannelForStep, composeSide, extendDepthSteps, groupLevels, sweepStats, tickDepthSteps, tickFromPrecision } from '@/modules/market/book-aggregate'
import { DepthBook } from '@/modules/market/depth-book'
import type { DepthLevel } from '@/stores/market'

/**
 * L151: the book collapsed to 6 rows under a blank band. Sequence seen live (09-27 23:52, all
 * sessions at once): a crossing ask delta arrived before the fills removed the bids -> spread
 * negative -> `mul('-12.85', '100')` threw inside render -> Vue replaced the component's DOM ->
 * the ResizeObserver still watched the detached `.book-body` (height 0) -> rowLimit = min 6 forever.
 */

/** ResizeObserver stand-in that records what is observed and lets the test fire entries. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.targets.clear() }
  fire(target: Element, height: number): void {
    this.callback([{ target, contentRect: { height } as DOMRectReadOnly } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver

function level(price: string, amount: string, total: string): DepthLevel {
  return { price, amount, total, diff: 0 }
}

function ladder(side: 'ask' | 'bid', count: number, from: number): DepthLevel[] {
  let total = 0
  return Array.from({ length: count }, (_, index) => {
    total += 10
    const price = side === 'ask' ? from + index * 10 : from - index * 10
    return level(String(price), '10', String(total))
  })
}

function source(): MarketSource {
  return reactive({
    currentSymbol: { symbol: 'e_btcusdt', pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 0, rules: { depthSteps: ['0.01', '0.1', '1'] }, volumeUnit: '张', valueMultiplier: '0.0001' },
    currentSymbolName: 'e_btcusdt',
    ticker: { close: '84500', open: '', high: '', low: '', vol: '', amount: '', rose: '' },
    asks: ladder('ask', 30, 84501),
    buys: ladder('bid', 30, 84499),
    trades: [],
    depthStepIndex: 0,
    bookSteps: ['0.01', '0.1', '1', '10'],
    markPrice: '84502.25',
    connectionState: 'open',
    klineScale: '15min',
    klineScales: ['15min'],
    setDepthStepIndex() {},
  }) as unknown as MarketSource
}

describe('order book component', () => {
  let app: App | null = null
  afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; FakeResizeObserver.instances = [] })

  function mount(market: MarketSource, futures = false): HTMLElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(defineComponent({ setup() {
      provide(MARKET_SOURCE, market)
      return () => h(OrderBook, futures ? { bookState: market.connectionState } : {})
    } }))
    app.use(i18n)
    app.config.errorHandler = (error) => { throw error }
    app.mount(host)
    return host
  }

  const rows = (host: HTMLElement): [number, number] => [host.querySelectorAll('.asks .level').length, host.querySelectorAll('.bids .level').length]

  it('distinguishes an empty connected book from a closed feed', async () => {
    const market = source()
    market.asks.splice(0)
    market.buys.splice(0)
    const host = mount(market, true)
    expect(host.querySelector('.side-empty')?.textContent).toBe(i18n.global.t('trade.noDepthData'))
    Object.assign(market, { connectionState: 'connecting' })
    await nextTick()
    expect(host.querySelector('.side-empty')?.textContent).toBe(i18n.global.t('status.connecting'))
    Object.assign(market, { connectionState: 'closed' })
    await nextTick()
    expect(host.querySelector('.side-empty')?.textContent).toBe(i18n.global.t('status.closed'))
  })

  it('renders every level (CSS clips them), independent of any measured height', async () => {
    const host = mount(source())
    await nextTick()
    expect(rows(host)).toEqual([30, 30])
    // A detached/zero-height observation (the L151 trigger) changes nothing about the row count.
    const observer = FakeResizeObserver.instances[0]
    const side = host.querySelector('.side.asks') as Element
    expect(observer.targets.has(side)).toBe(true)
    observer.fire(side, 0)
    await nextTick()
    expect(rows(host)).toEqual([30, 30])
  })

  it('survives a locked/crossed book: no render error, no negative spread, rows stay', async () => {
    const market = source()
    const host = mount(market)
    await nextTick()
    ;(market as unknown as { buys: DepthLevel[] }).buys = [level('84513.85', '5', '5'), ...ladder('bid', 29, 84499)]
    ;(market as unknown as { asks: DepthLevel[] }).asks = [level('84501', '3', '3'), ...ladder('ask', 29, 84511)]
    await nextTick()
    expect(rows(host)).toEqual([30, 30])
    expect(host.querySelector('.mid-spread')).toBeNull()
    expect(host.textContent).not.toContain('-12.85')
    ;(market as unknown as { buys: DepthLevel[] }).buys = ladder('bid', 30, 84499)
    await nextTick()
    expect(host.querySelector('.mid-spread')?.textContent).toBe('0.0023%')
  })

  it('re-observes the side element after it is re-created (mode switch)', async () => {
    const host = mount(source())
    await nextTick()
    const observer = FakeResizeObserver.instances[0]
    ;(host.querySelector('button[aria-pressed="false"]') as HTMLButtonElement).click() // bids only
    await nextTick()
    await nextTick()
    const bidSide = host.querySelector('.side.bids') as Element
    expect(observer.targets.has(bidSide)).toBe(true)
    expect(observer.targets.size).toBe(1)
    expect(rows(host)).toEqual([0, 30])
  })

  it('shows the mark price, the extended step list and the buy/sell ratio', async () => {
    const host = mount(source())
    await nextTick()
    expect(host.querySelector('.mid-mark')?.textContent).toBe('84,502.25')
    ;(host.querySelector('[data-testid="book-step"]') as HTMLButtonElement).click()
    await nextTick()
    expect([...document.body.querySelectorAll('.ts-item b')].map((option) => option.textContent)).toEqual(['0.01', '0.1', '1', '10'])
    expect(host.querySelector('.ratio')?.textContent).toContain('50%')
  })

  it('shows book prices with the selected step\'s decimals (1 → integers, 0.1 → one decimal)', async () => {
    const market = source()
    const host = mount(market)
    await nextTick()
    const firstAsk = () => (host.querySelector('.asks .level .p') as HTMLElement).textContent
    expect(firstAsk()).toMatch(/\.00$/)
    ;(market as unknown as { depthStepIndex: number }).depthStepIndex = 2
    await nextTick()
    expect(firstAsk()).toMatch(/^[\d,]+$/)
    ;(market as unknown as { depthStepIndex: number }).depthStepIndex = 1
    await nextTick()
    expect(firstAsk()).toMatch(/\.\d$/)
  })

  // Geometry is specified independently of the component: Binance uses 20px rows, OKX uses 24px.
  // Every fixture level adds 10 units, so the first cumulative bar is 10/80, 10/100 or 10/120.
  const viewportCases = SKIN === 'okx'
    ? [
        { name: 'OKX 200px / 24px = 8 rows', height: 200, visibleRows: 8, nearestWidth: '12.50%' },
        { name: 'OKX 240px / 24px = 10 rows', height: 240, visibleRows: 10, nearestWidth: '10.00%' },
      ]
    : [
        { name: 'Binance 200px / 20px = 10 rows', height: 200, visibleRows: 10, nearestWidth: '10.00%' },
        { name: 'Binance 240px / 20px = 12 rows', height: 240, visibleRows: 12, nearestWidth: '8.33%' },
      ]
  it.each(viewportCases)('scales bars to the deepest visible cumulative total in both skins: $name', async ({ height, visibleRows, nearestWidth }) => {
    const host = mount(source())
    await nextTick()
    const observer = FakeResizeObserver.instances[0]
    observer.fire(host.querySelector('.side.asks') as Element, height)
    await nextTick()
    const nearestAsk = host.querySelectorAll('.asks .level')[29] as HTMLElement
    const deepestVisibleAsk = host.querySelectorAll('.asks .level')[30 - visibleRows] as HTMLElement
    expect(nearestAsk.style.getPropertyValue('--w')).toBe(nearestWidth)
    expect(deepestVisibleAsk.style.getPropertyValue('--w')).toBe('100.00%')
    // Rows past the edge stay in the DOM (count never depends on the measurement), only hidden.
    expect(rows(host)).toEqual([30, 30])
    expect(host.querySelectorAll('.asks .level.cut')).toHaveLength(30 - visibleRows)
    expect(host.querySelectorAll('.bids .level.cut')).toHaveLength(30 - visibleRows)
  })
})

describe('depth book (crossed deltas)', () => {
  it('drops opposite levels crossed by a newer delta', () => {
    const book = new DepthBook()
    book.applySnapshot({ asks: [['84470', '1'], ['84480', '1']], buys: [['84469.61', '2'], ['84460', '2']] })
    book.applyDelta({ side: 'asks', price: '84456.76', volume: '13516' })
    expect(book.levels('bid').map((row) => row.price)).toEqual([])
    expect(book.levels('ask')[0].price).toBe('84456.76')
    book.applyDelta({ side: 'buys', price: '84470', volume: '1' })
    expect(book.levels('ask').map((row) => row.price)).toEqual(['84480'])
    expect(book.levels('bid').map((row) => row.price)).toEqual(['84470'])
  })
})

describe('book aggregation', () => {
  it('derives the grouping options from the real price tick (10-01: BTC perp tick 0.1 offered 0.01)', () => {
    expect(tickFromPrecision(1)).toBe('0.1')
    expect(tickFromPrecision(2)).toBe('0.01')
    expect(tickFromPrecision(0)).toBe('1')
    expect(tickFromPrecision(undefined)).toBe('')
    // BTC perp: price_precision 1 / tickSize 0.1, server channels still 0.01 / 0.1 / 1.
    expect(tickDepthSteps('0.1', ['0.01', '0.1', '1'])).toEqual(['0.1', '1', '10', '100'])
    // Spot BTC/USDT: tick 0.01.
    expect(tickDepthSteps('0.01', ['0.01', '0.1', '1'])).toEqual(['0.01', '0.1', '1', '10'])
    // Never finer than the finest server channel.
    expect(tickDepthSteps('0.01', ['1', '10'])).toEqual(['1', '10', '100', '1000'])
    // No usable tick: previous behaviour.
    expect(tickDepthSteps('', ['0.01', '0.1', '1'])).toEqual(['0.01', '0.1', '1', '10'])
  })

  it('picks the coarsest server channel not coarser than the display step as the extension', () => {
    const server = ['0.01', '0.1', '1']
    expect(coarseChannelForStep('0.1', server)).toBe(1)
    expect(coarseChannelForStep('1', server)).toBe(2)
    expect(coarseChannelForStep('100', server)).toBe(2)
    expect(coarseChannelForStep('0.01', server)).toBeNull()
    expect(coarseChannelForStep('0.001', server)).toBeNull()
  })

  it('groups a BTC perp book at 0.1 / 1 / 10 / 100 (bids floor, asks ceil)', () => {
    const asks = [{ price: '83900.9', amount: '1' }, { price: '83918.4', amount: '2' }, { price: '83945.5', amount: '3' }]
    const bids = [{ price: '83891.4', amount: '1' }, { price: '83861.1', amount: '2' }, { price: '83841.7', amount: '3' }]
    expect(groupLevels(asks, '0.1', 'ask').map((row) => row.price)).toEqual(['83900.9', '83918.4', '83945.5'])
    expect(groupLevels(asks, '10', 'ask').map((row) => [row.price, row.amount])).toEqual([['83910', '1'], ['83920', '2'], ['83950', '3']])
    expect(groupLevels(bids, '10', 'bid').map((row) => [row.price, row.amount])).toEqual([['83890', '1'], ['83860', '2'], ['83840', '3']])
    expect(groupLevels(asks, '100', 'ask').map((row) => [row.price, row.amount])).toEqual([['84000', '6']])
    expect(groupLevels(bids, '100', 'bid').map((row) => [row.price, row.amount])).toEqual([['83800', '6']])
  })

  it('extends the server steps with one coarser decade', () => {
    expect(extendDepthSteps(['0.01', '0.1', '1'])).toEqual(['0.01', '0.1', '1', '10'])
    expect(extendDepthSteps(['0.00000001'])).toEqual(['0.00000001', '0.0000001'])
    expect(extendDepthSteps([])).toEqual([])
  })

  it('rounds asks up and bids down to the step', () => {
    expect(bucketPrice('84501.49', '10', 'ask')).toBe('84510')
    expect(bucketPrice('84501.49', '10', 'bid')).toBe('84500')
    expect(bucketPrice('84500', '10', 'ask')).toBe('84500')
    expect(bucketPrice('0.12345', '0.001', 'bid')).toBe('0.123')
  })

  it('groups levels and keeps the nearest-first order', () => {
    const grouped = groupLevels([{ price: '84501', amount: '1' }, { price: '84509', amount: '2' }, { price: '84511', amount: '4' }], '10', 'ask')
    expect(grouped.map((row) => [row.price, row.amount])).toEqual([['84510', '3'], ['84520', '4']])
  })

  it('caps rows and recomputes totals', () => {
    const fine = Array.from({ length: 40 }, (_, index) => ({ price: String(100 + index), amount: '1' }))
    const side = composeSide(fine, null, '', 'ask', 30)
    expect(side).toHaveLength(30)
    expect(side[29].total).toBe('30')
  })

  it('computes sweep average price, sum and value', () => {
    const rows = [level('100', '1', '1'), level('110', '1', '2')]
    expect(sweepStats(rows)).toEqual({ avgPrice: '105', sumAmount: '2', sumValue: '210' })
    // USDT-denominated amounts: VWAP = 210 / (1 + 1)
    expect(sweepStats([level('100', '100', '100'), level('110', '110', '210')], '1', true)?.avgPrice).toBe('105')
  })

  it('never returns a negative spread and splits the ratio', () => {
    expect(bookSpread('100', '101')).toBeNull()
    expect(bookSpread('100', '100')).toBeNull()
    expect(bookSpread('101', '100')).toEqual({ value: '1', pct: '0.99' })
    expect(bidShare([level('1', '1', '1')], [level('1', '3', '3')])).toEqual({ bidPct: '75', askPct: '25' })
    expect(bidShare([], [])).toBeNull()
  })
})

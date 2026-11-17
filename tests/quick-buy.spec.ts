import { describe, expect, it } from 'vitest'
import { bestPrice, feeOf, fillFromTotals, hasLiquidity, maxAmount, quickEstimate, ratioAmount, summarizeFills, type QuickMarket } from '@/modules/trade/quick-buy'

const market = (over: Partial<QuickMarket> = {}): QuickMarket => ({
  // Deliberately unsorted: the estimator sorts asks up / bids down itself.
  asks: [{ price: '101', amount: '2' }, { price: '100', amount: '1' }, { price: '0', amount: '5' }],
  bids: [{ price: '98', amount: '1' }, { price: '99', amount: '0.5' }],
  lastPrice: '99.5',
  step: '0.0001',
  quotePrecision: 2,
  ...over,
})

describe('quick buy estimate (decimal strings)', () => {
  it('buys within the best level', () => {
    expect(quickEstimate('BUY', '50', market())).toEqual({ receive: '0.5', avgPrice: '100', source: 'book', partial: false })
  })

  it('sweeps several ask levels and floors to the quantity step', () => {
    // 100 USDT takes the whole 100 level (1 coin), 100 more at 101 = 0.990099… coin → 0.99 at step 0.0001 → 0.9900
    const estimate = quickEstimate('BUY', '200', market())
    expect(estimate.receive).toBe('1.99')
    expect(estimate.source).toBe('book')
    expect(estimate.partial).toBe(false)
    expect(estimate.avgPrice.startsWith('100.49')).toBe(true)
  })

  it('flags an order deeper than the visible book and prices the rest at the worst level', () => {
    // book holds 100 + 202 = 302 USDT; 101 more at 101 → 1 coin; 1 + 2 + 1 = 4
    const estimate = quickEstimate('BUY', '403', market())
    expect(estimate.partial).toBe(true)
    expect(estimate.receive).toBe('4')
  })

  it('sells into bids, best first, floored to the quote precision', () => {
    // 0.5 @ 99 = 49.5, 0.25 @ 98 = 24.5 → 74
    expect(quickEstimate('SELL', '0.75', market())).toMatchObject({ receive: '74', source: 'book', partial: false })
    // 0.333 @ 99 = 32.967 → 32.96 (rounded down)
    expect(quickEstimate('SELL', '0.333', market()).receive).toBe('32.96')
  })

  it('falls back to the last price when that side of the book is empty', () => {
    const estimate = quickEstimate('BUY', '10', market({ asks: [] }))
    expect(estimate).toEqual({ receive: '0.1005', avgPrice: '99.5', source: 'last', partial: false })
    expect(hasLiquidity('BUY', market({ asks: [] }))).toBe(false)
  })

  it('returns nothing for empty, zero, malformed or unpriceable input', () => {
    for (const amount of ['', '0', 'abc', '-1', '1e3']) expect(quickEstimate('BUY', amount, market()).receive).toBe('')
    expect(quickEstimate('BUY', '10', market({ asks: [], lastPrice: '' })).source).toBe('none')
  })

  it('keeps precision far beyond a double', () => {
    const tiny = market({ asks: [{ price: '0.00000001', amount: '100000000000' }], step: '1' })
    expect(quickEstimate('BUY', '0.3', tiny).receive).toBe('30000000')
    const big = market({ bids: [{ price: '123456789.12345678', amount: '1000' }], quotePrecision: 8 })
    expect(quickEstimate('SELL', '0.1', big).receive).toBe('12345678.91234567')
  })

  it('best price ignores zero / bad levels', () => {
    expect(bestPrice('BUY', market())).toBe('100')
    expect(bestPrice('SELL', market())).toBe('99')
  })

  it('max rounds the balance down to the quote precision (buy) or the step (sell)', () => {
    expect(maxAmount('BUY', '123.456789', market())).toBe('123.45')
    expect(maxAmount('SELL', '0.123456789', market())).toBe('0.1234')
    expect(maxAmount('SELL', '0.00009', market())).toBe('')
    expect(maxAmount('BUY', '', market())).toBe('')
    // 建议-003 ratios, rounded down to the step / quote precision; QA-004 dust rounds to '' (the view explains it)
    expect(ratioAmount('SELL', '0.123456789', '0.25', market())).toBe('0.0308')
    expect(ratioAmount('SELL', '0.123456789', '0.5', market())).toBe('0.0617')
    expect(ratioAmount('BUY', '100.01', '0.75', market())).toBe('75')
    expect(ratioAmount('SELL', '0.00000976', '1', market({ step: '0.00001' }))).toBe('')
    expect(ratioAmount('SELL', '1', 'x', market())).toBe('')
  })

  it('fee rounds up', () => {
    expect(feeOf('100.01', '0.001', 4)).toBe('0.1001')
    expect(feeOf('0.333', '0.001', 4)).toBe('0.0004')
    expect(feeOf('1', '', 4)).toBe('')
  })

  it('summarises fills and reply totals', () => {
    expect(summarizeFills([{ price: '100', volume: '1' }, { price: '101', volume: '0.5' }])).toEqual({ baseQty: '1.5', quoteQty: '150.5', avgPrice: '100.3333333333333333' })
    expect(summarizeFills([]).avgPrice).toBe('')
    expect(fillFromTotals('0.5', '50.25')).toEqual({ baseQty: '0.5', quoteQty: '50.25', avgPrice: '100.5' })
    expect(fillFromTotals('0', '0').baseQty).toBe('')
  })
})

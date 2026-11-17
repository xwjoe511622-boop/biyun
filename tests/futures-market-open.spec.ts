import { describe, expect, it } from 'vitest'
import { marketOpenValue } from '@/modules/futures/market-open'

const ASKS = [{ price: '83502', amount: '5' }, { price: '83500', amount: '12' }, { price: '83505', amount: '100' }]
const BIDS = [{ price: '83498', amount: '12' }, { price: '83490', amount: '100' }]
const floorFill = (value: string, levels: typeof ASKS, buy: boolean): number => {
  // rmatch sweep_amount: whole contracts while the budget covers price x multiplier
  const sorted = [...levels].sort((a, b) => (buy ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price)))
  let budget = Number(value)
  let filled = 0
  for (const level of sorted) {
    for (let i = 0; i < Number(level.amount); i++) {
      const cost = Number(level.price) * 0.0001
      if (budget + 1e-9 < cost) return filled
      budget -= cost
      filled += 1
    }
  }
  return filled
}

describe('marketOpenValue', () => {
  it('walks the asks and pads half a contract (buy fills exactly N)', () => {
    const { value, capped } = marketOpenValue({ side: 'BUY', contracts: '20', multiplier: '0.0001', levels: ASKS, fallbackPrice: '83400', dp: 2 })
    // (12 x 83500 + 5 x 83502 + 3 x 83505 + 0.5 x 83505) x 0.0001 = 171.17775 -> 171.17
    expect(value).toBe('171.17')
    expect(capped).toBe(false)
    expect(floorFill(value, ASKS, true)).toBe(20)
  })
  it('the unpadded value at the reference price fills one short (the 09-30 bug)', () => {
    expect(floorFill((20 * 83400 * 0.0001).toFixed(2), ASKS, true)).toBe(19)
  })
  it('walks the bids for a sell', () => {
    const { value } = marketOpenValue({ side: 'SELL', contracts: '20', multiplier: '0.0001', levels: BIDS, fallbackPrice: '83600', dp: 2 })
    expect(floorFill(value, BIDS, false)).toBe(20)
  })
  it('prices a book shortfall at the worse of the last level and the fallback', () => {
    const { value } = marketOpenValue({ side: 'BUY', contracts: '10', multiplier: '0.0001', levels: [{ price: '100', amount: '4' }], fallbackPrice: '110', dp: 4 })
    // 4 x 100 + 6 x 110 + 0.5 x 110 = 1115 -> 0.1115
    expect(value).toBe('0.1115')
  })
  it('uses the fallback when the book is empty', () => {
    expect(marketOpenValue({ side: 'BUY', contracts: '2', multiplier: '0.01', levels: [], fallbackPrice: '250', dp: 2 }).value).toBe('6.25')
  })
  it('caps at the affordable value', () => {
    expect(marketOpenValue({ side: 'BUY', contracts: '20', multiplier: '0.0001', levels: ASKS, fallbackPrice: '83400', dp: 2, cap: '166.5' })).toEqual({ value: '166.50', capped: true })
  })
  it('rejects fractional or missing input', () => {
    expect(marketOpenValue({ side: 'BUY', contracts: '1.5', multiplier: '0.0001', levels: ASKS, fallbackPrice: '1', dp: 2 }).value).toBe('')
    expect(marketOpenValue({ side: 'BUY', contracts: '1', multiplier: '0.0001', levels: [], fallbackPrice: '', dp: 2 }).value).toBe('')
  })
})

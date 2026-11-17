import { describe, expect, it } from 'vitest'
import { tradeCrossesOpen } from '@/stores/spot-live'

// QA 10-26 待确认-006: order 26043555 (SELL 3998 XAUT) stayed in 当前委托 after it filled.
describe('tradeCrossesOpen', () => {
  const sell = { side: 'SELL', type: 1, price: '3998' }
  const buy = { side: 'BUY', type: 1, price: '3990.5' }
  it('a print at or through a resting limit order counts', () => {
    expect(tradeCrossesOpen([sell], '3998')).toBe(true)
    expect(tradeCrossesOpen([sell], '3998.01')).toBe(true)
    expect(tradeCrossesOpen([sell], '3997.99')).toBe(false)
    expect(tradeCrossesOpen([buy], '3990.50')).toBe(true)
    expect(tradeCrossesOpen([buy], '3990.51')).toBe(false)
    expect(tradeCrossesOpen([sell, buy], '3995')).toBe(false)
  })
  it('market, pending and malformed rows are ignored', () => {
    expect(tradeCrossesOpen([{ side: 'SELL', type: 2, price: '0' }], '3998')).toBe(false)
    expect(tradeCrossesOpen([{ ...sell, pending: true }], '3998')).toBe(false)
    expect(tradeCrossesOpen([{ side: 'SELL', type: 1 }], '3998')).toBe(false)
    expect(tradeCrossesOpen([sell], 'NaN')).toBe(false)
    expect(tradeCrossesOpen([], '1')).toBe(false)
  })
})

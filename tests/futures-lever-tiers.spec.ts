import { describe, expect, it } from 'vitest'
import { maxPositionValue, normalizeLeverTiers, tierRoom } from '@/modules/futures/lever-tiers'

// Live BTC answer (10-01): 125x allows 50,000 USDT of position value; the order service says 10013 above it.
const BTC = { leverList: { leverConfig: JSON.stringify([
  { level: 1, maxHoldAmount: 99999999999999, maxLever: 1, minLever: 0 },
  { level: 9, maxHoldAmount: 250000, maxLever: 100, minLever: 50 },
  { level: 10, maxHoldAmount: 50000, maxLever: 125, minLever: 100 },
]) } }

describe('leverage tiers', () => {
  it('parses leverConfig and picks the tier with minLever < lever <= maxLever', () => {
    const tiers = normalizeLeverTiers(BTC)
    expect(maxPositionValue(tiers, 125)).toBe('50000')
    expect(maxPositionValue(tiers, 100)).toBe('250000')
    expect(maxPositionValue(tiers, 1)).toBe('99999999999999')
    expect(maxPositionValue(tiers, 20)).toBe('')
    expect(normalizeLeverTiers({})).toEqual([])
    expect(normalizeLeverTiers({ leverList: { leverConfig: 'not json' } })).toEqual([])
  })
  it('room = cap - positions - open orders, never negative; unknown cap = no limit', () => {
    expect(tierRoom('50000', '12000.5')).toBe('37999.5')
    expect(tierRoom('50000', '60000')).toBe('0')
    expect(tierRoom('', '10')).toBe('')
  })
})

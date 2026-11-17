import { describe, expect, it } from 'vitest'
import { estimateLiqPrice, keepRateFor, normalizeLadder, type LadderTier } from '@/modules/futures/liq-estimate'
import { Decimal } from '@/modules/finance/decimal'

// BTC-USDT ladder as served by common/get_ladder_info (2026-09-30).
const LADDER: LadderTier[] = [
  { min: '0', max: '50000', rate: '0.004' },
  { min: '50000', max: '250000', rate: '0.005' },
  { min: '250000', max: '1000000', rate: '0.01' },
]
const BASE = { multiplier: '0.0001', leverage: 20, openFeeRate: '0.00075', closeFeeRate: '0.00075', ladder: LADDER, dp: 2 }

describe('liq-estimate', () => {
  it('reads the ladder shape of get_ladder_info', () => {
    const data = { ladderList: { id: 1, ladderList: [{ level: 1, minPositionValue: 0, maxPositionValue: 50000, minMarginRate: 0.004 }] } }
    expect(normalizeLadder(data)).toEqual([{ min: '0', max: '50000', rate: '0.004' }])
    expect(normalizeLadder(null)).toEqual([])
  })

  it('picks the tier with min < value <= max', () => {
    expect(keepRateFor(LADDER, new Decimal(50000))).toBe('0.004')
    expect(keepRateFor(LADDER, new Decimal('50000.01'))).toBe('0.005')
    expect(keepRateFor(LADDER, new Decimal(2_000_000))).toBe('')
  })

  // Live B 2026-09-30: isolated long 19 @ 83551.32, 20x -> server reducePrice 79815.54131122833.
  it('matches the server for an isolated long', () => {
    const value = estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '19', price: '83551.32', marginModel: 2 })
    expect(Number(value)).toBeCloseTo(79815.54, 1)
  })

  // Live B 2026-09-30: cross short 20 @ 83542.96 -> server reducePrice 580120.905110724 (E + PB = 1165.7529588).
  it('matches the server for a cross short', () => {
    const value = estimateLiqPrice({ ...BASE, side: 'SELL', contracts: '20', price: '83542.96', marginModel: 1, crossEquity: '998.792353260', others: [] })
    expect(Number(value)).toBeCloseTo(580120.9, 0)
  })

  // Live B 2026-09-30: cross long 20 with ~999 USDT -> server reducePrice -417900.9 (no liquidation).
  it('reports none when the cross account covers the whole position', () => {
    expect(estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '20', price: '83527.91', marginModel: 1, crossEquity: '999.012859565', others: [] })).toBe('none')
  })

  it('merges an existing same-side isolated position', () => {
    const alone = estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '10', price: '80000', marginModel: 2 })
    const merged = estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '10', price: '80000', marginModel: 2, existing: { contracts: '10', value: '80', holdAmount: '4' } })
    expect(Number(alone)).toBeGreaterThan(0)
    expect(Math.abs(Number(merged) - Number(alone)) / Number(alone)).toBeLessThan(0.01)
  })

  it('other cross positions move a cross long liquidation up', () => {
    const input = { ...BASE, side: 'BUY' as const, contracts: '200', price: '80000', marginModel: 1 as const, crossEquity: '100' }
    const alone = Number(estimateLiqPrice({ ...input, others: [] }))
    const withOthers = Number(estimateLiqPrice({ ...input, others: [{ value: '5000', keepRate: '0.004' }] }))
    expect(withOthers).toBeGreaterThan(alone)
  })

  it('returns empty on missing inputs', () => {
    expect(estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '', price: '1', marginModel: 2 })).toBe('')
    expect(estimateLiqPrice({ ...BASE, side: 'BUY', contracts: '1', price: '1', marginModel: 1 })).toBe('')
    expect(estimateLiqPrice({ ...BASE, ladder: [], side: 'BUY', contracts: '1', price: '1', marginModel: 2 })).toBe('')
  })
})

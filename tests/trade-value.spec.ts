import { describe, expect, it } from 'vitest'
import { depthPoints, quoteValue } from '@/modules/market/trade-value'
import { futuresTradeValue, futuresTurnover } from '@/modules/futures/math'

describe('trade value (vol x multiplier x price)', () => {
  it('uses 1 for spot and the contract face value for futures', () => {
    expect(quoteValue('2', '100.5')).toBe('201')
    expect(quoteValue(13, '84213.13', '0.0001')).toBe('109.477069')
    expect(futuresTradeValue({ vol: '13', price: '84213.13' }, '0.0001')).toBe('109.477069')
    expect(quoteValue('x', '1')).toBe('')
    expect(futuresTradeValue({ vol: '1', price: '1' }, '')).toBe('')
  })

  it('scales the futures WS 24h amount by the multiplier, unknown multiplier -> empty', () => {
    expect(futuresTurnover('44167755.6', '0.0001')).toBe('4416.77556')
    expect(futuresTurnover('44167755.6', '')).toBe('')
    expect(futuresTurnover('', '0.0001')).toBe('')
  })

  it('accumulates depth notional with the multiplier', () => {
    const rows = [
      { price: '100', amount: '10', total: '10' },
      { price: '101', amount: '5', total: '15' },
    ]
    expect(depthPoints(rows).map((p) => p.notional)).toEqual([1000, 1505])
    expect(depthPoints(rows, '0.001').map((p) => p.notional)).toEqual([1, 1.505])
    expect(depthPoints([{ price: 'x', amount: '1', total: '1' }])).toEqual([])
  })
})

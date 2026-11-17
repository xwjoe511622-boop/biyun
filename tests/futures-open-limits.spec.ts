import { describe, expect, it } from 'vitest'
import { maxOpenValue, positionAvgPrice, tierRoomFor, tierUsedValue, type LimitOrder, type LimitPosition } from '@/modules/futures/open-limits'

/**
 * 最大可开 = the order service's formula (`ValidateServiceImpl.checkPosition` / `checkOrder`): positions of BOTH sides at
 * avg_price + resting OPEN orders + the new order ≤ the leverage tier cap; margin ≤ 可用 × leverage.
 * 10-01 owner: 「开多后再开空，滑块 100% 开不出来」.
 */
const BTC = '0.0001'
const long = (volume: string, open: string, settle = '0'): LimitPosition => ({ orderSide: 'BUY', positionVolume: volume, openAvgPrice: open, settleProfit: settle })
const short = (volume: string, open: string, settle = '0'): LimitPosition => ({ orderSide: 'SELL', positionVolume: volume, openAvgPrice: open, settleProfit: settle })
const limitOpen = (volume: string, price: string, dealt = '0'): LimitOrder => ({ open: 'OPEN', type: 1, price, volume, dealVolume: dealt })

describe('server avg_price', () => {
  it('is the open price moved by the settled PnL (direction-aware)', () => {
    // long 1000 @ 80000, settled +100 → avg = 80000 + 100 / (1000 × 0.0001) = 81000
    expect(positionAvgPrice(long('1000', '80000', '100'), BTC)).toBe('81000')
    // short 1000 @ 80000, settled +100 (price fell) → avg = 79000
    expect(positionAvgPrice(short('1000', '80000', '100'), BTC)).toBe('79000')
    expect(positionAvgPrice(long('1000', '80000', ''), BTC)).toBe('80000')
  })
})

describe('tier used / room (both sides + resting OPEN orders)', () => {
  it('hedge: long then short — the long already counts against the cap', () => {
    const used = tierUsedValue({ positions: [long('2000', '84000')], orders: [], multiplier: BTC })
    expect(used).toBe('16800')
    // 125x tier cap 50,000 → a short may add at most 33,200
    expect(tierRoomFor('50000', used)).toBe('33200')
    expect(maxOpenValue('117000', tierRoomFor('50000', used), 2)).toBe('33200.00')
  })

  it('both sides + resting opening orders (partially filled) + closing orders ignored', () => {
    const used = tierUsedValue({
      positions: [long('2000', '84000'), short('1000', '84000')],
      orders: [limitOpen('500', '83000', '100'), { open: 'CLOSE', type: 1, price: '90000', volume: '999', dealVolume: '0' }, { open: 'OPEN', type: 2, price: '', volume: '1234.5', dealVolume: '0' }],
      multiplier: BTC,
    })
    // 16,800 + 8,400 + (400 × 83,000 × 0.0001 = 3,320) + market 1,234.5
    expect(used).toBe('29754.5')
  })

  it('owner case: positions alone over the cap → room 0, no opening order possible', () => {
    const used = tierUsedValue({ positions: [long('20450', '83930')], orders: [], multiplier: BTC })
    expect(Number(used)).toBeGreaterThan(50000)
    expect(tierRoomFor('50000', used)).toBe('0')
    expect(maxOpenValue('117000', '0', 2)).toBe('0.00')
  })

  it('margin binds when it is below the room; unknown cap = margin only', () => {
    expect(maxOpenValue('9925.55', '33200', 2)).toBe('9925.55')
    expect(maxOpenValue('9925.55', '', 2)).toBe('9925.55')
    expect(tierRoomFor('', '100')).toBe('')
  })
})

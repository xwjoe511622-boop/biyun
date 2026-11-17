import { describe, expect, it } from 'vitest'
import { isolatedShortfall, type LeveragePosition } from '@/modules/futures/leverage-change'
import { positionPnl, sumPnl } from '@/modules/futures/math'
import { Decimal } from '@/modules/finance/decimal'

type PnlInput = Parameters<typeof positionPnl>[0]

describe('positionPnl (mark-price basis)', () => {
  it('matches effective accounting cost and the existing non-unit margin rate exactly', () => {
    const long = positionPnl({ side: 'BUY', volume: '3', multiplier: '2', entry: '110', mark: '112', leverage: 10, marginRate: '0.5' })
    expect(long.pnl).toBe('6'); expect(long.initialMargin).toBe('33.6')
    const short = positionPnl({ side: 'SELL', volume: '3', multiplier: '2', entry: '90', mark: '88', leverage: 10, marginRate: '0.5' })
    expect(short.pnl).toBe('6'); expect(short.initialMargin).toBe('26.4')
    expect(positionPnl({ side: 'BUY', volume: '1', multiplier: '1', entry: '1', mark: '1.0000000000000001', leverage: 1, marginRate: '1' }).pnl).toBe('0.0000000000000001')
    expect(sumPnl(['0.1', '0.2'])).toBe('0.3')
    for (const marginRate of ['0', '', 'bad']) expect(positionPnl({ side: 'BUY', volume: '1', multiplier: '1', entry: '1', mark: '2', leverage: 1, marginRate }).pnl).toBe('')
  })
  it('matches the owner case exactly (SELL on BTC)', () => {
    const result = positionPnl({
      side: 'SELL',
      volume: '13508',
      multiplier: '0.0001',
      entry: '84219.40',
      mark: '84176.72',
      leverage: 10,
    })
    expect(result.pnl).toBe('57.652144')
    expect(result.initialMargin).toBe('11370.5913376')
    expect(result.mark).toBe('84176.72')
    const roe = new Decimal(result.roe)
    expect(roe.gt('0.005')).toBe(true)
    expect(roe.lt('0.0051')).toBe(true)
  })

  it('computes a long profit', () => {
    const result = positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 })
    expect(result.pnl).toBe('0.1')
    expect(result.initialMargin).toBe('0.22')
    expect(result.mark).toBe('110')
  })

  it('computes a long loss', () => {
    expect(positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '90', leverage: 5 }).pnl).toBe('-0.1')
  })

  it('computes a short profit', () => {
    expect(positionPnl({ side: 'SELL', volume: '10', multiplier: '0.001', entry: '100', mark: '90', leverage: 5 }).pnl).toBe('0.1')
  })

  it('computes a short loss', () => {
    expect(positionPnl({ side: 'SELL', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 }).pnl).toBe('-0.1')
  })

  it('returns empty strings for invalid inputs', () => {
    const empty = { pnl: '', roe: '', initialMargin: '', mark: '' }
    expect(positionPnl({ side: '', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 })).toEqual(empty)
    expect(positionPnl({ side: 'BUY', volume: 'abc', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 })).toEqual(empty)
    expect(positionPnl({ side: 'BUY', volume: '0', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 })).toEqual(empty)
    expect(positionPnl({ side: 'BUY', volume: '10', multiplier: '0', entry: '100', mark: '110', leverage: 5 })).toEqual(empty)
    expect(positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: 'x', mark: '110', leverage: 5 })).toEqual(empty)
    expect(positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '0', leverage: 5 })).toEqual(empty)
  })

  it('returns pnl and mark but empty roe/initialMargin when leverage is missing or not a positive integer', () => {
    const withoutLeverage = positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage: null })
    expect(withoutLeverage.pnl).toBe('0.1')
    expect(withoutLeverage.mark).toBe('110')
    expect(withoutLeverage.roe).toBe('')
    expect(withoutLeverage.initialMargin).toBe('')

    for (const leverage of [0, -2, 2.5]) {
      const result = positionPnl({ side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage })
      expect(result.pnl).toBe('0.1')
      expect(result.roe).toBe('')
      expect(result.initialMargin).toBe('')
    }
  })
})

describe('margin mode (cross vs isolated)', () => {
  it('uses the same mark-price formula for cross and isolated positions', () => {
    // Binance uses the same mark-price PnL formula regardless of margin mode, and this function
    // takes no margin mode, so cross and isolated positions with identical inputs must agree.
    const inputs: PnlInput = { side: 'BUY', volume: '10', multiplier: '0.001', entry: '100', mark: '110', leverage: 5 }
    const cross = positionPnl({ ...inputs })
    const isolated = positionPnl({ ...inputs })
    expect(isolated).toEqual(cross)
  })
})

describe('sumPnl', () => {
  it('sums valid signed decimals and skips empties / non-decimals', () => {
    expect(sumPnl(['57.652144', '-0.1', '', 'x'])).toBe('57.552144')
  })

  it('returns an empty string when nothing is valid', () => {
    expect(sumPnl([])).toBe('')
    expect(sumPnl(['', 'x'])).toBe('')
  })
})

describe('isolated leverage preview keeps the server internal PnL basis (2026-09-29)', () => {
  const base: LeveragePosition = {
    id: 1, positionType: 2, orderSide: 'BUY', positionVolume: '10', positionBalance: '100', holdAmount: '25',
    realizedAmount: '0', unRealizedAmount: '5', reducePrice: '1', keepRate: '0.005', leverageLevel: 5,
  }
  it('uses openRealizedAmount - settleProfit (mark vs avg_price) when both are sent', () => {
    // API unRealizedAmount is now mark vs open (5); 4 of it was already settled into the margin -> internal 1.
    const shortfall = isolatedShortfall({ ...base, openRealizedAmount: '5', settleProfit: '4' }, 2)
    // 100/2 - (25 - 0 - 1) = 26
    expect(shortfall?.toFixed()).toBe('26')
  })
  it('falls back to unRealizedAmount for older servers', () => {
    expect(isolatedShortfall(base, 2)?.toFixed()).toBe('30')
  })
})

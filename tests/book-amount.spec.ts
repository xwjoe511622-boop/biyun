import { describe, expect, it } from 'vitest'
import { columnDecimals, formatBookAmount, type MarketSourceSymbol } from '@/components/trade/market-source'

// BTC is configured with 8 quantity decimals while the book carries 5: padding must follow the rows, not the config.
const spot: MarketSourceSymbol = {
  symbol: 'btcusdt',
  pair: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  pricePrecision: 2,
  volumePrecision: 8,
  rules: { depthSteps: ['0.01'] },
}

describe('columnDecimals', () => {
  it('returns the most decimals among the values', () => {
    expect(columnDecimals(['0.3712', '0.37059', '2'])).toBe(5)
  })

  it('ignores non-decimals and is 0 for an empty column', () => {
    expect(columnDecimals(['', '--', '1.5'])).toBe(1)
    expect(columnDecimals([])).toBe(0)
  })
})

describe('formatBookAmount (10-24 walkthrough P3-1)', () => {
  const pad = columnDecimals(['0.3712', '0.37059', '2'])

  it('pads spot amounts to the column width so they line up', () => {
    expect(formatBookAmount('0.3712', spot, pad)).toBe('0.37120')
    expect(formatBookAmount('0.37059', spot, pad)).toBe('0.37059')
    expect(formatBookAmount('2', spot, pad)).toBe('2.00000')
  })

  it('does not pad to the configured quantity precision', () => {
    expect(formatBookAmount('1.09334', spot, pad)).toBe('1.09334')
  })

  it('groups thousands', () => {
    expect(formatBookAmount('1234.5', spot, pad)).toBe('1,234.50000')
  })

  it('never cuts digits the server sent', () => {
    expect(formatBookAmount('0.123456789', spot, pad)).toBe('0.123456789')
  })

  it('uses an explicit display precision as is (futures sources)', () => {
    expect(formatBookAmount('12.3456', { ...spot, volumeDisplayPrecision: 2 }, pad)).toBe('12.34')
    expect(formatBookAmount('7', { ...spot, volumeDisplayPrecision: 0 }, pad)).toBe('7')
  })

  it('leaves the value unpadded without a column width or symbol', () => {
    expect(formatBookAmount('0.3712', undefined)).toBe('0.3712')
  })
})

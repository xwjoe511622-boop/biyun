import { describe, expect, it } from 'vitest'
import { filterDecimal, minOpenOrder, minOpenValue, minValueText } from '@/modules/api/exchange-filters'
import { toDecString } from '@/modules/finance/decimal'
import { volumeLess } from '@/modules/futures/api'
import { guardShape } from '@/modules/futures/fapi-errors'
import { bookMid } from '@/modules/futures/use-contract-quote'

// Money-precision rule (docs/00-meta/money-precision-rule.md): the 2026-10-03 jsfloatcheck fixes stay exact.

describe('minOpenOrder (Decimal, strings out)', () => {
  it('0.1 + 0.2 class: coin is exactly contracts × multiplier', () => {
    // float: 0.3 / 0.1 = 2.9999999999999996 and 3 × 0.1 = 0.30000000000000004
    expect(minOpenOrder({ multiplier: '0.1', minQty: '0.3', minNotional: '0' }, '10')).toEqual({ contracts: 3, coin: '0.3', usdt: '3' })
  })
  it('an exact MIN_NOTIONAL multiple needs no extra contract', () => {
    expect(minOpenOrder({ multiplier: '0.001', minQty: '0.001', minNotional: '20' }, '2500')).toEqual({ contracts: 8, coin: '0.008', usdt: '20' })
  })
  it('USDT rounds UP to 2 dp (a minimum is never shown below the real one)', () => {
    expect(minOpenOrder({ multiplier: '0.001', minQty: '0.001', minNotional: '0' }, '83.915')?.usdt).toBe('0.09')
    expect(minOpenOrder({ multiplier: '0.0001', minQty: '0.001', minNotional: '50' }, '83915')?.usdt).toBe('83.92')
  })
  it('large prices stay exact (no exponent form, no float drift)', () => {
    expect(minOpenOrder({ multiplier: '0.0001', minQty: '0.0001', minNotional: '5' }, '123456789012.345678')).toEqual({ contracts: 1, coin: '0.0001', usdt: '12345678.91' })
  })
  it('exponent-form filter values and missing price', () => {
    expect(minOpenOrder({ multiplier: '1e-4', minQty: '0.001' }, '')).toEqual({ contracts: 10, coin: '0.001', usdt: '0' })
    expect(minOpenOrder({ multiplier: '0', minQty: '1' }, '1')).toBeNull()
    expect(minOpenOrder({ minQty: '1' }, '1')).toBeNull()
  })
})

describe('minOpenValue / minValueText', () => {
  it('max(MIN_NOTIONAL, minQty × price) exactly', () => {
    expect(minOpenValue({ minQty: '0.001', minNotional: '50' }, '83915')).toBe('83.915')
    expect(minOpenValue({ minQty: '0.0001', minNotional: '50' }, '83915')).toBe('50')
    expect(minOpenValue({ minQty: '0.1', minNotional: '0' }, '3')).toBe('0.3') // float: 0.30000000000000004
  })
  it('unknown filter / price', () => {
    expect(minOpenValue(undefined, '1')).toBe('0')
    expect(minOpenValue({ minQty: '0.001', minNotional: '5' }, '')).toBe('5')
    expect(minOpenValue({ minQty: 'x', minNotional: '-1' }, 'abc')).toBe('0')
  })
  it('display rounds UP to 2 dp and drops trailing zeros', () => {
    expect(minValueText('83.915')).toBe('83.92')
    expect(minValueText('83.91')).toBe('83.91')
    expect(minValueText('50')).toBe('50')
    expect(minValueText('0.001')).toBe('0.01')
    expect(minValueText('123456789012345678.001')).toBe('123456789012345678.01')
  })
  it('filterDecimal tolerates JSON numbers, exponent strings and junk', () => {
    expect(filterDecimal(0.1).toFixed()).toBe('0.1')
    expect(filterDecimal('2.5e-3').toFixed()).toBe('0.0025')
    expect(filterDecimal(undefined).toFixed()).toBe('0')
    expect(filterDecimal('-1').toFixed()).toBe('0')
  })
})

describe('toDecString exponent of any length', () => {
  it('expands 3+ digit exponents (was returned raw)', () => {
    expect(toDecString('1e-100')).toBe(`0.${'0'.repeat(99)}1`)
    expect(toDecString('1.5E+120')).toBe(`15${'0'.repeat(119)}`)
    expect(toDecString('2e-8')).toBe('0.00000002')
  })
})

describe('bookMid', () => {
  it('exact midpoint', () => {
    expect(bookMid('0.1', '0.2')).toBe('0.15') // float: 0.15000000000000002
    expect(bookMid('1e-7', '3e-7')).toBe('0.0000002') // float String(): 2e-7
    expect(bookMid('123456789012345678.9', '123456789012345679.1')).toBe('123456789012345679')
  })
  it('empty unless both sides > 0', () => {
    expect(bookMid(undefined, '1')).toBe('')
    expect(bookMid('0', '1')).toBe('')
  })
})

describe('guardShape PRICE_FILTER tick check (exact remainder)', () => {
  const reason = (price: unknown, tickSize: unknown): unknown => guardShape('-1013', { filter: 'PRICE_FILTER', price, tickSize })?.reason
  it('on-tick prices are out of band, not TICK_SIZE', () => {
    expect(reason('0.3', '0.1')).toBe('PRICE_OUT_OF_BAND')
    expect(reason(0.3, 0.1)).toBe('PRICE_OUT_OF_BAND')
    expect(reason('123456789012.03', '0.01')).toBe('PRICE_OUT_OF_BAND')
  })
  it('off-tick prices are TICK_SIZE, even beyond float precision', () => {
    expect(reason('0.35', '0.1')).toBe('TICK_SIZE')
    expect(reason('123456789012.031', '0.01')).toBe('TICK_SIZE')
    expect(reason('1.00000000001', '0.1')).toBe('TICK_SIZE')
  })
  it('missing / bad numbers fall back to out of band', () => {
    expect(reason(undefined, '0.1')).toBe('PRICE_OUT_OF_BAND')
    expect(reason('1', '0')).toBe('PRICE_OUT_OF_BAND')
  })
})

describe('volumeLess', () => {
  it('compares contract volumes exactly', () => {
    expect(volumeLess('2', '10')).toBe(true)
    expect(volumeLess('10.0', '10')).toBe(false)
    expect(volumeLess('9007199254740992', '9007199254740993')).toBe(true) // equal as floats
    expect(volumeLess('', '1')).toBe(true)
    expect(volumeLess('abc', '1')).toBe(false)
  })
})

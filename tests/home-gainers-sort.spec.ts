import { describe, expect, it } from 'vitest'
import { byDecimalDesc } from '@/components/home/binance/use-home-markets'
import { cmp, cmpSigned, isSignedDecimalString } from '@/modules/finance/decimal'

/**
 * Owner 10-22: clicking 涨幅榜 (top gainers) on the home page threw "not a decimal string: -0.00270435" — the sort
 * passed signed 24h change ratios to `cmp`, which only takes non-negative amounts, and the render crashed.
 */
describe('cmpSigned', () => {
  it('orders negative, zero and positive ratios exactly', () => {
    expect(cmpSigned('-0.00270435', '0')).toBe(-1)
    expect(cmpSigned('0.0001', '-0.0001')).toBe(1)
    expect(cmpSigned('-0.5', '-0.25')).toBe(-1)
    expect(cmpSigned('-0', '0')).toBe(0)
    expect(cmpSigned('0.10000000000000000001', '0.1')).toBe(1)
  })

  it('rejects anything that is not a plain signed decimal', () => {
    expect(() => cmpSigned('--', '0')).toThrow(/signed decimal/)
    expect(() => cmpSigned('0', '1e-5')).toThrow(/signed decimal/)
    expect(isSignedDecimalString('+1')).toBe(false)
    expect(isSignedDecimalString('-1.5')).toBe(true)
  })

  it('leaves cmp non-negative only (amounts never go negative)', () => {
    expect(() => cmp('-1', '0')).toThrow(/not a decimal string/)
  })
})

describe('byDecimalDesc (home gainers / volume / new-listing sorts)', () => {
  const rows = (values: string[]): { v: string }[] => values.map((v) => ({ v }))

  it('sorts a red-day board without throwing, highest change first', () => {
    const sorted = rows(['-0.00270435', '0.0125', '', '-0.0412', '0', '--', '0.0031']).sort(byDecimalDesc((row) => row.v))
    expect(sorted.map((row) => row.v)).toEqual(['0.0125', '0.0031', '0', '-0.00270435', '-0.0412', '', '--'])
  })

  it('handles an all-negative list', () => {
    const sorted = rows(['-0.3', '-0.01', '-0.2']).sort(byDecimalDesc((row) => row.v))
    expect(sorted.map((row) => row.v)).toEqual(['-0.01', '-0.2', '-0.3'])
  })

  it('compares beyond float precision', () => {
    const sorted = rows(['12345678901234567890.1', '12345678901234567890.2']).sort(byDecimalDesc((row) => row.v))
    expect(sorted[0]?.v).toBe('12345678901234567890.2')
  })
})

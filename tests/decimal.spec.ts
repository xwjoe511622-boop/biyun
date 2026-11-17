import { describe, expect, it } from 'vitest'
import {
  add,
  canonicalDecimal,
  cmp,
  decimalPlaces,
  div,
  groupDigits,
  isDecimalString,
  isPositive,
  mul,
  ratioToPercent,
  sub,
  toDecString,
  toFixedString,
} from '@/modules/finance/decimal'

describe('decimal helpers', () => {
  it('adds decimal strings without binary float artefacts', () => {
    expect(add('0.1', '0.2')).toBe('0.3')
    expect(add('1', '0.00000001')).toBe('1.00000001')
    expect(sub('0.3', '0.1')).toBe('0.2')
  })

  it('multiplies and divides at exchange precision', () => {
    expect(mul('0.015', '65000.01')).toBe('975.00015')
    // Division always rounds down at the requested precision.
    expect(div('1', '3', 8)).toBe('0.33333333')
    expect(div('100', '65000', 6)).toBe('0.001538')
  })

  it('rejects division by zero instead of producing Infinity', () => {
    expect(() => div('1', '0', 2)).toThrowError()
  })

  it('compares values exactly', () => {
    expect(cmp('0.00000001', '0.00000002')).toBe(-1)
    expect(cmp('1.10', '1.1')).toBe(0)
    expect(cmp('2', '1.99999999')).toBe(1)
  })

  it('validates decimal strings and counts string decimals', () => {
    expect(isDecimalString('0')).toBe(true)
    expect(isDecimalString('10.5')).toBe(true)
    expect(isDecimalString('.5')).toBe(false)
    expect(isDecimalString('5.')).toBe(false)
    expect(isDecimalString('-1')).toBe(false)
    expect(isDecimalString('1e-8')).toBe(false)
    expect(isDecimalString('')).toBe(false)
    // The server validates BigDecimal scale, so trailing zeros are counted.
    expect(decimalPlaces('1.2300')).toBe(4)
    expect(decimalPlaces('1')).toBe(0)
    expect(decimalPlaces('abc')).toBeNull()
  })

  it('canonicalises without changing the value', () => {
    expect(canonicalDecimal('1.2300')).toBe('1.23')
    expect(canonicalDecimal('100.')).toBe('100.')
    expect(canonicalDecimal('100.000')).toBe('100')
    expect(canonicalDecimal('not-a-number')).toBe('not-a-number')
  })

  it('detects positive amounts only', () => {
    expect(isPositive('0.00000001')).toBe(true)
    expect(isPositive('0')).toBe(false)
    expect(isPositive('0.000000000')).toBe(false)
  })

  it('converts ratios and pads fixed point strings', () => {
    expect(ratioToPercent('0.0123')).toBe('1.23')
    expect(ratioToPercent('-0.05')).toBe('-5.00')
    expect(toFixedString('1.5', 4)).toBe('1.5000')
    expect(groupDigits('1234567.5', 2)).toBe('1,234,567.50')
    expect(groupDigits('0.00000001')).toBe('0.00000001')
  })

  it('stringifies JSON numbers so no float arithmetic is needed', () => {
    expect(toDecString(0.00000001)).toBe('0.00000001')
    expect(toDecString(' 12.5 ')).toBe('12.5')
    expect(toDecString(null)).toBe('')
    expect(toDecString(undefined)).toBe('')
    // Incoming numeric scientific notation is normalized before decimal arithmetic.
    expect(isDecimalString(toDecString(0.00000001))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  coinToFiat,
  effectiveMaxFiat,
  evaluateTradeAmount,
  fiatToCoin,
  floatingPrice,
  maxTradeAmount,
  sanitizeDecimalInput,
  stripCurrencySuffix,
  type TradeLimitsInput,
} from '@/modules/otc/amounts'
import { countdownParts, deadlineFromRemaining, formatCountdown, parseMillis, remainingMs } from '@/modules/otc/countdown'

const ad: Omit<TradeLimitsInput, 'input' | 'mode'> = {
  price: '7.13',
  minTrade: '100',
  maxTrade: '50000',
  volumeBalance: '1000',
  fiatDp: 2,
  coinDp: 4,
}

describe('otc amount maths (decimal strings)', () => {
  it('strips the currency suffix the list endpoints append', () => {
    expect(stripCurrencySuffix('7.12CNY')).toBe('7.12')
    expect(stripCurrencySuffix('100 USD')).toBe('100')
    expect(stripCurrencySuffix(7.5)).toBe('7.5')
    expect(stripCurrencySuffix('abc')).toBe('')
    expect(stripCurrencySuffix(null)).toBe('')
  })

  it('sanitises input without rounding up', () => {
    expect(sanitizeDecimalInput('1,234.5678', 2)).toBe('1234.56')
    expect(sanitizeDecimalInput('.5', 2)).toBe('0.5')
    expect(sanitizeDecimalInput('1.2.3', 4)).toBe('1.23')
    expect(sanitizeDecimalInput('9.99', 0)).toBe('9')
  })

  it('converts fiat ↔ coin rounding down with exact decimals', () => {
    expect(fiatToCoin('100', '7.13', 4)).toBe('14.0252')
    expect(coinToFiat('14.0252', '7.13', 2)).toBe('99.99')
    expect(coinToFiat('0.1', '0.2', 2)).toBe('0.02')
    expect(fiatToCoin('0.3', '0.1', 8)).toBe('3')
    expect(fiatToCoin('1', '0', 4)).toBe('')
  })

  it('accepts an in-range fiat amount and derives the coin volume', () => {
    expect(evaluateTradeAmount({ ...ad, input: '713', mode: 'fiat' })).toEqual({ ok: true, error: null, fiat: '713', volume: '100' })
  })

  it('accepts a coin amount and derives the fiat total', () => {
    expect(evaluateTradeAmount({ ...ad, input: '20', mode: 'coin' })).toEqual({ ok: true, error: null, fiat: '142.6', volume: '20' })
  })

  it('enforces the fiat min/max limits', () => {
    expect(evaluateTradeAmount({ ...ad, input: '99.99', mode: 'fiat' }).error).toBe('belowMin')
    expect(evaluateTradeAmount({ ...ad, input: '100', mode: 'fiat' }).ok).toBe(true)
    expect(evaluateTradeAmount({ ...ad, input: '14', mode: 'coin' }).error).toBe('belowMin')
    expect(evaluateTradeAmount({ ...ad, maxTrade: '5000', volumeBalance: '10000', input: '5000.01', mode: 'fiat' }).error).toBe('aboveMax')
  })

  it('never lets an order exceed the remaining advert volume', () => {
    expect(evaluateTradeAmount({ ...ad, input: '1000.0001', mode: 'coin' }).error).toBe('aboveAvailable')
    expect(evaluateTradeAmount({ ...ad, input: '7200', mode: 'fiat' }).error).toBe('aboveAvailable')
  })

  it('rejects empty, malformed, zero and over-precise input', () => {
    expect(evaluateTradeAmount({ ...ad, input: '', mode: 'fiat' }).error).toBe('required')
    expect(evaluateTradeAmount({ ...ad, input: 'abc', mode: 'fiat' }).error).toBe('invalid')
    expect(evaluateTradeAmount({ ...ad, input: '0', mode: 'fiat' }).error).toBe('zero')
    expect(evaluateTradeAmount({ ...ad, input: '100.001', mode: 'fiat' }).error).toBe('precision')
    expect(evaluateTradeAmount({ ...ad, input: '1.00001', mode: 'coin' }).error).toBe('precision')
  })

  it('caps the max at min(maxTrade, volumeBalance × price)', () => {
    expect(effectiveMaxFiat('50000', '1000', '7.13', 2)).toBe('7130')
    expect(effectiveMaxFiat('5000', '1000', '7.13', 2)).toBe('5000')
    expect(maxTradeAmount({ ...ad, mode: 'fiat' })).toBe('7130')
    expect(maxTradeAmount({ ...ad, mode: 'coin' })).toBe('1000')
    const fill = maxTradeAmount({ ...ad, maxTrade: '5000', mode: 'coin' })
    expect(fill).toBe('701.2622')
    expect(evaluateTradeAmount({ ...ad, maxTrade: '5000', input: fill, mode: 'coin' }).ok).toBe(true)
  })

  it('computes floating prices', () => {
    expect(floatingPrice('7.10', '1.5', 'above', 2)).toBe('7.2')
    expect(floatingPrice('7.10', '1.5', 'below', 2)).toBe('6.99')
    expect(floatingPrice('', '1', 'above', 2)).toBe('')
    expect(floatingPrice('7', '100', 'below', 2)).toBe('')
  })
})

describe('otc countdown', () => {
  it('pins the server remaining time to the receipt clock', () => {
    const deadline = deadlineFromRemaining(900_000, 1_000)
    expect(deadline).toBe(901_000)
    expect(remainingMs(deadline, 1_000)).toBe(900_000)
    expect(remainingMs(deadline, 902_000)).toBe(0)
    expect(remainingMs(null, 5)).toBe(0)
    expect(deadlineFromRemaining(-50, 10)).toBe(10)
  })

  it('formats mm:ss and h:mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(59_999)).toBe('00:59')
    expect(formatCountdown(15 * 60_000)).toBe('15:00')
    expect(formatCountdown(3_661_000)).toBe('1:01:01')
    expect(countdownParts(-1).expired).toBe(true)
    expect(countdownParts(1000).expired).toBe(false)
  })

  it('parses server millisecond fields', () => {
    expect(parseMillis(1234)).toBe(1234)
    expect(parseMillis('1234')).toBe(1234)
    expect(parseMillis('12.5')).toBeNull()
    expect(parseMillis(null)).toBeNull()
  })
})

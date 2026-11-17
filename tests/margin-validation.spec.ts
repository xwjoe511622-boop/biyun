import { describe, expect, it } from 'vitest'
import { maxRepayable, totalOwed, validateBorrow, validateRepay } from '@/modules/margin/validation'

describe('borrow validation', () => {
  const context = { canBorrow: '100', minBorrow: '10', precision: 8 }

  it('requires a positive decimal within precision', () => {
    expect(validateBorrow('', context).error?.key).toBe('required')
    expect(validateBorrow('1e3', context).error?.key).toBe('invalid')
    expect(validateBorrow('0', context).error?.key).toBe('positive')
    expect(validateBorrow('10.123456789', context).error).toEqual({ key: 'precision', params: { dp: 8 } })
  })

  it('enforces the configured minimum and the server-computed max borrowable', () => {
    expect(validateBorrow('5', context).error).toEqual({ key: 'belowMinBorrow', params: { min: '10' } })
    expect(validateBorrow('100.00000001', context).error).toEqual({ key: 'aboveCanBorrow', params: { max: '100' } })
    const ok = validateBorrow('100.000', context)
    expect(ok.ok).toBe(true)
    expect(ok.amount).toBe('100')
  })

  it('blocks when the account is not loaded or nothing can be borrowed', () => {
    expect(validateBorrow('1', { canBorrow: '', minBorrow: '0', precision: 8 }).error?.key).toBe('accountUnavailable')
    expect(validateBorrow('1', { canBorrow: '0', minBorrow: '0', precision: 8 }).error?.key).toBe('nothingToBorrow')
  })
})

describe('repay validation', () => {
  const context = { owePrincipal: '50', oweInterest: '0.5', minPayment: '5', available: '80', precision: 8 }

  it('sums principal and interest for the total owed', () => {
    expect(totalOwed('50', '0.5')).toBe('50.5')
    expect(totalOwed('', '0.5')).toBe('')
    expect(maxRepayable(context)).toBe('50.5')
    expect(maxRepayable({ ...context, available: '20' })).toBe('20')
  })

  it('refuses more than owed and more than the margin balance', () => {
    expect(validateRepay('50.6', context).error).toEqual({ key: 'aboveOwed', params: { max: '50.5' } })
    expect(validateRepay('30', { ...context, available: '20' }).error).toEqual({ key: 'insufficient', params: { available: '20' } })
  })

  it('applies the minimum repayment unless the amount clears the whole debt (server rule)', () => {
    expect(validateRepay('1', context).error).toEqual({ key: 'belowMinPayment', params: { min: '5' } })
    const small = { ...context, owePrincipal: '1', oweInterest: '0.2' }
    expect(validateRepay('1.2', small).ok).toBe(true)
    expect(validateRepay('5', context).ok).toBe(true)
  })
})

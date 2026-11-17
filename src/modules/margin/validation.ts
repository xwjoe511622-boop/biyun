import { groupDigits, add, canonicalDecimal, cmp, decimalPlaces, isDecimalString, isPositive, min } from '@/modules/finance/decimal'

/**
 * Client pre-flight for borrow / repay. The server re-checks everything
 * (LeverBorrowAct.leverFinanceBorrow :267, leverFinanceReturn :355, BorrowOrderServiceImpl.operateLeverReturn),
 * so these checks only avoid pointless round trips; the server answer always wins.
 */

export interface AmountError {
  /** i18n key under `margin.error.*`. */
  key: string
  params?: Record<string, string | number>
}

export interface AmountValidation {
  ok: boolean
  error: AmountError | null
  /** Canonical amount ready to POST (trailing zeros trimmed). */
  amount: string
}

function fail(key: string, amount: string, params?: Record<string, string | number>): AmountValidation {
  return { ok: false, error: params === undefined ? { key } : { key, params }, amount }
}

function basic(raw: string, precision: number): AmountValidation | string {
  const amount = canonicalDecimal(raw)
  if (amount === '') return fail('required', amount)
  if (!isDecimalString(amount)) return fail('invalid', amount)
  if (!isPositive(amount)) return fail('positive', amount)
  if ((decimalPlaces(amount) ?? 0) > precision) return fail('precision', amount, { dp: precision })
  return amount
}

export interface BorrowContext {
  /** `baseCanBorrow` / `quoteCanBorrow` from the pair account; `''` when not loaded. */
  canBorrow: string
  /** `baseMinBorrow` / `quoteMinBorrow`; `0`/`''` means no minimum configured. */
  minBorrow: string
  precision: number
}

export function validateBorrow(raw: string, context: BorrowContext): AmountValidation {
  const checked = basic(raw, context.precision)
  if (typeof checked !== 'string') return checked
  const amount = checked
  if (!isDecimalString(context.canBorrow)) return fail('accountUnavailable', amount)
  if (!isPositive(context.canBorrow)) return fail('nothingToBorrow', amount)
  if (isPositive(context.minBorrow) && cmp(amount, context.minBorrow) < 0) return fail('belowMinBorrow', amount, { min: context.minBorrow })
  if (cmp(amount, context.canBorrow) > 0) return fail('aboveCanBorrow', amount, { max: context.canBorrow })
  return { ok: true, error: null, amount }
}

export interface RepayContext {
  /** Outstanding principal (`oweAmount`). */
  owePrincipal: string
  /** Outstanding interest (`oweInterest`). */
  oweInterest: string
  /** `baseMinPayment` / `quoteMinPayment`. */
  minPayment: string
  /** Margin-account normal balance of the borrowed coin (repayment is taken from it). */
  available: string
  precision: number
}

/** Outstanding total = principal + interest; `''` when either is missing. */
export function totalOwed(owePrincipal: string, oweInterest: string): string {
  if (!isDecimalString(owePrincipal) || !isDecimalString(oweInterest)) return ''
  return add(owePrincipal, oweInterest)
}

/** Largest amount the user can repay right now: min(owed, available). */
export function maxRepayable(context: Pick<RepayContext, 'owePrincipal' | 'oweInterest' | 'available'>): string {
  const owed = totalOwed(context.owePrincipal, context.oweInterest)
  if (owed === '' || !isDecimalString(context.available)) return ''
  return min(owed, context.available)
}

export function validateRepay(raw: string, context: RepayContext): AmountValidation {
  const checked = basic(raw, context.precision)
  if (typeof checked !== 'string') return checked
  const amount = checked
  const owed = totalOwed(context.owePrincipal, context.oweInterest)
  if (owed === '') return fail('accountUnavailable', amount)
  if (cmp(amount, owed) > 0) return fail('aboveOwed', amount, { max: owed })
  // Server rule: amount >= minPayment OR amount >= everything still owed.
  if (isPositive(context.minPayment) && cmp(amount, context.minPayment) < 0 && cmp(amount, owed) < 0) {
    return fail('belowMinPayment', amount, { min: context.minPayment })
  }
  if (isDecimalString(context.available) && cmp(amount, context.available) > 0) {
    return fail('insufficient', amount, { available: groupDigits(context.available) })
  }
  return { ok: true, error: null, amount }
}

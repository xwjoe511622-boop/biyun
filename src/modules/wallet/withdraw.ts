import { groupDigits, cmp, gte, isDecimalString, isPositive, lt, sub } from '@/modules/finance/decimal'
import type { WithdrawConfig } from './types'

/**
 * Withdrawal pre-flight checks on decimal strings. They are a fast client-side guard only: the
 * server (CIAO `WithdrawDTO` + service layer) re-validates every value and its answer always wins.
 *
 * Source-confirmed against the CIAO contract (`WithdrawDTO`):
 *   - the client POSTs the **gross** `amount`; the server derives `payAmount = amount - fee`,
 *   - `fee` may legitimately be `0` when the coin's configured range is `0`–`0`,
 *   - a negative fee or amount is never acceptable (the server would reject it too).
 *
 *   amount (gross, debited)  > fee          -> net = amount - fee > 0
 *   amount (gross)          <= available
 *   withdraw_min <= net <= withdraw_max        (net = amount - fee; max `''` = unbounded)
 *   dayMax: net <= remaining daily quota
 */

export type WithdrawField = 'address' | 'amount' | 'fee' | 'code'

export interface WithdrawFieldError {
  field: WithdrawField
  /** i18n key resolved by the wallet panel. */
  key: string
  params?: Record<string, string>
}

export interface WithdrawDraft {
  /** Selected saved address id, required by the CIAO `WithdrawDTO.addressId`. */
  addressId: string
  /** Gross amount typed by the user; the fee is debited from it. */
  amount: string
  fee: string
}

export interface WithdrawContext {
  config: WithdrawConfig
  /** `normal_balance` of the coin, `''` when the balance snapshot is not loaded yet. */
  available: string
  /** Remaining daily quota (`withdraw_max_day`); `''` when not returned by this endpoint. */
  dayMax: string
  /** Maximum decimals accepted for the amount/fee (`coinList[coin].showPrecision`). */
  precision: number
  /** Optional explicit address text, used only to validate a manual address length. */
  addressText?: string
}

export interface WithdrawValidation {
  ok: boolean
  errors: WithdrawFieldError[]
  /** Net amount for review only; the request posts the gross amount. */
  net: string
  fee: string
}

function error(field: WithdrawField, key: string, params?: Record<string, string>): WithdrawFieldError {
  return params === undefined ? { field, key } : { field, key, params }
}

function places(value: string): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

export function validateWithdrawDraft(draft: WithdrawDraft, context: WithdrawContext): WithdrawValidation {
  const errors: WithdrawFieldError[] = []
  const amount = draft.amount.trim()
  const fee = draft.fee.trim()
  let net = ''

  if (draft.addressId.trim() === '') {
    errors.push(error('address', 'wallet.withdraw.error.addressRequired'))
  } else if (context.addressText !== undefined && context.addressText.trim() === '') {
    errors.push(error('address', 'wallet.withdraw.error.addressRequired'))
  }

  if (fee === '') {
    errors.push(error('fee', 'wallet.withdraw.error.feeRequired'))
  } else if (!isDecimalString(fee)) {
    // `isDecimalString` accepts `0` (a valid fee when the configured range is `0`–`0`) but
    // rejects negatives: the CIAO DTO has no negative-fee path.
    errors.push(error('fee', 'wallet.withdraw.error.feeInvalid'))
  } else if (places(fee) > context.precision) {
    errors.push(error('fee', 'wallet.withdraw.error.precision', { dp: String(context.precision) }))
  } else if (context.config.feeMin !== '' && lt(fee, context.config.feeMin)) {
    errors.push(error('fee', 'wallet.withdraw.error.feeBelowMin', { min: context.config.feeMin }))
  } else if (context.config.feeMax !== '' && cmp(fee, context.config.feeMax) > 0) {
    errors.push(error('fee', 'wallet.withdraw.error.feeAboveMax', { max: context.config.feeMax }))
  }

  if (amount === '') {
    errors.push(error('amount', 'wallet.withdraw.error.amountRequired'))
  } else if (!isDecimalString(amount) || !isPositive(amount)) {
    errors.push(error('amount', 'wallet.withdraw.error.amountInvalid'))
  } else if (places(amount) > context.precision) {
    errors.push(error('amount', 'wallet.withdraw.error.precision', { dp: String(context.precision) }))
  } else if (isDecimalString(fee)) {
    if (cmp(amount, fee) <= 0) {
      errors.push(error('amount', 'wallet.withdraw.error.amountNotAboveFee'))
    } else {
      net = sub(amount, fee)
      if (context.available !== '' && cmp(amount, context.available) > 0) {
        errors.push(error('amount', 'wallet.withdraw.error.insufficient', { available: groupDigits(context.available) }))
      }
      if (context.config.withdrawMin !== '' && !gte(net, context.config.withdrawMin)) {
        errors.push(
          error('amount', 'wallet.withdraw.error.belowMin', {
            min: context.config.withdrawMin,
            net,
          }),
        )
      }
      if (context.config.withdrawMax !== '' && cmp(net, context.config.withdrawMax) > 0) {
        errors.push(
          error('amount', 'wallet.withdraw.error.aboveMax', {
            max: context.config.withdrawMax,
            net,
          }),
        )
      }
      if (context.dayMax !== '' && cmp(net, context.dayMax) > 0) {
        errors.push(error('amount', 'wallet.withdraw.error.aboveDayMax', { max: context.dayMax }))
      }
    }
  }

  return { ok: errors.length === 0, errors, net, fee }
}

/**
 * Verification-code requirement matrix.
 *
 * - `requiredSecurityCodes` — the CIAO withdrawal submit (`WebAccountController#withdraw`): the DTO
 *   declares `googleCode` `@NotNull @Length(6,6)`, so Google is **always** required regardless of
 *   the account flags; the email code is required when an email is bound; the SMS code only when
 *   the account is mobile-only.
 * - `requiredAddressBookCodes` — legacy `AddrAct`: add requires Google plus email (or SMS for a
 *   mobile-only account); delete uses enabled Google/SMS factors and never checks email.
 */
export interface SecurityRequirement {
  google: boolean
  email: boolean
  sms: boolean
}

export function requiredSecurityCodes(security: {
  googleEnabled: boolean
  mobileCheckEnabled: boolean
  email: string
}): SecurityRequirement {
  const email = security.email.trim() !== ''
  return { google: true, email, sms: !email && security.mobileCheckEnabled }
}

export function requiredAddressBookCodes(security: {
  googleEnabled?: boolean
  mobileCheckEnabled: boolean
  email: string
}, action: 'add' | 'delete' = 'add'): SecurityRequirement {
  const email = security.email.trim() !== ''
  return action === 'delete'
    ? { google: security.googleEnabled === true, email: false, sms: security.mobileCheckEnabled }
    : { google: true, email, sms: !email && security.mobileCheckEnabled }
}

export interface SecurityCodeDraft {
  googleCode: string
  smsAuthCode: string
  emailValidCode: string
}

export function validateSecurityCodes(
  draft: SecurityCodeDraft,
  required: SecurityRequirement,
): WithdrawFieldError[] {
  const errors: WithdrawFieldError[] = []
  if (required.google && !/^\d{6}$/.test(draft.googleCode.trim())) {
    errors.push(error('code', 'wallet.withdraw.error.googleRequired'))
  }
  if (required.sms && !/^\d{6}$/.test(draft.smsAuthCode.trim())) {
    errors.push(error('code', 'wallet.withdraw.error.smsRequired'))
  }
  if (required.email && !/^\d{6}$/.test(draft.emailValidCode.trim())) {
    errors.push(error('code', 'wallet.withdraw.error.emailRequired'))
  }
  return errors
}

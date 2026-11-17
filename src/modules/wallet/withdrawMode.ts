import { cmp, isDecimalString, isPositive, isZero, min, sub, add, toFixedString } from '@/modules/finance/decimal'
import { findSavedAddress } from './networks'
import type { WalletAddress } from './types'
import { requiredSecurityCodes, type SecurityRequirement } from './withdraw'

/**
 * Withdrawal mode selection and the money maths shown next to the amount field.
 *
 * Contract v2 §4:
 *   - saved address (`addressId`)          -> `googleCode` only
 *   - direct address (`address`)            -> `googleCode` + `emailValidCode` (`smsAuthCode` for a
 *                                              mobile-only account), optional `saveAddress` + `label`
 * The historical backend only accepts `addressId`, and its security check demands Google + email
 * (+ SMS) for every withdrawal, so the legacy matrix is kept there and direct mode is unavailable.
 */

/** `network`: contract v2 backend detected; `legacy`: historical per-coin backend. */
export type WalletBackendShape = 'network' | 'legacy'

export type WithdrawMode = 'saved' | 'direct'

export type WithdrawTarget =
  | { mode: 'none' }
  | { mode: 'saved'; entry: WalletAddress }
  | { mode: 'direct'; address: string }

/** A typed/pasted address that equals a saved one is treated as that saved address. */
export function resolveWithdrawTarget(input: string, saved: WalletAddress[]): WithdrawTarget {
  const value = input.trim()
  if (value === '') {
    return { mode: 'none' }
  }
  const entry = findSavedAddress(saved, value)
  return entry !== undefined ? { mode: 'saved', entry } : { mode: 'direct', address: value }
}

export function directWithdrawSupported(shape: WalletBackendShape): boolean {
  return shape === 'network'
}

export interface SecurityProfile {
  googleEnabled: boolean
  mobileCheckEnabled: boolean
  email: string
}

/** Codes the confirmation modal asks for, per mode and backend shape. */
export function requiredWithdrawCodes(
  mode: WithdrawMode,
  security: SecurityProfile,
  shape: WalletBackendShape,
): SecurityRequirement {
  if (shape === 'network' && mode === 'saved') {
    return { google: true, email: false, sms: false }
  }
  // Direct (v2) and every legacy withdrawal: Google + email, or SMS for a mobile-only account.
  return requiredSecurityCodes(security)
}

/** Address-book factors: v2 add = Google + email (SMS if mobile-only), v2 delete = Google only. */
export function requiredBookCodes(
  action: 'add' | 'delete',
  security: SecurityProfile,
  shape: WalletBackendShape,
  legacy: (action: 'add' | 'delete') => SecurityRequirement,
): SecurityRequirement {
  if (shape === 'network') {
    return action === 'delete' ? { google: true, email: false, sms: false } : requiredSecurityCodes(security)
  }
  return legacy(action)
}

/** `switch.email_code_required` of public_info: `"0"` = off; absent or anything else = required (server default). */
export function emailCodeRequired(publicInfo: { switch?: Record<string, unknown> } | null | undefined): boolean {
  return String(publicInfo?.switch?.email_code_required ?? '1').trim() !== '0'
}

/**
 * QA-023 (10-25): while the e-mail-code switch is off (no mail service), the v2 wallet backend verifies an e-mail
 * account with the Google code alone (`wallet::security`); asking for an e-mail code that can never arrive blocked every
 * new-address withdrawal. A mobile-only account still needs its SMS code; legacy rows keep their matrix.
 */
export function applyEmailCodeSwitch(required: SecurityRequirement, shape: WalletBackendShape, emailCodeOn: boolean): SecurityRequirement {
  return shape === 'network' && !emailCodeOn && required.email ? { ...required, email: false } : required
}

/** `amount - fee` when both are valid decimals and the result is positive; `''` otherwise. */
export function receiveAmount(amount: string, fee: string): string {
  const gross = amount.trim()
  const cost = fee.trim()
  if (!isDecimalString(gross) || !isDecimalString(cost) || !isPositive(gross)) {
    return ''
  }
  if (cmp(gross, cost) <= 0) {
    return ''
  }
  return sub(gross, cost)
}

export type ApprovalHint = 'auto' | 'review' | 'newAddress' | 'unknown'

/**
 * Auto-approval hint from the server `autoApprovalThreshold` (compared with the net amount the row
 * will carry). No threshold reported -> `unknown`; a zero threshold means auto-approval is off.
 *
 * §6.3: auto-approval requires the destination to be in the address book. A pasted new address that
 * is not saved with the submission (`eligible = false`) always goes to dual manual approval.
 */
export function approvalHint(net: string, threshold: string | undefined, eligible = true): ApprovalHint {
  if (!eligible) {
    return 'newAddress'
  }
  if (threshold === undefined || threshold === '' || !isDecimalString(threshold) || net === '' || !isDecimalString(net)) {
    return 'unknown'
  }
  if (isZero(threshold)) {
    return 'review'
  }
  return cmp(net, threshold) <= 0 ? 'auto' : 'review'
}

/**
 * Largest gross amount the MAX button fills: bounded by the available balance and, when reported,
 * by `withdrawMax + fee` and `dailyRemaining + fee` (limits apply to the net amount). Rounded down to
 * the coin precision. `''` when nothing positive can be withdrawn.
 */
export function maxGrossAmount(input: {
  available: string
  fee: string
  withdrawMax: string
  dailyRemaining: string
  precision: number
}): string {
  if (!isDecimalString(input.available) || !isPositive(input.available)) {
    return ''
  }
  const fee = isDecimalString(input.fee) ? input.fee : '0'
  let cap = input.available
  if (isDecimalString(input.withdrawMax) && isPositive(input.withdrawMax)) {
    cap = min(cap, add(input.withdrawMax, fee))
  }
  if (isDecimalString(input.dailyRemaining)) {
    cap = min(cap, add(input.dailyRemaining, fee))
  }
  const rounded = trimZeros(toFixedString(cap, Math.max(0, input.precision)))
  return isPositive(rounded) && cmp(rounded, fee) > 0 ? rounded : ''
}

function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

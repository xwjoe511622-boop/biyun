/**
 * Pure helpers for the account-security page.
 *
 * These encode rules that were confirmed in the legacy PC client so the new view does not
 * invent states, weaken factors or render an off switch when the API never said "off":
 * - password rule: `regExp.passWord` (`vuex/regExp.js`)
 * - verification code rule: `regExp.verification` (`6` digits)
 * - factor states: `googleStatus` / `isOpenMobileCheck` from `/common/user_info`
 * - KYC mapping: `authLevel` (0 未审核 / 1 通过 / 2 未通过 / 3 未认证)
 *   (`common-mixin/personal/UserManagement`, `common-mixin/personal/IdAuth`)
 */

/** Legacy `regExp.passWord`: at least one letter, plus a digit or symbol, 8–23 non-space chars. */
export const PASSWORD_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d|.*[^\da-zA-Z])[^\s]{8,23}$/

/** Legacy `regExp.verification`: exactly six digits (Google / SMS / email codes). */
export const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/

export function isValidPassword(value: string): boolean {
  return PASSWORD_PATTERN.test(value)
}

export function isValidVerificationCode(value: string): boolean {
  return VERIFICATION_CODE_PATTERN.test(value)
}

/**
 * A 2FA factor state. `unknown` is used whenever the server did not return the flag, so the UI
 * never shows a fake "off" state for a value it does not have.
 */
export type FactorState = 'enabled' | 'disabled' | 'unknown'

export function readFactorState(value: unknown): FactorState {
  if (value === undefined || value === null) {
    return 'unknown'
  }
  const raw = String(value).trim()
  if (raw === '') {
    return 'unknown'
  }
  if (raw === '1') {
    return 'enabled'
  }
  if (raw === '0') {
    return 'disabled'
  }
  return 'unknown'
}

export type KycStatusKey = 'verified' | 'pending' | 'rejected' | 'unverified' | 'unknown'

export interface KycStatus {
  /** Raw `authLevel` string, preserved exactly as returned. */
  raw: string
  key: KycStatusKey
}

export function readKycStatus(authLevel: unknown): KycStatus {
  if (authLevel === undefined || authLevel === null) {
    return { raw: '', key: 'unknown' }
  }
  const raw = String(authLevel).trim()
  switch (raw) {
    case '1':
      return { raw, key: 'verified' }
    case '0':
      return { raw, key: 'pending' }
    case '2':
      return { raw, key: 'rejected' }
    case '3':
      return { raw, key: 'unverified' }
    default:
      return { raw, key: 'unknown' }
  }
}

/** /common/user_info: PublicAct.user_account_status(excStatus, withdrawStatus). */
export function accountStatusKey(value: string): 'normal' | 'frozen' | 'tradingFrozen' | 'withdrawalsFrozen' | null {
  switch (value.trim()) {
    case '0': return 'normal'
    case '1': return 'frozen'
    case '2': return 'tradingFrozen'
    case '3': return 'withdrawalsFrozen'
    default: return null
  }
}
/** UserSecurityAct opt_type_key / SetHistoryOptType; unknown types remain unknown. */
export function securityOperationKey(value: string | undefined): string | null {
  const names: Readonly<Record<string, string>> = { '1': 'mobile', '2': 'bindEmail', '3': 'password', '4': 'fundsPassword', '5': 'tradingVerification', '6': 'identity', '7': 'email', '8': 'disableSms', '9': 'disableTotp', '10': 'enableSms', '11': 'enableTotp' }
  const code = value?.trim() ?? ''
  return Object.hasOwn(names, code) ? names[code] ?? null : null
}

export interface Known<T> {
  known: boolean
  value: T
}

/** Reads a string field without inventing a value; `known` is false when the API omitted it. */
export function readText(value: unknown): Known<string> {
  if (typeof value === 'string') {
    return { known: true, value }
  }
  if (typeof value === 'number') {
    return { known: true, value: String(value) }
  }
  return { known: false, value: '' }
}

/** First non-empty value among candidates (legacy `mobileNumber || email || nickName` fallback). */
export function firstNonEmptyText(...candidates: unknown[]): Known<string> {
  for (const candidate of candidates) {
    const read = readText(candidate)
    if (read.known && read.value !== '') {
      return read
    }
  }
  return { known: false, value: '' }
}

/** Fixed-width mask for the TOTP secret; never derived from the real value. */
export function maskSecret(): string {
  return '•••• •••• •••• ••••'
}

export function isProvisioningUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith('otpauth://')
}

/**
 * RFC 4648 base32 alphabet (`A-Z`, `2-7`, optional `=` padding). Server-issued authenticator
 * keys are base32 (`GoogleAuthUtils.genSecret()`); a display-only `otpauth://` URI is not.
 */
const BASE32_PATTERN = /^[A-Z2-7]+=*$/

export function isBase32Secret(value: string): boolean {
  const normalized = value.trim().replace(/[\s-]/g, '').toUpperCase()
  if (normalized.length < 8 || normalized.length > 128) {
    return false
  }
  return BASE32_PATTERN.test(normalized)
}

/**
 * Whether the enrollment material can be sent back as `googleKey`. `user/google_verify` requires
 * the base32 secret (`UserCenterAct.googleVerify` rejects a blank key), so a blank string or an
 * `otpauth://` provisioning URI must never be submitted as `googleKey`.
 */
export function isSubmittableGoogleKey(value: string): boolean {
  return !isProvisioningUri(value) && isBase32Secret(value)
}

/**
 * Replaces any occurrence of `values` inside `message` before it can be rendered as an error.
 * Used so a verbose server message can never echo a submitted secret, OTP or password.
 */
export function redactSensitive(message: string, values: readonly string[]): string {
  let out = message
  for (const value of values) {
    if (value !== '') {
      out = out.split(value).join('••••')
    }
  }
  return out
}

/**
 * Only renders a QR the exchange itself produced: an inline raster `data:` URL or a
 * same-origin/relative image. Cross-origin image URLs (a third-party QR renderer or an
 * unverified CDN) are rejected so the enrollment secret is never sent to another origin.
 */
export function safeQrImage(value: string, origin: string): string {
  const raw = value.trim()
  if (raw === '') {
    return ''
  }
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
    return raw
  }
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) {
    return raw
  }
  try {
    const url = new URL(raw)
    return url.origin === origin && (url.protocol === 'http:' || url.protocol === 'https:')
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export type ActivityResult = 'success' | 'failure' | 'unknown'

/** Legacy compares `lgStatus === 1` for a successful login entry; raw values are preserved. */
export function readActivityResult(status: string): ActivityResult {
  const raw = status.trim()
  if (raw === '1') {
    return 'success'
  }
  if (raw === '' ) {
    return 'unknown'
  }
  return 'failure'
}

export function totalPages(count: number, pageSize: number): number {
  if (pageSize <= 0 || count <= 0) {
    return 1
  }
  return Math.max(1, Math.ceil(count / pageSize))
}

/**
 * Normalises what a user types or pastes into a 6-digit code box: keeps digits only (so "123 456",
 * "123-456" or a pasted "Code: 123456" work) and caps at six.
 */
export function sanitizeOtpInput(value: string): string {
  return value.replace(/\D+/g, '').slice(0, 6)
}

/** Base32 secret split into groups of four for manual entry (spaces are ignored by authenticator apps). */
export function formatSecretGroups(secret: string): string {
  const compact = secret.replace(/\s+/g, '')
  return compact.match(/.{1,4}/g)?.join(' ') ?? ''
}

/**
 * What a failed `user/google_verify` means for the form (codes from `WebApiResultType`):
 * - `10010` GoogleCodeError: the 6-digit code was rejected (wrong entry, expired window or phone clock drift)
 * - `10050` PwdError / `10011` OldPwdError: the login password was rejected
 */
export type TotpFailure = 'code' | 'password' | 'other'

export function classifyTotpFailure(code: string): TotpFailure {
  if (code === '10010') return 'code'
  if (code === '10050' || code === '10011') return 'password'
  return 'other'
}

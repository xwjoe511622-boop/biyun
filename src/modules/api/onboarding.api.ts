import { ApiError } from '@/core/errors'
import {
  normalizeCountryCode,
  readPasswordResetChallenge,
  readRegistrationAutoLoginToken,
  readRegistrationCookieSession,
  readRegistrationToken,
  type PasswordResetChallenge,
} from '@/modules/auth/onboarding-state'
import { request } from './http'

/**
 * Registration, password recovery and login second-step code endpoints.
 *
 * Every path, field name, enum value and signing rule below was recovered from the legacy PC call
 * sites and confirmed against the current `exchange-web-api` controllers:
 *
 * - `PC/common-mixin/register/register.js` — `reg_{email,mobile}_chk_info` (signed),
 *   `reg_{email,mobile}_confirm` (plain), code sends with `operationType` `1`.
 * - `PC/common-mixin/resetPass/resetPass.js` — `v4/user/reset_password_step_{one,two}` (plain),
 *   `user/reset_password_step_three` (signed), code sends with `operationType` `24`/`3`.
 * - `PC/common-mixin/login/login.js` — `user/login_in` / `user/confirm_login` (signed), code sends
 *   with `operationType` `25`/`4`.
 * - `exchange-web-api/.../RegisterAct.java` (`reg*ChkInfo` decrypt `ApiSecurityDto` and verify
 *   `Sign`/`Timestamp`; `reg*Confirm` read a plain `Map`; `checkParamIsNull` requires the
 *   `geetest_*` keys to be *present*, so they are always sent, empty when unused).
 * - `exchange-web-api/.../UserAct.java` (`v4/user/reset_password_step_one|two` read a plain `Map`;
 *   `reset_password_step_three` decrypts `ApiSecurityDto`, so the body must be signed).
 * - `exchange-web-api/.../ValidCodeAct.java` (`v4/common/{sms,email}ValidCode`).
 * - `exchange-common/.../enums/SmsOperateTypeEnum.java`, `EmailOperateTypeEnum.java` (numbers).
 *
 * Session isolation: every call here is `anonymous: true`. These screens carry a *purpose token*
 * (registration token / recovery token / login challenge token) in the body; the server picks a
 * different code path when a logged-in session is present (`ValidCodeAct.getSmsValidCodeV4`
 * branches on `getUserFromDB`), so an unrelated JWT must never be attached to them.
 *
 * Contract status: legacy-source-confirmed and live-unverified. No request was issued to a real
 * server while building this module.
 */
export const ONBOARDING_ENDPOINTS = {
  /** Signed (`ApiSecurityDto`). */
  registerEmailCheckInfo: 'user/reg_email_chk_info',
  /** Signed (`ApiSecurityDto`). */
  registerMobileCheckInfo: 'user/reg_mobile_chk_info',
  /** Plain body `{ token, emailCode }`; may return a login token for the new account. */
  registerEmailConfirm: 'user/reg_email_confirm',
  /** Plain body `{ token, smsCode }`; may return a login token for the new account. */
  registerMobileConfirm: 'user/reg_mobile_confirm',
  /** Plain body (v4 variant of `reset_password_step_one`). */
  resetPasswordStepOne: 'v4/user/reset_password_step_one',
  /** Plain body (v4 variant of `reset_password_step_two`). */
  resetPasswordStepTwo: 'v4/user/reset_password_step_two',
  /** Signed (`ApiSecurityDto`, decrypted server-side). */
  resetPasswordStepThree: 'user/reset_password_step_three',
  /** Plain body `{ token, countryCode?, operationType }`. */
  smsValidCode: 'v4/common/smsValidCode',
  /** Plain body `{ token, operationType }`. */
  emailValidCode: 'v4/common/emailValidCode',
  /** Plain, body-less `POST` that starts a Geetest v3 challenge (`{ captcha: {...} }`). */
  tartCaptcha: 'common/tartCaptcha',
} as const

/** `SmsOperateTypeEnum` values used by these screens. */
export const SMS_OPERATION = {
  /** `RegistByMobile(1)`. */
  registerMobile: 1,
  /** `FindPassword(24)`. */
  resetPassword: 24,
  /** `PhoneLogin(25)` — login step-two SMS code. */
  phoneLogin: 25,
} as const

/** `EmailOperateTypeEnum` values used by these screens. */
export const EMAIL_OPERATION = {
  /** `RegistByEmail(1)`. */
  registerEmail: 1,
  /** `FindPassword(3)`. */
  resetPassword: 3,
  /** `EmailLogin(4)` — login step-two email code. */
  emailLogin: 4,
} as const

// ---------------------------------------------------------------------------------------------
// Captcha proof
// ---------------------------------------------------------------------------------------------

/**
 * A slider proof. `verificationType` is always sent (the server compares it with its configured
 * vendor and rejects a mismatch); vendor fields are sent empty when unused — no forged values.
 */
export interface CaptchaProof {
  verificationType: string
  csessionid?: string
  sig?: string
  token?: string
  scene?: string
  geetest_challenge?: string
  geetest_validate?: string
  geetest_seccode?: string
}

const CAPTCHA_FIELD_KEYS = [
  'csessionid',
  'sig',
  'token',
  'scene',
  'geetest_challenge',
  'geetest_validate',
  'geetest_seccode',
] as const

/**
 * Flattens a proof into the exact key set the controllers read. All `geetest_*` keys are always
 * present because `RegisterAct.checkParamIsNull` only checks `containsKey`, not emptiness.
 */
function captchaFields(proof: CaptchaProof): Record<string, string> {
  const fields: Record<string, string> = { verificationType: String(proof.verificationType) }
  for (const key of CAPTCHA_FIELD_KEYS) {
    const value = proof[key]
    fields[key] = typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }
  return fields
}

function malformed(path: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', message: 'auth.error.malformed', path })
}

function badRequest(path: string, message = 'auth.error.badRequest'): ApiError {
  return new ApiError({ kind: 'api', code: '', message, path })
}

function requireText(path: string, value: string): string {
  const text = value.trim()
  if (text === '') {
    throw badRequest(path)
  }
  return text
}

function asObject(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null
}

/**
 * Optional transport controls. `signal` lets a view cancel a request that was superseded (account
 * change, step reset, unmount) instead of letting it finish and be discarded.
 */
export interface RequestSignalOptions {
  signal?: AbortSignal
}

/** Only adds a `signal` key when the caller supplied one, so the wire contract stays identical. */
function withSignal(options: RequestSignalOptions | undefined): { signal?: AbortSignal } {
  return options?.signal === undefined ? {} : { signal: options.signal }
}

// ---------------------------------------------------------------------------------------------
// Geetest v3 challenge (`common/tartCaptcha`)
// ---------------------------------------------------------------------------------------------

/**
 * The challenge the server builds from `sys_conf_geetest_config`
 * (`BaseAct#tartCaptcha` -> `StartCaptchaServlet.captch1` -> `GeetestLib.getResponseStr()`).
 *
 * `success: false` is geetest's *offline failback*. The backend always verifies with
 * `enhencedValidateRequest` (online), so an offline challenge cannot be accepted — the widget
 * refuses it instead of submitting an unverifiable proof. `newCaptcha` mirrors `new_captcha`.
 */
export interface GeetestChallenge {
  gt: string
  challenge: string
  success: boolean
  newCaptcha: boolean
}

function readBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : null
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1') {
      return true
    }
    if (text === 'false' || text === '0') {
      return false
    }
  }
  return null
}

/**
 * Narrow parse of `data.captcha`. `null` on any structural mismatch (missing/blank `gt` or
 * `challenge`, or an unreadable `success`) so the caller blocks instead of initting with junk.
 */
export function readGeetestChallenge(data: unknown): GeetestChallenge | null {
  const root = asObject(data)
  if (root === null) {
    return null
  }
  const captcha = asObject(root.captcha)
  if (captcha === null) {
    return null
  }
  const gt = typeof captcha.gt === 'string' ? captcha.gt.trim() : ''
  const challenge = typeof captcha.challenge === 'string' ? captcha.challenge.trim() : ''
  if (gt === '' || challenge === '') {
    return null
  }
  const success = readBool(captcha.success)
  if (success === null) {
    return null
  }
  return { gt, challenge, success, newCaptcha: readBool(captcha.new_captcha) === true }
}

/**
 * `common/tartCaptcha` — anonymous, body-less `POST`. Starts a fresh challenge for whatever
 * account/flow the proof will be bound to. Never signed and never forwards a session (the endpoint
 * is public and its presence in the register/login path is purposeful).
 */
export async function startTartCaptcha(options?: RequestSignalOptions): Promise<GeetestChallenge> {
  const path = ONBOARDING_ENDPOINTS.tartCaptcha
  const data = await request<unknown>(path, { anonymous: true, ...withSignal(options) })
  const challenge = readGeetestChallenge(data)
  if (challenge === null) {
    throw malformed(path)
  }
  return challenge
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export interface RegisterEmailCheckInput {
  email: string
  password: string
  confirmPassword: string
  /** Optional unless `switch.is_invitationCode_required === "1"`. */
  invitedCode?: string
  captcha: CaptchaProof
  signal?: AbortSignal
}

export interface RegisterMobileCheckInput {
  countryCode: string
  mobileNumber: string
  password: string
  confirmPassword: string
  invitedCode?: string
  captcha: CaptchaProof
  signal?: AbortSignal
}

/**
 * `user/reg_email_chk_info`. Signed body (`loginPword` + `newPassword` are both sent and must match
 * server-side), returns the pending registration token used by the confirm step.
 */
export async function registerEmailCheckInfo(input: RegisterEmailCheckInput): Promise<string> {
  const path = ONBOARDING_ENDPOINTS.registerEmailCheckInfo
  const body: Record<string, string> = {
    ...captchaFields(input.captcha),
    email: requireText(path, input.email),
    loginPword: input.password,
    newPassword: input.confirmPassword,
  }
  const invited = input.invitedCode === undefined ? '' : input.invitedCode.trim()
  if (invited !== '') {
    body.invitedCode = invited
  }
  const data = await request<unknown>(path, { body, signed: true, anonymous: true, ...withSignal(input) })
  const token = readRegistrationToken(data)
  if (token === null) {
    throw malformed(path)
  }
  return token
}

/** `user/reg_mobile_chk_info`. Same signed contract as the email variant (`countryCode` required). */
export async function registerMobileCheckInfo(input: RegisterMobileCheckInput): Promise<string> {
  const path = ONBOARDING_ENDPOINTS.registerMobileCheckInfo
  const body: Record<string, string> = {
    ...captchaFields(input.captcha),
    countryCode: normalizeCountryCode(requireText(path, input.countryCode)),
    mobileNumber: requireText(path, input.mobileNumber),
    loginPword: input.password,
    newPassword: input.confirmPassword,
  }
  const invited = input.invitedCode === undefined ? '' : input.invitedCode.trim()
  if (invited !== '') {
    body.invitedCode = invited
  }
  const data = await request<unknown>(path, { body, signed: true, anonymous: true, ...withSignal(input) })
  const token = readRegistrationToken(data)
  if (token === null) {
    throw malformed(path)
  }
  return token
}

export interface RegisterConfirmResult {
  /**
   * A real login JWT when `RegisterAct.startLogin` auto-signed the new account in, otherwise
   * `null`. A non-string/failed payload never becomes a session token.
   */
  autoLoginToken: string | null
  /** The server signed the new account in with the HttpOnly session cookie (cookie mode, 10-17). */
  cookieSession: boolean
}

/**
 * `user/reg_email_confirm` — plain body, no signature. `emailCode` is omitted only while the server reports the
 * email-code switch off (`switch.email_code_required = "0"`, 10-19).
 */
export async function registerEmailConfirm(
  input: { token: string; emailCode?: string } & RequestSignalOptions,
): Promise<RegisterConfirmResult> {
  const path = ONBOARDING_ENDPOINTS.registerEmailConfirm
  const body: Record<string, string> = { token: requireText(path, input.token) }
  if (input.emailCode !== undefined) body.emailCode = requireText(path, input.emailCode)
  const data = await request<unknown>(path, {
    body,
    anonymous: true,
    ...withSignal(input),
  })
  return { autoLoginToken: readRegistrationAutoLoginToken(data), cookieSession: readRegistrationCookieSession(data) }
}

/** `user/reg_mobile_confirm` — plain body, no signature. */
export async function registerMobileConfirm(
  input: { token: string; smsCode: string } & RequestSignalOptions,
): Promise<RegisterConfirmResult> {
  const path = ONBOARDING_ENDPOINTS.registerMobileConfirm
  const data = await request<unknown>(path, {
    body: { token: requireText(path, input.token), smsCode: requireText(path, input.smsCode) },
    anonymous: true,
    ...withSignal(input),
  })
  return { autoLoginToken: readRegistrationAutoLoginToken(data), cookieSession: readRegistrationCookieSession(data) }
}

/** `v4/common/emailValidCode` with `operationType: 1` (registration). */
export async function sendRegisterEmailCode(token: string, options?: RequestSignalOptions): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.emailValidCode
  return request<unknown>(path, {
    body: { token: requireText(path, token), operationType: EMAIL_OPERATION.registerEmail },
    anonymous: true,
    ...withSignal(options),
  })
}

/**
 * `v4/common/smsValidCode` with `operationType: 1` (registration).
 *
 * `countryCode` is required: the controller resolves `mobile` from the purpose token, then calls
 * `countryCode = user.getCountryCode()` on a `null` user when no country code was supplied, so
 * omitting it fails the request (the legacy client always sent it).
 */
export async function sendRegisterSmsCode(
  token: string,
  countryCode: string,
  options?: RequestSignalOptions,
): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.smsValidCode
  return request<unknown>(path, {
    body: {
      token: requireText(path, token),
      countryCode: normalizeCountryCode(requireText(path, countryCode)),
      operationType: SMS_OPERATION.registerMobile,
    },
    anonymous: true,
    ...withSignal(options),
  })
}

// ---------------------------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------------------------

export type RecoveryMode = 'email' | 'phone'

export interface PasswordResetStepOneInput {
  mode: RecoveryMode
  email?: string
  mobileNumber?: string
  captcha: CaptchaProof
  signal?: AbortSignal
}

/**
 * `v4/user/reset_password_step_one` — plain body (the v4 handler is a `Map`, not an
 * `ApiSecurityDto`). Returns the recovery token plus the factors the *server* says are required.
 */
export async function resetPasswordStepOne(input: PasswordResetStepOneInput): Promise<PasswordResetChallenge> {
  const path = ONBOARDING_ENDPOINTS.resetPasswordStepOne
  const body: Record<string, string> = { ...captchaFields(input.captcha) }
  if (input.mode === 'phone') {
    body.mobileNumber = requireText(path, input.mobileNumber ?? '')
  } else {
    body.email = requireText(path, input.email ?? '')
  }
  const data = await request<unknown>(path, { body, anonymous: true, ...withSignal(input) })
  const challenge = readPasswordResetChallenge(data)
  if (challenge === null) {
    throw malformed(path)
  }
  return challenge
}

/** `v4/common/emailValidCode` with `operationType: 3` (recovery). */
export async function sendRecoveryEmailCode(token: string, options?: RequestSignalOptions): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.emailValidCode
  return request<unknown>(path, {
    body: { token: requireText(path, token), operationType: EMAIL_OPERATION.resetPassword },
    anonymous: true,
    ...withSignal(options),
  })
}

/** `v4/common/smsValidCode` with `operationType: 24` (recovery; resolves mobile from the token). */
export async function sendRecoverySmsCode(token: string, options?: RequestSignalOptions): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.smsValidCode
  return request<unknown>(path, {
    body: { token: requireText(path, token), operationType: SMS_OPERATION.resetPassword },
    anonymous: true,
    ...withSignal(options),
  })
}

export interface PasswordResetStepTwoInput {
  token: string
  mode: RecoveryMode
  code: string
  /** Required by the server when the account has Google verification enabled. */
  googleCode?: string
  /** Required by the server when the account is real-name verified without Google. */
  certificateNumber?: string
  /** E-mail-code switch off (`switch.email_code_required = "0"`): no e-mail code is sent; Google verifies. */
  emailCodeOff?: boolean
  signal?: AbortSignal
}

/**
 * `v4/user/reset_password_step_two` — plain body. Field names are the exact server contract,
 * including the `certifcateNumber` typo used by `UserAct.resetStepTwoV4`.
 */
export async function resetPasswordStepTwo(input: PasswordResetStepTwoInput): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.resetPasswordStepTwo
  const body: Record<string, string> = {
    token: requireText(path, input.token),
    googleCode: input.googleCode === undefined ? '' : input.googleCode.trim(),
    certifcateNumber: input.certificateNumber === undefined ? '' : input.certificateNumber.trim(),
  }
  if (input.mode === 'phone') {
    body.smsCode = requireText(path, input.code)
  } else if (input.emailCodeOff === true) {
    // 10-20: e-mail-code switch off — the server verifies the Google code instead (user-api reset step two)
    body.emailCode = ''
  } else {
    body.emailCode = requireText(path, input.code)
  }
  return request<unknown>(path, { body, anonymous: true, ...withSignal(input) })
}

export interface PasswordResetStepThreeInput {
  token: string
  password: string
  signal?: AbortSignal
}

/**
 * `user/reset_password_step_three` — signed body (`ApiSecurityDto`). The server re-checks the
 * token, the capital-password inequality rule and then invalidates every session.
 */
export async function resetPasswordStepThree(input: PasswordResetStepThreeInput): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.resetPasswordStepThree
  return request<unknown>(path, {
    body: { token: requireText(path, input.token), loginPword: requireText(path, input.password) },
    signed: true,
    anonymous: true,
    ...withSignal(input),
  })
}

// ---------------------------------------------------------------------------------------------
// Login second-step codes
// ---------------------------------------------------------------------------------------------

/**
 * `v4/common/smsValidCode` with `operationType: 25`. `token` is the login challenge token from
 * `user/login_in` (stored under `TOKEN_TEST`), not a session JWT — hence `anonymous: true` so the
 * server takes the challenge branch instead of a signed-in user's branch.
 */
export async function sendLoginSmsCode(token: string, options?: RequestSignalOptions): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.smsValidCode
  return request<unknown>(path, {
    // cookie mode (10-17): `token` is '' and the server reads the HttpOnly challenge cookie
    body: token === '' ? { operationType: SMS_OPERATION.phoneLogin } : { token: requireText(path, token), operationType: SMS_OPERATION.phoneLogin },
    anonymous: true,
    ...withSignal(options),
  })
}

/** `v4/common/emailValidCode` with `operationType: 4`. */
export async function sendLoginEmailCode(token: string, options?: RequestSignalOptions): Promise<unknown> {
  const path = ONBOARDING_ENDPOINTS.emailValidCode
  return request<unknown>(path, {
    body: token === '' ? { operationType: EMAIL_OPERATION.emailLogin } : { token: requireText(path, token), operationType: EMAIL_OPERATION.emailLogin },
    anonymous: true,
    ...withSignal(options),
  })
}

/** Sends the login step-two code for the challenge type (`1` Google needs none). */
export function sendLoginCode(
  verifyType: string,
  token: string,
  options?: RequestSignalOptions,
): Promise<unknown> | null {
  if (verifyType === '2') {
    return sendLoginSmsCode(token, options)
  }
  if (verifyType === '3') {
    return sendLoginEmailCode(token, options)
  }
  return null
}

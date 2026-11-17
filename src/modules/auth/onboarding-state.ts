/**
 * Value rules and *honest* response readers for registration, password recovery and login.
 *
 * Everything here is intentionally pure so it can be unit-tested without a network or a DOM, and
 * every reader returns `null` instead of inventing a success when the server payload does not match
 * the documented contract. A `null` from this module must never be turned into a fake success by a
 * caller.
 *
 * Sources (legacy PC client + current `exchange-web-api`):
 * - `PC/vuex/regExp.js` — the exact client-side patterns the legacy register/recover/login forms
 *   applied before submitting (`phone`, `email`, `verification`, `passWord`, `nonEmpty`).
 * - `PC/common-mixin/register/register.js`, `resetPass/resetPass.js`, `login/login.js` — field
 *   names, tab rules and step state.
 * - `exchange-web-api/.../PublicAct.publicInfoV4` — `switch.login_regist_type`,
 *   `switch.is_invitationCode_required`, `switch.verificationType`, `switch.regist_must_check_open`.
 */

/** Legacy `regExp.verification`: exactly six digits (Google / SMS / email codes). */
export const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/

/** Legacy `regExp.passWord`: 8–23 chars, at least one letter, plus a digit or symbol, no spaces. */
export const PASSWORD_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d|.*[^\da-zA-Z])[^\s]{8,23}$/

/** Legacy `regExp.phone` (PC): at least seven digits, no punctuation. */
export const PHONE_PATTERN = /^[0-9]{7,}$/

/**
 * Legacy `regExp.email` was `/@+/` — a very loose precheck; the server stays authoritative.
 * We keep a mild superset check (non-empty local part, no whitespace, a single `@`) so an obviously
 * broken value never reaches the server, without rejecting addresses the legacy form accepted.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/

export function isNonEmpty(value: string): boolean {
  return value.trim() !== ''
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim())
}

export function isValidPhone(value: string): boolean {
  return PHONE_PATTERN.test(value.trim())
}

export function isValidVerificationCode(value: string): boolean {
  return VERIFICATION_CODE_PATTERN.test(value.trim())
}

export function isValidPassword(value: string): boolean {
  return PASSWORD_PATTERN.test(value)
}

export function passwordsMatch(password: string, confirmation: string): boolean {
  return password !== '' && password === confirmation
}

export function normalizeCountryCode(value: string): string {
  return value.trim().replace(/^\+/, '')
}

// ---------------------------------------------------------------------------------------------
// Server switches (all values arrive as strings such as "0" / "1")
// ---------------------------------------------------------------------------------------------

export type SwitchMap = Record<string, string | number> | undefined | null

function switchValue(map: SwitchMap, key: string): string | undefined {
  if (map === undefined || map === null) {
    return undefined
  }
  const raw = map[key]
  if (raw === undefined || raw === null) {
    return undefined
  }
  const text = String(raw).trim()
  return text === '' ? undefined : text
}

/** `1` phone + email, `2` phone only, `3` email only (server default `1`). */
export type RegistrationMode = 'both' | 'phone' | 'email'

export function registrationMode(map: SwitchMap): RegistrationMode {
  const raw = switchValue(map, 'login_regist_type')
  if (raw === '2') {
    return 'phone'
  }
  if (raw === '3') {
    return 'email'
  }
  return 'both'
}

export function modeAllowsEmail(mode: RegistrationMode): boolean {
  return mode !== 'phone'
}

export function modeAllowsPhone(mode: RegistrationMode): boolean {
  return mode !== 'email'
}

/** Tabs in the order the modern PC form renders them: email first, phone only when configured. */
export function registrationTabs(mode: RegistrationMode): Array<'email' | 'phone'> {
  const tabs: Array<'email' | 'phone'> = []
  if (modeAllowsEmail(mode)) {
    tabs.push('email')
  }
  if (modeAllowsPhone(mode)) {
    tabs.push('phone')
  }
  return tabs
}

/** `switch.is_invitationCode_required === "1"` — the write path also re-checks this server-side. */
export function isInvitationCodeRequired(map: SwitchMap): boolean {
  return switchValue(map, 'is_invitationCode_required') === '1'
}

// ---------------------------------------------------------------------------------------------
// Slider captcha selection
// ---------------------------------------------------------------------------------------------

export type CaptchaProviderKind = 'aliyun' | 'geetest' | 'unsupported'

/**
 * `switch.verificationType`: `1` = Aliyun NC (the server default when unset), `2` = Geetest.
 * Any other value is reported as `unsupported` because its exact proof contract is unknown to us.
 */
export function captchaProvider(map: SwitchMap): CaptchaProviderKind {
  const raw = switchValue(map, 'verificationType')
  if (raw === undefined || raw === '1') {
    return 'aliyun'
  }
  if (raw === '2') {
    return 'geetest'
  }
  return 'unsupported'
}

/**
 * `switch.captcha_required` — the server's *total* slider policy
 * (`PublicAct.publicInfoV4`: `"0"` when `sys_conf_geetest_switch == Constants.OFF`, else `"1"`).
 * When it is `"0"`, `BaseAct.checkAllvalidCode` returns "pass" before looking at the vendor, so the
 * endpoints accept a body with no proof at all.
 *
 * Fail closed: an absent/unreadable value is treated as "required". Only the exact string `"0"`
 * (the server's own `Constants.OFF`) disables the slider.
 */
export function readCaptchaRequired(map: SwitchMap): boolean {
  return switchValue(map, 'captcha_required') !== '0'
}

// ---------------------------------------------------------------------------------------------
// Optional server-provided links
// ---------------------------------------------------------------------------------------------

const TERMS_URL_KEYS = ['agreement', 'agreementUrl', 'userAgreement', 'user_agreement', 'termsUrl'] as const

/** A http(s) URL only: `javascript:`/`data:` values from configuration are never rendered. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^https?:\/\//i.test(text)) {
    return null
  }
  return text
}

/**
 * The current `public_info_v4` returns only platform site URLs (`exUrl`, `mexUrl`, …), so in
 * practice there is no terms document to link yet. No URL is ever invented: the form renders a
 * terms link only when the operator publishes one of the keys below in `publicInfo.url`.
 */
export function termsUrlFrom(urlMap: Record<string, unknown> | undefined | null): string | null {
  if (urlMap === undefined || urlMap === null) {
    return null
  }
  for (const key of TERMS_URL_KEYS) {
    const url = safeHttpUrl(urlMap[key])
    if (url !== null) {
      return url
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Response readers
// ---------------------------------------------------------------------------------------------

function asObject(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null
}

/** A non-empty string token, or `null`. Never coerces `true`/numbers into a token. */
export function readToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const token = value.trim()
  return token === '' ? null : token
}

function readFlag(record: Record<string, unknown>, key: string): boolean | null {
  const raw = record[key]
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const text = String(raw).trim()
  if (text === '1') {
    return true
  }
  if (text === '0') {
    return false
  }
  return null
}

/** Step-one registration (`reg_*_chk_info`) returns the pending registration token. */
export function readRegistrationToken(data: unknown): string | null {
  const record = asObject(data)
  return record === null ? null : readToken(record.token)
}

/**
 * `reg_*_confirm` may return a real login JWT for the freshly created account
 * (`RegisterAct.startLogin` -> `data.token`). An empty/absent value means "registered, now sign in"
 * and is returned as `null` — it is never promoted to a session.
 */
export function readRegistrationAutoLoginToken(data: unknown): string | null {
  const record = asObject(data)
  return record === null ? null : readToken(record.token)
}

/** Cookie-mode auto-login (10-17): `{ uid, session: "cookie" }`, the session is the HttpOnly cookie just set. */
export function readRegistrationCookieSession(data: unknown): boolean {
  const record = asObject(data)
  return record !== null && record.session === 'cookie'
}

export interface PasswordResetChallenge {
  token: string
  /**
   * `true` required, `false` explicitly not required, `null` = the server did not say, in which
   * case the second step must not be submitted (we cannot know which factor is required).
   */
  googleRequired: boolean | null
  certificateRequired: boolean | null
}

/**
 * `v4/user/reset_password_step_one` -> `{ token, isGoogleAuth, isCertificateNumber }`.
 * The token is mandatory; the factor flags are mandatory too because the server derives them from
 * the account and never falls back to "no factor". A missing flag is surfaced as `null` so the UI
 * blocks instead of silently skipping a factor.
 */
export function readPasswordResetChallenge(data: unknown): PasswordResetChallenge | null {
  const record = asObject(data)
  if (record === null) {
    return null
  }
  const token = readToken(record.token)
  if (token === null) {
    return null
  }
  return {
    token,
    googleRequired: readFlag(record, 'isGoogleAuth'),
    certificateRequired: readFlag(record, 'isCertificateNumber'),
  }
}

export type LoginVerifyType = '1' | '2' | '3'

/** `login_in` -> `{ token, type }` where `type` is `1` Google, `2` SMS, `3` email. */
export function readLoginVerifyType(value: unknown): LoginVerifyType | null {
  if (value === undefined || value === null) {
    return null
  }
  const text = String(value).trim()
  return text === '1' || text === '2' || text === '3' ? text : null
}

/** Human-readable label key for a verify type. */
export function verifyTypeLabelKey(type: LoginVerifyType): string {
  if (type === '1') {
    return 'auth.login.verifyType1'
  }
  return type === '3' ? 'auth.login.verifyType3' : 'auth.login.verifyType2'
}

/** Best-effort mask for "code sent to …" notices. Never used to render a stored credential. */
export function maskAccount(value: string): string {
  const text = value.trim()
  if (text === '') {
    return ''
  }
  if (text.includes('@')) {
    const [name, domain] = text.split('@', 2)
    const head = name.slice(0, 1)
    return `${head}${'*'.repeat(Math.max(name.length - 1, 1))}@${domain}`
  }
  if (text.length <= 4) {
    return '*'.repeat(text.length)
  }
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`
}

// ---------------------------------------------------------------------------------------------
// Business codes (`WebApiResultType`) these screens react to
// ---------------------------------------------------------------------------------------------

export const API_RESULT_CODE = {
  /** `AliyunValidateCodeError` — slider rejected/required (legacy `register.js` `error10003`). */
  sliderRequired: '10003',
  /** `SmsSendFrequently`. */
  sendTooFrequently: '10005',
  /** `GoogleCodeError`. */
  googleCodeWrong: '10010',
  /** `UserDoesNotExist`. */
  userNotFound: '10016',
  /** `TokenInvalid`. */
  tokenInvalid: '10021',
  /** `ErrorCode` — wrong SMS/email/Google code. */
  codeWrong: '10022',
  /** `CertificateInvaild`. */
  certificateInvalid: '10025',
  /** `FindPasswordTokenExpire`. */
  recoveryTokenExpired: '10031',
  /** `Open_Handpwd_Verify_Timeout` — step two took too long. */
  verifyTimeout: '10052',
  /** `ValidateCodeTypeError` — submitted slider vendor differs from the server config. */
  sliderTypeMismatch: '10055',
} as const

/** Any of these means the recovery token is gone and step one must be repeated. */
export function isRecoveryTokenExpired(code: string): boolean {
  return (
    code === API_RESULT_CODE.tokenInvalid ||
    code === API_RESULT_CODE.recoveryTokenExpired ||
    code === API_RESULT_CODE.verifyTimeout
  )
}

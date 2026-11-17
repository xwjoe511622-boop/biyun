import { z } from 'zod'
import { ApiError } from '@/core/errors'
import { isSubmittableGoogleKey } from '@/modules/security/security-state'
import { request } from './http'

/**
 * Account-security endpoints.
 *
 * Sources (exact paths, params and response fields recovered from the legacy PC client):
 * - `app/view/src/components/BlockChain-ui-privatization/PC/vuex/url.js` (`common.*`)
 * - `app/view/src/components/BlockChain-ui-privatization/PC/vuex/personal.js` (actions/params)
 * - `app/view/src/components/BlockChain-ui-privatization/PC/common-mixin/personal/{BindGoogle,ChangePassword,SafetyRecord}`
 *
 * Contract status:
 * - `/common/user_info` (the status source for this page) is in
 *   `api-contracts/openapi/pc-exchange-web-api.openapi.yaml` (`x-evidence-level: source-confirmed`).
 * - The endpoints below are in `wallet-security.openapi.yaml`. They are legacy-source-confirmed and
 *   live-unverified: no request in this task was sent to a real server. The legacy site calls them
 *   through the same `/fe-ex-api/` prefix with the same `exchange-token` header, so `request()`
 *   reaches them exactly like the modern client reaches the documented ones.
 *
 * Never invents params: every field name below exists in the recovered legacy call sites.
 */
export const SECURITY_ENDPOINTS = {
  /** Legacy `common.toopen_google_authenticator` — returns `{ googleImg, googleKey }`. */
  startTotp: 'user/toopen_google_authenticator',
  /** Legacy `common.google_verify` — body `{ googleKey, googleCode, loginPwd }`, signed. */
  verifyTotp: 'user/google_verify',
  /** Legacy `common.reset_password` (`user/password_update`) — signed. */
  passwordUpdate: 'user/password_update',
  /** Legacy `common.login_history`. */
  loginHistory: 'security/login_history',
  /** Legacy `common.setting_history`. */
  settingHistory: 'security/setting_history',
  /** Legacy `common.sms_code` (`v4/common/smsValidCode`). */
  smsValidCode: 'v4/common/smsValidCode',
} as const

/** `user/toopen_google_authenticator` result, normalized without inventing a QR provider. */
export interface TotpEnrollment {
  /** Server-rendered QR image (`data:` / same-origin only is rendered by the UI). */
  qrImage: string
  /** Server-issued secret or `otpauth://` provisioning URI. */
  secret: string
}

export interface TotpVerifyInput {
  secret: string
  code: string
  loginPassword: string
}

/**
 * `user/password_update` body. Field names are the exact legacy payload keys
 * (`ChangePassword.js#btnLink`); `smsAuthCode` / `googleCode` are the same factor keys the
 * legacy site required and the server consumes.
 */
export interface PasswordUpdateInput {
  loginPword: string
  newLoginPword: string
  smsAuthCode?: string
  googleCode?: string
}

export interface LoginHistoryItem {
  /** `formatLgInTime` — preserved as returned. */
  time: string
  /** `lgIp` — preserved as returned. */
  ip: string
  /** `lgPlatform` — preserved as returned. */
  platform: string
  /** `lgStatus` — `"1"` means success in the legacy view; raw value preserved. */
  status: string
}

export interface SettingHistoryItem {
  /** `formatCtime` — preserved as returned. */
  time: string
  /** `optTypeName` — preserved as returned. */
  operation: string
  /** Raw optType is retained for localized fallback when optTypeName is empty. */
  operationType?: string
  /** `optIp` — preserved as returned. */
  ip: string
}

export interface ActivityPage<T> {
  /** Required server total; omitted/malformed values fail validation. */
  count: number
  items: T[]
}

export interface ActivityQuery {
  page: number
  pageSize: number
}

function parseError(path: string, fields: string): ApiError {
  return new ApiError({
    kind: 'parse',
    code: '',
    path,
    // Only field paths are included; never response values, secrets or OTPs.
    message: `API contract mismatch: ${path} [${fields}]`,
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const enrollmentSchema = z
  .object({
    googleImg: z.string().nullish(),
    googleKey: z.string().nullish(),
  })
  .passthrough()

/**
 * Starts TOTP enrollment. Called only from an explicit user action — never on page load.
 * The server renders the QR; this client never builds one through a third-party image service.
 */
export async function startTotpEnrollment(): Promise<TotpEnrollment> {
  const path = SECURITY_ENDPOINTS.startTotp
  const data = await request<unknown>(path, { body: {} })
  const parsed = enrollmentSchema.safeParse(data)
  if (!parsed.success) {
    throw parseError(path, 'googleImg, googleKey')
  }
  const qrImage = text(parsed.data.googleImg)
  const secret = text(parsed.data.googleKey)
  if (qrImage === '' && secret === '') {
    // The server returned a 2xx envelope but no usable enrollment material.
    throw new ApiError({
      kind: 'parse',
      code: '',
      path,
      message: 'security.error.enrollmentUnsupported',
    })
  }
  return { qrImage, secret }
}

/** Confirms TOTP enrollment while the account password is still known (legacy signs this call). */
export async function verifyTotpEnrollment(input: TotpVerifyInput): Promise<unknown> {
  // Defense in depth: `user/google_verify` needs the base32 secret. A blank value or an
  // `otpauth://` URI must never be submitted as `googleKey` (the server blank-checks it and
  // encrypts the raw string). The panel already blocks this; the API refuses it too.
  if (!isSubmittableGoogleKey(input.secret)) {
    throw new ApiError({
      kind: 'parse',
      code: '',
      path: SECURITY_ENDPOINTS.verifyTotp,
      message: 'security.error.enrollmentUnsupported',
    })
  }
  return request<unknown>(SECURITY_ENDPOINTS.verifyTotp, {
    body: { googleKey: input.secret, googleCode: input.code, loginPwd: input.loginPassword },
    signed: true,
  })
}

/** Changes the login password. Legacy signs this call and then forces a logout. */
export function updatePassword(input: PasswordUpdateInput): Promise<unknown> {
  const body: Record<string, string> = {
    loginPword: input.loginPword,
    newLoginPword: input.newLoginPword,
  }
  if (input.smsAuthCode !== undefined && input.smsAuthCode !== '') {
    body.smsAuthCode = input.smsAuthCode
  }
  if (input.googleCode !== undefined && input.googleCode !== '') {
    body.googleCode = input.googleCode
  }
  return request<unknown>(SECURITY_ENDPOINTS.passwordUpdate, { body, signed: true })
}

/**
 * `count` is always returned by the backend (`UserSecurityAct.loginHistory` /
 * `settingHistory` put `count` into the data map). It is required here so a `{}` envelope can
 * never be mistaken for a successful empty page.
 */
const countSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])

const loginItemSchema = z
  .object({
    formatLgInTime: z.string().nullish(),
    lgIp: z.string().nullish(),
    lgPlatform: z.string().nullish(),
    lgStatus: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough()

const settingItemSchema = z
  .object({
    formatCtime: z.string().nullish(),
    optTypeName: z.string().nullish(),
    optType: z.union([z.string(), z.number().int()]).nullish(),
    optIp: z.string().nullish(),
  })
  .passthrough()

/**
 * Both fields are required. A valid "no records" page is `{ count: 0, historyLoginList: [] }`;
 * a `{}` (or missing-list / missing-count) envelope is a contract mismatch and fails closed so
 * the UI shows a parse error instead of an empty history.
 */
const loginHistorySchema = z
  .object({
    count: countSchema,
    historyLoginList: z.array(loginItemSchema),
  })
  .passthrough()

const settingHistorySchema = z
  .object({
    count: countSchema,
    historySettingList: z.array(settingItemSchema),
  })
  .passthrough()

/** Login history page (`security/login_history`, body `{ page, pageSize }`). */
export async function fetchLoginHistory(query: ActivityQuery): Promise<ActivityPage<LoginHistoryItem>> {
  const path = SECURITY_ENDPOINTS.loginHistory
  const data = await request<unknown>(path, {
    body: { page: query.page, pageSize: query.pageSize },
  })
  const source = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const parsed = loginHistorySchema.safeParse({
    count: source.count,
    historyLoginList: source.historyLoginList,
  })
  if (!parsed.success) {
    throw parseError(path, 'count, historyLoginList')
  }
  const items = parsed.data.historyLoginList.map((raw) => ({
    time: text(raw.formatLgInTime),
    ip: text(raw.lgIp),
    platform: text(raw.lgPlatform),
    status: raw.lgStatus === undefined || raw.lgStatus === null ? '' : String(raw.lgStatus),
  }))
  return { count: parsed.data.count, items }
}

/** Security-settings history page (`security/setting_history`, body `{ page, pageSize }`). */
export async function fetchSettingHistory(query: ActivityQuery): Promise<ActivityPage<SettingHistoryItem>> {
  const path = SECURITY_ENDPOINTS.settingHistory
  const data = await request<unknown>(path, {
    body: { page: query.page, pageSize: query.pageSize },
  })
  const source = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const parsed = settingHistorySchema.safeParse({
    count: source.count,
    historySettingList: source.historySettingList,
  })
  if (!parsed.success) {
    throw parseError(path, 'count, historySettingList')
  }
  const items = parsed.data.historySettingList.map((raw) => ({
    time: text(raw.formatCtime),
    operation: text(raw.optTypeName),
    ...(raw.optType === null || raw.optType === undefined ? {} : { operationType: String(raw.optType) }),
    ip: text(raw.optIp),
  }))
  return { count: parsed.data.count, items }
}

/**
 * Requests a security SMS code. `operationType` is the legacy discriminator; the password-change
 * screen passes `5` (`ChangePassword.js#getCodeClick`). No other value is used by this client.
 */
export function requestSecuritySmsCode(operationType: number): Promise<unknown> {
  return request<unknown>(SECURITY_ENDPOINTS.smsValidCode, { body: { operationType } })
}

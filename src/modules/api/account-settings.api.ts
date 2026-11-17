import { z } from 'zod'
import { ApiError } from '@/core/errors'
import { request } from './http'

/**
 * Account binding (email / phone) and API-key endpoints.
 *
 * Sources — every path, field name and value below was recovered from the exact legacy call sites
 * and confirmed against the current `exchange-web-api` controllers. Nothing here is guessed:
 * - `app/view/src/components/BlockChain-ui-privatization/PC/vuex/url.js` (paths, `common.*`)
 * - `app/view/src/components/BlockChain-ui-privatization/PC/vuex/personal.js` (actions/bodies)
 * - `common-mixin/personal/{BindEmail,ChangeEmail,BindPhone,ChangePhone,APImanagement,modifyApi,checkApi}`
 * - `exchange-web-api/.../api/UserCenterAct.java` (email/mobile handlers)
 * - `exchange-web-api/.../api/OpenApiAct.java` (`/openapi/*`)
 * - `exchange-web-api/.../api/ValidCodeAct.java` (`v4/common/{sms,email}ValidCode`)
 * - `exchange-common/.../enums/SmsOperateTypeEnum.java`, `EmailOperateTypeEnum`
 *
 * Signing: none of these calls is signed. The legacy client set `signParams: true` only for
 * `user/password_update` and `user/google_verify` (`vuex/personal.js`); every call in this file was
 * a plain `params` body. `request()` therefore sends the exact JSON body with no envelope.
 *
 * Contract status: legacy-source-confirmed and live-unverified. No request was sent to a real
 * server while building or testing this module.
 *
 * Deliberately absent: `openapi/open_api_one`. The legacy "view key" screen re-fetched and rendered
 * the stored `secretKey` (`checkApi.js#openApiOne`). This module never re-fetches or reveals a
 * previously stored secret; only a freshly created secret is surfaced, once, in memory.
 */
export const ACCOUNT_ENDPOINTS = {
  /** `common.bind_email` — bind an email (v4: the server requires only `email` + `emailValidCode`). */
  emailBindSave: 'user/email_bind_save_v4',
  /** `common.email_update` — change the bound email. */
  emailUpdate: 'user/email_update',
  /** `common.email_code` — email verification code (`v4/common/emailValidCode`). */
  emailValidCode: 'v4/common/emailValidCode',
  /** `common.mobile_bind_save` — bind a phone number. */
  mobileBindSave: 'user/mobile_bind_save',
  /** `common.mobile_update` — change the bound phone number. */
  mobileUpdate: 'user/mobile_update',
  /** `common.sms_code` — SMS verification code (`v4/common/smsValidCode`). */
  smsValidCode: 'v4/common/smsValidCode',
  /** `common.my_api_list` — API-key list. */
  myApiList: 'openapi/my_api_list',
  /** `common.create_open_api` — create an API key. */
  createOpenApi: 'openapi/create_open_api',
  /** `common.update_open_api` — edit an API key. */
  updateOpenApi: 'openapi/update_open_api',
  /** `common.delete_open_api` — delete an API key. */
  deleteOpenApi: 'openapi/delete_open_api',
} as const

/**
 * `SmsOperateTypeEnum` values used by the binding/API-key screens (server enum, confirmed).
 * Each action mode has its own discriminator — there is no shared "union" of OTP fields.
 */
export const SMS_OPERATION = {
  /** `BindMobileNum(2)` — code for the newly bound number (`BindPhone.js`, `ChangePhone.js`). */
  bindMobile: 2,
  /** `UpdateMobileNum(3)` — code sent to the currently bound number (`ChangePhone.js`). */
  updateMobileOld: 3,
  /** `ModifyEmail(15)` — code sent to the current phone during an email change (`ChangeEmail.js`). */
  updateEmailOld: 15,
  /** `OperateOpenApi(16)` — code for API-key create/edit (`APImanagement.js`, `modifyApi.js`). */
  openApi: 16,
} as const

/** `EmailOperateTypeEnum` values used by the email screens (server enum, confirmed). */
export const EMAIL_OPERATION = {
  /** `BindEmail(2)` — also used for the *new* address during an email change (`ChangeEmail.js`). */
  bindEmail: 2,
  /** `ModifyEmail(15)` — code sent to the currently bound address (`ChangeEmail.js`). */
  updateEmailOld: 15,
} as const

// ---------------------------------------------------------------------------------------------
// Verification codes
// ---------------------------------------------------------------------------------------------

export interface EmailCodeInput {
  /** Target address. Omitted for a code to the account's current email (`email_update` old code). */
  email?: string
  operationType: number
}

/** `v4/common/emailValidCode` — body `{ email?, operationType }`. */
export function sendEmailCode(input: EmailCodeInput): Promise<unknown> {
  const body: Record<string, string | number> = { operationType: input.operationType }
  if (input.email !== undefined && input.email.trim() !== '') {
    body.email = input.email.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.emailValidCode, { body })
}

export interface SmsCodeInput {
  /** Target number. Omitted when the server resolves the bound number from the session. */
  mobile?: string
  countryCode?: string
  operationType: number
}

/** `v4/common/smsValidCode` — body `{ mobile?, countryCode?, operationType }`. */
export function sendSmsCode(input: SmsCodeInput): Promise<unknown> {
  const body: Record<string, string | number> = { operationType: input.operationType }
  if (input.mobile !== undefined && input.mobile.trim() !== '') {
    body.mobile = input.mobile.trim()
  }
  if (input.countryCode !== undefined && input.countryCode.trim() !== '') {
    body.countryCode = input.countryCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.smsValidCode, { body })
}

// ---------------------------------------------------------------------------------------------
// Email binding / rebinding
// ---------------------------------------------------------------------------------------------

export interface EmailBindInput {
  email: string
  emailValidCode: string
}

/**
 * `user/email_bind_save_v4`. The server requires only `email` + `emailValidCode` and rejects the
 * call when an email is already bound (`UserCenterAct.emailBindSaveV4`). The v1 handler also
 * required Google/SMS codes; v4 does not, so this client does not invent them.
 */
export function bindEmail(input: EmailBindInput): Promise<unknown> {
  return request<unknown>(ACCOUNT_ENDPOINTS.emailBindSave, {
    body: { email: input.email.trim(), emailValidCode: input.emailValidCode.trim() },
  })
}

export interface EmailUpdateInput {
  /** Code sent to the **current** address. */
  emailOldValidCode: string
  /** The new address. */
  email: string
  /** Code sent to the **new** address. */
  emailNewValidCode: string
  /** Required by the server when mobile verification is enabled. */
  smsValidCode?: string
  /** Required by the server when Google verification is enabled. */
  googleCode?: string
}

/**
 * `user/email_update`. `UserCenterAct.emailUpdate` requires `emailOldValidCode`, `email`,
 * `emailNewValidCode` and at least one of `smsValidCode`/`googleCode`, then enforces Google when
 * enabled, SMS when enabled, and rejects the call when both are disabled.
 */
export function updateEmail(input: EmailUpdateInput): Promise<unknown> {
  const body: Record<string, string> = {
    emailOldValidCode: input.emailOldValidCode.trim(),
    email: input.email.trim(),
    emailNewValidCode: input.emailNewValidCode.trim(),
  }
  if (input.smsValidCode !== undefined && input.smsValidCode.trim() !== '') {
    body.smsValidCode = input.smsValidCode.trim()
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.emailUpdate, { body })
}

// ---------------------------------------------------------------------------------------------
// Phone binding / rebinding
// ---------------------------------------------------------------------------------------------

export interface MobileBindInput {
  countryCode: string
  mobileNumber: string
  smsAuthCode: string
  /** Required by the server when Google verification is enabled. */
  googleCode?: string
}

/**
 * `user/mobile_bind_save`. `UserCenterAct.mobileBindSave` requires `countryCode`, `smsAuthCode` and
 * `mobileNumber`, and Google code when Google verification is enabled.
 */
export function bindMobile(input: MobileBindInput): Promise<unknown> {
  const body: Record<string, string> = {
    countryCode: input.countryCode.trim(),
    mobileNumber: input.mobileNumber.trim(),
    smsAuthCode: input.smsAuthCode.trim(),
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.mobileBindSave, { body })
}

export interface MobileUpdateInput {
  countryCode: string
  mobileNumber: string
  /** Code sent to the **new** number. */
  smsAuthCode: string
  /** Code sent to the **current** number (`ChangePhone.js` `authenticationCode`). */
  authenticationCode: string
  /** Required by the server when Google verification is enabled. */
  googleCode?: string
}

/**
 * `user/mobile_update`. `UserCenterAct.mobileUpdate` requires `countryCode`, `mobileNumber`,
 * `smsAuthCode`, `authenticationCode`, and Google code when Google verification is enabled.
 */
export function updateMobile(input: MobileUpdateInput): Promise<unknown> {
  const body: Record<string, string> = {
    countryCode: input.countryCode.trim(),
    mobileNumber: input.mobileNumber.trim(),
    smsAuthCode: input.smsAuthCode.trim(),
    authenticationCode: input.authenticationCode.trim(),
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.mobileUpdate, { body })
}

// ---------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------

export interface ApiKeySummary {
  /** Public API key id (`token`). Never the secret. */
  token: string
  label: string
  /** `believeIps` — comma-separated allowlist; empty means unrestricted. */
  ips: string
  /** Optional write permissions (`authority`, comma list); reads and spot trading need none. */
  permissions: ApiKeyPermissions
}

/** API-key write permissions (`open_api_token.authority`): `earn` and/or `loan`, Binance-style switches. */
export interface ApiKeyPermissions {
  earn: boolean
  loan: boolean
}

/** `authority` text → permissions. Unknown tokens are ignored; an old server omits the field (none). */
export function parseAuthority(raw: unknown): ApiKeyPermissions {
  const parts = typeof raw === 'string' ? raw.split(',').map((part) => part.trim().toLowerCase()) : []
  return { earn: parts.includes('earn'), loan: parts.includes('loan') }
}

/** Permissions → the `authority` body field (`''` = none). */
export function formatAuthority(permissions: ApiKeyPermissions): string {
  const parts: string[] = []
  if (permissions.earn) parts.push('earn')
  if (permissions.loan) parts.push('loan')
  return parts.join(',')
}

export interface ApiKeyPage {
  count: number
  items: ApiKeySummary[]
}

export interface ApiKeyQuery {
  page: number
  pageSize: number
}

export interface CreatedApiKey {
  /** Secret key returned once at creation. Kept in memory only, never persisted. */
  secretKey: string
  token: string
  /** Server-rendered QR (`data:image/png;base64,…`) encoding `{ token, secretKey }`. */
  qrCode: string
}

function parseError(path: string, fields: string): ApiError {
  return new ApiError({
    kind: 'parse',
    code: '',
    path,
    // Only field paths are included; never response values, tokens or secrets.
    message: `API contract mismatch: ${path} [${fields}]`,
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const countSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])

const apiKeyItemSchema = z
  .object({
    token: z.union([z.string(), z.number()]).nullish(),
    believeIps: z.string().nullish(),
    label: z.string().nullish(),
    authority: z.string().nullish(),
  })
  .passthrough()

/**
 * `my_api_list` returns `{ count, apiList[] }` (`OpenApiAct.myApiList`). Both keys are required so a
 * `{}` envelope can never be mistaken for a successful empty page. An account without keys gets
 * `apiList: null` with `count: 0` (live 2026-09-27); `null` is accepted only together with count 0.
 */
const apiKeyListSchema = z
  .object({
    count: countSchema,
    apiList: z.array(apiKeyItemSchema).nullable(),
  })
  .passthrough()
  .refine((value) => value.apiList !== null || value.count === 0)

/** `openapi/my_api_list` — body `{ page, pageSize }`. */
export async function fetchApiKeys(query: ApiKeyQuery): Promise<ApiKeyPage> {
  const path = ACCOUNT_ENDPOINTS.myApiList
  const data = await request<unknown>(path, { body: { page: query.page, pageSize: query.pageSize } })
  const source = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const parsed = apiKeyListSchema.safeParse({ count: source.count, apiList: source.apiList })
  if (!parsed.success) {
    throw parseError(path, 'count, apiList')
  }
  const items = (parsed.data.apiList ?? []).map((raw) => ({
    token: raw.token === undefined || raw.token === null ? '' : String(raw.token),
    label: text(raw.label),
    ips: text(raw.believeIps),
    permissions: parseAuthority(raw.authority),
  }))
  return { count: parsed.data.count, items }
}

export interface CreateApiKeyInput {
  /** `believeIps` — already normalised; empty string means unrestricted. */
  believeIps: string
  label: string
  /** Write permissions sent as `authority` (an old server ignores the field). */
  permissions: ApiKeyPermissions
  /** Required by the server when mobile verification is enabled. */
  smsValidCode?: string
  /** Required by the server when Google verification is enabled. */
  googleCode?: string
}

const createdApiKeySchema = z
  .object({
    secretKey: z.string().min(1),
    token: z.string().min(1),
    qrCode: z.string().nullish(),
  })
  .passthrough()

/**
 * `openapi/create_open_api`. The server enforces Google when enabled, SMS when enabled, and a
 * maximum of five keys. `authority` (2026-10-16) carries the optional `earn` / `loan` write
 * permissions checked by the earn service for API-key callers.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const path = ACCOUNT_ENDPOINTS.createOpenApi
  const body: Record<string, string> = {
    believeIps: input.believeIps,
    label: input.label.trim(),
    authority: formatAuthority(input.permissions),
  }
  if (input.smsValidCode !== undefined && input.smsValidCode.trim() !== '') {
    body.smsValidCode = input.smsValidCode.trim()
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  const data = await request<unknown>(path, { body })
  const parsed = createdApiKeySchema.safeParse(data)
  if (!parsed.success) {
    throw parseError(path, 'secretKey, token, qrCode')
  }
  return {
    secretKey: parsed.data.secretKey,
    token: parsed.data.token,
    qrCode: text(parsed.data.qrCode),
  }
}

export interface UpdateApiKeyInput {
  token: string
  believeIps: string
  label: string
  permissions: ApiKeyPermissions
  smsValidCode?: string
  googleCode?: string
}

/** `openapi/update_open_api` — body `{ token, believeIps, label, authority, smsValidCode?, googleCode? }`. */
export function updateApiKey(input: UpdateApiKeyInput): Promise<unknown> {
  const body: Record<string, string> = {
    token: input.token,
    believeIps: input.believeIps,
    label: input.label.trim(),
    authority: formatAuthority(input.permissions),
  }
  if (input.smsValidCode !== undefined && input.smsValidCode.trim() !== '') {
    body.smsValidCode = input.smsValidCode.trim()
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.updateOpenApi, { body })
}

export interface DeleteApiKeyInput {
  token: string
  smsValidCode?: string
  googleCode?: string
}

/**
 * `openapi/delete_open_api` — body `{ token, smsValidCode?, googleCode? }`. Since 2026-10-16 the
 * server requires the same bound second factors as create/update (the vendor required none; an
 * older server simply ignores the code fields).
 */
export function deleteApiKey(input: DeleteApiKeyInput): Promise<unknown> {
  const body: Record<string, string> = { token: input.token }
  if (input.smsValidCode !== undefined && input.smsValidCode.trim() !== '') {
    body.smsValidCode = input.smsValidCode.trim()
  }
  if (input.googleCode !== undefined && input.googleCode.trim() !== '') {
    body.googleCode = input.googleCode.trim()
  }
  return request<unknown>(ACCOUNT_ENDPOINTS.deleteOpenApi, { body })
}

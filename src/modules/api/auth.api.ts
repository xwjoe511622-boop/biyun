import { ENDPOINTS } from '@/config/endpoints'
import { request } from './http'
import type { LoginStepOneData, LoginStepTwoData, UserInfoData } from './types'

/**
 * Login step 1. The body is wrapped in the RSA/AES envelope by the http layer (`signed: true`).
 *
 * Plaintext fields (source-confirmed, `LoginAct.loginOne`):
 * - `mobileNumber`: phone number **or email** (email detection is `contains("@")`).
 * - `loginPword`: password.
 * - `countryCode`: optional dial code.
 * - `verificationType` + slider fields (`csessionid` / `sig` / `token` / `scene`, or the
 *   `geetest_*` triplet). The server rejects the request when the slider check is enabled and
 *   the fields are missing — this client reports that real error instead of faking success.
 */
export interface LoginPlaintext {
  mobileNumber: string
  loginPword: string
  countryCode?: string
  verificationType?: string
  csessionid?: string
  sig?: string
  token?: string
  scene?: string
  geetest_challenge?: string
  geetest_validate?: string
  geetest_seccode?: string
  type?: string
}

export function loginStepOne(plaintext: LoginPlaintext): Promise<LoginStepOneData> {
  return request<LoginStepOneData>(ENDPOINTS.login, { body: plaintext, signed: true, anonymous: true })
}

export interface ConfirmLoginPlaintext {
  /** Temporary token of an older server; omitted in cookie mode (the server reads `__Host-lb_pending`). */
  token?: string
  /** Google / SMS / email verification code; absent for type `0`. */
  authCode?: string
  /**
   * `1` Google, `2` SMS, `3` email; `0` (10-19 email-code switch off, email account without Google) = no second
   * factor: the server signs the account in gated until Google is bound.
   */
  type: string
}

export function loginStepTwo(plaintext: ConfirmLoginPlaintext): Promise<LoginStepTwoData> {
  return request<LoginStepTwoData>(ENDPOINTS.confirmLogin, { body: plaintext, signed: true, anonymous: true })
}

export function logout(): Promise<unknown> {
  return request<unknown>(ENDPOINTS.logout, { body: {} })
}

export function fetchUserInfo(): Promise<UserInfoData> {
  return request<UserInfoData>(ENDPOINTS.userInfo, { body: {} })
}

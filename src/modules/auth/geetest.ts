/**
 * Geetest v3 slider adapter (register / password recovery / login).
 *
 * The protocol is *not* unrecoverable — it was recovered verbatim from the legacy PC client and the
 * current `exchange-web-api` backend:
 *
 * - `PC/components/verify/geetest.vue:175-260` — `POST common/tartCaptcha` (plain, no body), then
 *   `window.initGeetest({ product, lang, gt, challenge, offline: !success, new_captcha: true,
 *   width: '100%' }, cb)`, `captchaObj.appendTo(el)`, `onReady` / `onError` / `onSuccess`,
 *   `getValidate()` -> `{ geetest_challenge, geetest_validate, geetest_seccode }`,
 *   submitted with `verificationType: '2'`.
 * - `exchange-web-api/.../ValidCodeAct.java:978-998` — `POST common/tartCaptcha` returns
 *   `data.captcha = { gt, challenge, success, new_captcha }` (see `BaseAct#tartCaptcha` ->
 *   `StartCaptchaServlet.captch1`, which stores the challenge in the HTTP session).
 * - `BaseAct#checkAllvalidCode` (`sys_conf_validate == '2'`) -> `checkCaptchaCode`
 *   (`StartCaptchaServlet.checkCaptchaCode`) -> `gtSdk.enhencedValidateRequest(...)`, i.e. the
 *   **online** geetest validation endpoint.
 *
 * Two hard rules that follow from the sources:
 * 1. Only the exact official loader `https://static.geetest.com/static/js/gt.0.5.0.js` may be
 *    injected. Any other URL — including relative or lookalike hosts — is refused.
 * 2. A challenge with `success: 0` is geetest's *offline failback*. The backend always validates
 *    with `enhencedValidateRequest` (online), so an offline challenge can never pass; the widget
 *    must reject it instead of pretending `offline: true` made it legitimate.
 *
 * Nothing here is a fixed challenge tuple: `gt` / `challenge` always come from a live
 * `common/tartCaptcha` response and the proof comes from the widget's `getValidate()`.
 */

import type { CaptchaProof } from '@/modules/api/onboarding.api'

/** The one allowlisted official geetest v3 loader. */
export const GEETEST_SDK_URL = 'https://static.geetest.com/static/js/gt.0.5.0.js'

const GEETEST_SDK_PATTERN = /^https:\/\/static\.geetest\.com\/static\/js\/gt\.0\.5\.0\.js$/

export function isAllowedGeetestSdkUrl(url: string): boolean {
  return GEETEST_SDK_PATTERN.test(url)
}

/** `verificationType` the server compares against `sys_conf_validate`. */
export const GEETEST_VERIFICATION_TYPE = '2'

export const GEETEST_SDK_TIMEOUT_MS = 10_000

export interface GeetestValidate {
  geetest_challenge: string
  geetest_validate: string
  geetest_seccode: string
}

/**
 * Options handed to `window.initGeetest`. `offline` mirrors the legacy `!success` flag; because an
 * offline challenge is rejected before init, it is always `false` in practice.
 */
export interface GeetestInitOptions {
  gt: string
  challenge: string
  offline: boolean
  new_captcha: boolean
  product: 'popup' | 'float' | 'custom' | 'bind'
  width: string
  lang: string
}

export interface GeetestInstance {
  appendTo(element: HTMLElement | string): void
  onReady(callback: () => void): void
  onSuccess(callback: () => void): void
  onError(callback: (error?: unknown) => void): void
  getValidate(): GeetestValidate
  destroy?(): void
  reset?(): void
}

export type GeetestInit = (options: GeetestInitOptions, callback: (instance: GeetestInstance) => void) => void

/** Reads the SDK global the legacy page used (`window.initGeetest`). */
export function geetestInit(): GeetestInit | null {
  if (typeof window === 'undefined') {
    return null
  }
  const candidate = (window as unknown as { initGeetest?: unknown }).initGeetest
  return typeof candidate === 'function' ? (candidate as GeetestInit) : null
}

/**
 * Narrows the widget's `getValidate()` result into the submitted proof. A vendor "success" with a
 * blank/incomplete tuple is refused (returns `null`) so the caller blocks instead of sending empty
 * `geetest_*` fields.
 */
export function geetestProof(value: unknown): CaptchaProof | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const challenge = nonEmpty(record.geetest_challenge)
  const validate = nonEmpty(record.geetest_validate)
  const seccode = nonEmpty(record.geetest_seccode)
  if (challenge === null || validate === null || seccode === null) {
    return null
  }
  return {
    verificationType: GEETEST_VERIFICATION_TYPE,
    geetest_challenge: challenge,
    geetest_validate: validate,
    geetest_seccode: seccode,
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  return text === '' ? null : text
}

// ---------------------------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------------------------

/** The languages the official geetest v3 loader accepts (anything else falls back to `en`). */
const GEETEST_LANGUAGES = new Set([
  'zh-cn', 'zh-hk', 'zh-tw', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'it', 'id',
  'th', 'vi',
])

const GEETEST_BASE_LANGUAGES = new Set([
  'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'it', 'id', 'th', 'vi',
])

/**
 * Maps an app locale (and optional server preference) to a geetest `lang` value. Only values from
 * the official allowlist are used; the server value is accepted only when it is already valid.
 */
export function geetestLanguage(locale: string, serverLanguage?: string | null): string {
  const server = normalize(serverLanguage)
  if (server !== null && GEETEST_LANGUAGES.has(server)) {
    return server
  }
  const normalized = normalize(locale)
  if (normalized === null) {
    return 'en'
  }
  if (normalized === 'zh-cn' || normalized === 'zh-sg' || normalized === 'zh') {
    return 'zh-cn'
  }
  if (normalized === 'zh-hk' || normalized === 'zh-mo') {
    return 'zh-hk'
  }
  if (normalized === 'zh-tw') {
    return 'zh-tw'
  }
  const base = normalized.split('-')[0] ?? normalized
  return GEETEST_BASE_LANGUAGES.has(base) ? base : 'en'
}

/** Lower-cases and normalizes `_`/`-` separators so `zh_CN` and `zh-CN` behave identically. */
function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const text = value.trim().toLowerCase().replace(/_/g, '-')
  return text === '' ? null : text
}

// ---------------------------------------------------------------------------------------------
// SDK loader
// ---------------------------------------------------------------------------------------------

let sdkPromise: Promise<GeetestInit> | null = null

function injectScript(url: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('auth.captcha.sdkUnavailable'))
      return
    }
    const script = document.createElement('script')
    script.src = url
    script.async = true
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      script.onload = null
      script.onerror = null
    }
    script.onload = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    // A CSP violation surfaces as `onerror`, exactly like a network failure.
    script.onerror = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('auth.captcha.sdkUnavailable'))
    }
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('auth.captcha.sdkTimeout'))
    }, timeoutMs)
    document.head.appendChild(script)
  })
}

function ensureSdkPromise(url: string, timeoutMs: number): Promise<GeetestInit> {
  if (sdkPromise === null) {
    sdkPromise = injectScript(url, timeoutMs)
      .then(() => {
        const init = geetestInit()
        if (init === null) {
          throw new Error('auth.captcha.sdkUnavailable')
        }
        return init
      })
      .catch((error: unknown) => {
        sdkPromise = null
        throw error
      })
  }
  return sdkPromise
}

/**
 * Loads the official geetest v3 loader. Rejects (never resolves to a stub) when the URL is not the
 * allowlisted asset, when the browser refuses/reports an error, when the global is missing after a
 * successful load, on timeout, or when the caller's `signal` aborts the wait. The resolved value is
 * the vendor `initGeetest` function only.
 */
export function loadGeetestSdk(
  url: string = GEETEST_SDK_URL,
  timeoutMs: number = GEETEST_SDK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GeetestInit> {
  if (!isAllowedGeetestSdkUrl(url)) {
    return Promise.reject(new Error('auth.captcha.sdkBlocked'))
  }
  const existing = geetestInit()
  if (existing !== null) {
    return Promise.resolve(existing)
  }
  const load = ensureSdkPromise(url, timeoutMs)
  if (signal === undefined) {
    return load
  }
  if (signal.aborted) {
    return Promise.reject(new Error('auth.captcha.cancelled'))
  }
  return new Promise<GeetestInit>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('auth.captcha.cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    load.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/** Test/teardown helper: forget the cached load promise (the vendor global is left untouched). */
export function resetGeetestSdkCache(): void {
  sdkPromise = null
}

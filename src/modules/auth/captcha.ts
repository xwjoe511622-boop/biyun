/**
 * Slider-captcha plan + the official Aliyun "NoCaptcha" (NC) PC adapter used by the register,
 * password-recovery and login forms.
 *
 * The server selects the vendor through `switch.verificationType` (`1` = Aliyun NC, `2` = Geetest).
 * Both protocols are recovered from the sources: Aliyun here and Geetest in `./geetest.ts`. The
 * plan below decides which widget (if any) the form renders and whether a proof is required — it
 * never fabricates one, and an unknown vendor fails closed.
 *
 * The legacy PC pages also shipped a **hardcoded** Geetest tuple (`PC/views/login.vue` /
 * `Register.vue#verifyHandler`: `geetest_challenge: "43c606f5…"`, `verificationType: "2"`). That
 * fake proof is deliberately not reproduced: `gt` / `challenge` always come from a live
 * `common/tartCaptcha` response and the proof from the widget's `getValidate()`.
 *
 * Source contract for the Aliyun widget (`PC/components/verify/aliyunCaptcha.vue`):
 * - SDK: `//g.alicdn.com/sd/ncpc/nc.js?t=…` (protocol-relative in the legacy page → https today).
 * - `new window.noCaptcha()`, then `init({ renderTo, appkey, scene, token, language, callback })`.
 * - `appkey` = `publicInfo.nc.nc_appkey`, `scene` = `publicInfo.nc.nc_prefix + 'login'`,
 *   `token` = `appkey:timestamp:random`.
 * - `callback({ csessionid, sig })` is submitted together with `verificationType: '1'`, the
 *   `token` above and `scene: 'login'`; the server re-validates them (`BaseAct.checkAuthCode`).
 */

import type { CaptchaProviderKind } from './onboarding-state'

/** The one allowlisted CDN asset. Any other URL — including a relative one — is refused. */
export const ALIYUN_NC_SDK_URL = 'https://g.alicdn.com/sd/ncpc/nc.js?t=1497440454594'

const ALIYUN_NC_SDK_PATTERN = /^https:\/\/g\.alicdn\.com\/sd\/ncpc\/nc\.js(?:\?t=[0-9]+)?$/

export function isAllowedAliyunNcSdkUrl(url: string): boolean {
  return ALIYUN_NC_SDK_PATTERN.test(url)
}

export type CaptchaPlanReason =
  | 'ready'
  | 'not-required'
  | 'unconfigured'
  | 'sdk-disabled'
  | 'unsupported-provider'

export interface CaptchaPlan {
  provider: CaptchaProviderKind
  /** Widget the form must render; `none` means "no widget is available/needed". */
  widget: 'aliyun' | 'geetest' | 'none'
  /** `true` when the submit body must carry a solved, matching proof. */
  proofRequired: boolean
  /** `true` when the form must refuse to submit before issuing any request. */
  blocked: boolean
  reason: CaptchaPlanReason
}

export interface CaptchaPlanInput {
  provider: CaptchaProviderKind
  /** `publicInfo.nc.nc_appkey` (Aliyun only; Geetest obtains `gt` from `common/tartCaptcha`). */
  appkey: string | null | undefined
  /**
   * `switch.captcha_required` (`readCaptchaRequired`). When the server's total switch is off
   * (`false`) `BaseAct.checkAllvalidCode` passes without checking the vendor, so no widget/proof is
   * needed. Omit to mean "required" (fail closed).
   */
  captchaRequired?: boolean
  /**
   * Operator kill-switch (`features.loginCaptchaProvider`). While it is off no vendored SDK is
   * fetched and a configured slider blocks submission.
   */
  sdkEnabled: boolean
}

/**
 * Pure decision table.
 *
 * - `captchaRequired === false` → no widget, no proof (the server disabled the slider entirely).
 * - `geetest` + SDK enabled → render the official geetest widget (no `nc_appkey` needed).
 * - `aliyun` + appkey + SDK enabled → render the official NC widget.
 * - `aliyun` with no appkey → block; only an explicit server switch disables the proof.
 * - any configured provider with the SDK disabled, or any unknown provider → block.
 */
export function planCaptcha(input: CaptchaPlanInput): CaptchaPlan {
  const appkey = input.appkey === null || input.appkey === undefined ? '' : input.appkey.trim()

  if (input.captchaRequired === false) {
    // Server policy wins: the total `sys_conf_geetest_switch` is off, so no vendor is checked.
    return {
      provider: input.provider,
      widget: 'none',
      proofRequired: false,
      blocked: false,
      reason: 'not-required',
    }
  }

  if (input.provider === 'geetest') {
    // Geetest needs no public appkey: `common/tartCaptcha` returns a fresh `gt`/`challenge`.
    if (!input.sdkEnabled) {
      return { provider: 'geetest', widget: 'none', proofRequired: true, blocked: true, reason: 'sdk-disabled' }
    }
    return { provider: 'geetest', widget: 'geetest', proofRequired: true, blocked: false, reason: 'ready' }
  }

  if (input.provider === 'unsupported') {
    // An unknown `verificationType` has no honest proof contract: report and block.
    return {
      provider: input.provider,
      widget: 'none',
      proofRequired: true,
      blocked: true,
      reason: 'unsupported-provider',
    }
  }

  if (appkey === '') {
    return { provider: 'aliyun', widget: 'none', proofRequired: true, blocked: true, reason: 'unconfigured' }
  }

  if (!input.sdkEnabled) {
    return { provider: 'aliyun', widget: 'none', proofRequired: true, blocked: true, reason: 'sdk-disabled' }
  }

  return { provider: 'aliyun', widget: 'aliyun', proofRequired: true, blocked: false, reason: 'ready' }
}

// ---------------------------------------------------------------------------------------------
// Widget binding
// ---------------------------------------------------------------------------------------------

export interface AliyunNcCallbackPayload {
  csessionid?: string
  sig?: string
}

export interface AliyunNcInitOptions {
  renderTo: string
  appkey: string
  scene: string
  token: string
  language: string
  callback: (payload: AliyunNcCallbackPayload) => void
  error?: () => void
}

export interface AliyunNcInstance {
  init(options: AliyunNcInitOptions): void
  reset?: () => void
}

export type AliyunNcConstructor = new () => AliyunNcInstance

/** Reads the SDK global the legacy page used (`window.noCaptcha`). */
export function aliyunNcConstructor(): AliyunNcConstructor | null {
  if (typeof window === 'undefined') {
    return null
  }
  const candidate = (window as unknown as { noCaptcha?: unknown }).noCaptcha
  return typeof candidate === 'function' ? (candidate as AliyunNcConstructor) : null
}

export const NC_SDK_TIMEOUT_MS = 10_000

let sdkPromise: Promise<AliyunNcConstructor> | null = null

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

/**
 * Loads the official NC PC SDK. Rejects (never resolves to a stub) when the URL is not the
 * allowlisted asset, when the browser refuses/reports an error, or when the global is missing after
 * a successful load. The resolved value is the vendor constructor only.
 */
export async function loadAliyunNcSdk(
  url: string = ALIYUN_NC_SDK_URL,
  timeoutMs: number = NC_SDK_TIMEOUT_MS,
): Promise<AliyunNcConstructor> {
  if (!isAllowedAliyunNcSdkUrl(url)) {
    throw new Error('auth.captcha.sdkBlocked')
  }
  const existing = aliyunNcConstructor()
  if (existing !== null) {
    return existing
  }
  if (sdkPromise === null) {
    sdkPromise = injectScript(url, timeoutMs)
      .then(() => {
        const ctor = aliyunNcConstructor()
        if (ctor === null) {
          throw new Error('auth.captcha.sdkUnavailable')
        }
        return ctor
      })
      .catch((error: unknown) => {
        sdkPromise = null
        throw error
      })
  }
  return sdkPromise
}

/** Test/teardown helper: forget the cached load promise (the vendor global is left untouched). */
export function resetAliyunNcSdkCache(): void {
  sdkPromise = null
}

/**
 * The `nc_token` correlation string. The legacy page used `appkey:timestamp:random`; we insert the
 * challenge purpose so a proof is bound to the flow it was solved for, and re-initialise the widget
 * whenever the account or purpose changes.
 */
export function aliyunNcToken(appkey: string, purpose: string, now: number = Date.now()): string {
  return [appkey, purpose, now, Math.random()].join(':')
}

const ALIYUN_NC_LANGUAGES = new Set([
  'ar_SA', 'de_DE', 'es_ES', 'fr_FR', 'in_ID', 'it_IT', 'iw_HE', 'ja_JP', 'ko_KR',
  'nl_NL', 'pt_BR', 'ru_RU', 'th_TH', 'tr_TR', 'vi_VN',
])

/** Legacy `aliyunCaptcha.vue#alyLan` mapping: `zh_CN`→`cn`, `el_GR`→`tw`, `en_US`→`en`. */
export function aliyunNcLanguage(locale: string, serverLanguage?: string | null): string {
  if (serverLanguage !== undefined && serverLanguage !== null && serverLanguage.trim() !== '') {
    return serverLanguage.trim()
  }
  if (locale === 'zh_CN' || locale === 'zh-CN') {
    return 'cn'
  }
  if (locale === 'el_GR') {
    return 'tw'
  }
  if (locale === 'en_US' || locale === 'en-US') {
    return 'en'
  }
  return ALIYUN_NC_LANGUAGES.has(locale) ? locale : 'en'
}

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALIYUN_NC_SDK_URL,
  NC_SDK_TIMEOUT_MS,
  aliyunNcLanguage,
  aliyunNcToken,
  isAllowedAliyunNcSdkUrl,
  loadAliyunNcSdk,
  planCaptcha,
  resetAliyunNcSdkCache,
  type AliyunNcConstructor,
  type AliyunNcInitOptions,
} from '@/modules/auth/captcha'
import {
  GEETEST_SDK_TIMEOUT_MS,
  GEETEST_SDK_URL,
  geetestLanguage,
  geetestProof,
  isAllowedGeetestSdkUrl,
  loadGeetestSdk,
  resetGeetestSdkCache,
  type GeetestInit,
  type GeetestInitOptions,
  type GeetestInstance,
  type GeetestValidate,
} from '@/modules/auth/geetest'
import { readCaptchaRequired } from '@/modules/auth/onboarding-state'

class FakeNc {
  readonly init = vi.fn((_options: AliyunNcInitOptions): void => {})
  readonly reset = vi.fn()
}

function scriptsInDocument(): HTMLScriptElement[] {
  return [...document.head.querySelectorAll('script')]
}

function lastScript(): HTMLScriptElement {
  const scripts = scriptsInDocument()
  const script = scripts[scripts.length - 1]
  if (script === undefined) {
    throw new Error('no script was injected')
  }
  return script
}

beforeEach(() => {
  resetAliyunNcSdkCache()
  resetGeetestSdkCache()
  delete (window as unknown as { noCaptcha?: unknown }).noCaptcha
  delete (window as unknown as { initGeetest?: unknown }).initGeetest
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  resetAliyunNcSdkCache()
  resetGeetestSdkCache()
  delete (window as unknown as { noCaptcha?: unknown }).noCaptcha
  delete (window as unknown as { initGeetest?: unknown }).initGeetest
  document.head.innerHTML = ''
})

describe('slider plan', () => {
  it('renders the Aliyun widget only when the server published an appkey and the SDK is enabled', () => {
    expect(planCaptcha({ provider: 'aliyun', appkey: 'app-key', sdkEnabled: true })).toEqual({
      provider: 'aliyun',
      widget: 'aliyun',
      proofRequired: true,
      blocked: false,
      reason: 'ready',
    })
  })

  it('blocks a configured slider while the operator kill-switch is off', () => {
    expect(planCaptcha({ provider: 'aliyun', appkey: 'app-key', sdkEnabled: false })).toEqual({
      provider: 'aliyun',
      widget: 'none',
      proofRequired: true,
      blocked: true,
      reason: 'sdk-disabled',
    })
  })

  it('fails closed when appkey is missing and the server did not disable captcha', () => {
    const plan = planCaptcha({ provider: 'aliyun', appkey: '  ', sdkEnabled: false })
    expect(plan).toEqual({
      provider: 'aliyun',
      widget: 'none',
      proofRequired: true,
      blocked: true,
      reason: 'unconfigured',
    })
    expect(planCaptcha({ provider: 'aliyun', appkey: '', sdkEnabled: true, captchaRequired: true }).blocked).toBe(true)
  })

  it('reports an unknown vendor as unsupported instead of faking a proof', () => {
    expect(planCaptcha({ provider: 'unsupported', appkey: 'app-key', sdkEnabled: true })).toEqual({
      provider: 'unsupported',
      widget: 'none',
      proofRequired: true,
      blocked: true,
      reason: 'unsupported-provider',
    })
  })

  it('renders the Geetest widget when the server selects it, with no Aliyun appkey needed', () => {
    // The live server publishes `verificationType: '2'` and no `nc_appkey`; the challenge comes
    // from `common/tartCaptcha`, so the appkey must not gate the widget.
    expect(planCaptcha({ provider: 'geetest', appkey: '', sdkEnabled: true })).toEqual({
      provider: 'geetest',
      widget: 'geetest',
      proofRequired: true,
      blocked: false,
      reason: 'ready',
    })
    expect(planCaptcha({ provider: 'geetest', appkey: undefined, sdkEnabled: true }).widget).toBe('geetest')
  })

  it('blocks a configured Geetest slider while the operator kill-switch is off', () => {
    expect(planCaptcha({ provider: 'geetest', appkey: '', sdkEnabled: false })).toEqual({
      provider: 'geetest',
      widget: 'none',
      proofRequired: true,
      blocked: true,
      reason: 'sdk-disabled',
    })
  })

  it('never treats an unknown provider as usable', () => {
    const plan = planCaptcha({ provider: 'unsupported', appkey: 'app-key', sdkEnabled: false })
    expect(plan.widget).toBe('none')
    expect(plan.blocked).toBe(true)
    expect(plan.proofRequired).toBe(true)
  })

  it('needs no proof when the server turned the total slider switch off', () => {
    // `switch.captcha_required === "0"` => `BaseAct.checkAllvalidCode` passes before the vendor check.
    for (const provider of ['aliyun', 'geetest', 'unsupported'] as const) {
      expect(planCaptcha({ provider, appkey: '', sdkEnabled: false, captchaRequired: false })).toEqual({
        provider,
        widget: 'none',
        proofRequired: false,
        blocked: false,
        reason: 'not-required',
      })
    }
  })

  it('keeps requiring the slider when captcha_required is absent or explicitly on', () => {
    expect(planCaptcha({ provider: 'geetest', appkey: '', sdkEnabled: false }).blocked).toBe(true)
    expect(planCaptcha({ provider: 'geetest', appkey: '', sdkEnabled: false, captchaRequired: true }).blocked).toBe(true)
  })

  it('reads `switch.captcha_required` fail-closed (only the exact server OFF value disables it)', () => {
    expect(readCaptchaRequired({ captcha_required: '0' })).toBe(false)
    expect(readCaptchaRequired({ captcha_required: '1' })).toBe(true)
    expect(readCaptchaRequired({ captcha_required: '' })).toBe(true)
    expect(readCaptchaRequired({})).toBe(true)
    expect(readCaptchaRequired(null)).toBe(true)
    expect(readCaptchaRequired(undefined)).toBe(true)
    expect(readCaptchaRequired({ captcha_required: 0 })).toBe(false)
  })
})

describe('Aliyun NC SDK loading', () => {
  it('allowlists only the official https PC asset', () => {
    expect(isAllowedAliyunNcSdkUrl(ALIYUN_NC_SDK_URL)).toBe(true)
    expect(isAllowedAliyunNcSdkUrl('https://g.alicdn.com/sd/ncpc/nc.js')).toBe(true)
    expect(isAllowedAliyunNcSdkUrl('https://g.alicdn.com/sd/nch5/index.js')).toBe(false)
    expect(isAllowedAliyunNcSdkUrl('http://g.alicdn.com/sd/ncpc/nc.js')).toBe(false)
    expect(isAllowedAliyunNcSdkUrl('//g.alicdn.com/sd/ncpc/nc.js')).toBe(false)
    expect(isAllowedAliyunNcSdkUrl('https://g.alicdn.com.evil.example/sd/ncpc/nc.js')).toBe(false)
    expect(isAllowedAliyunNcSdkUrl('https://evil.example/sd/ncpc/nc.js')).toBe(false)
    expect(isAllowedAliyunNcSdkUrl('/vendor/nc.js')).toBe(false)
  })

  it('refuses a non-allowlisted URL without injecting anything', async () => {
    await expect(loadAliyunNcSdk('https://evil.example/nc.js')).rejects.toThrow('auth.captcha.sdkBlocked')
    expect(scriptsInDocument()).toHaveLength(0)
  })

  it('resolves with the vendor constructor once the allowlisted asset loads', async () => {
    const pending = loadAliyunNcSdk()
    const script = lastScript()
    expect(script.src).toBe(ALIYUN_NC_SDK_URL)
    ;(window as unknown as { noCaptcha?: unknown }).noCaptcha = FakeNc
    script.onload?.(new Event('load'))
    await expect(pending).resolves.toBe(FakeNc as unknown as AliyunNcConstructor)
  })

  it('rejects when the browser refuses the script (CSP / network)', async () => {
    const pending = loadAliyunNcSdk()
    const script = lastScript()
    script.onerror?.(new Event('error'))
    await expect(pending).rejects.toThrow('auth.captcha.sdkUnavailable')
  })

  it('rejects when the asset loads but exposes no vendor global', async () => {
    const pending = loadAliyunNcSdk()
    const script = lastScript()
    script.onload?.(new Event('load'))
    await expect(pending).rejects.toThrow('auth.captcha.sdkUnavailable')
  })

  it('times out instead of hanging the form forever', async () => {
    vi.useFakeTimers()
    const pending = loadAliyunNcSdk()
    const assertion = expect(pending).rejects.toThrow('auth.captcha.sdkTimeout')
    vi.advanceTimersByTime(NC_SDK_TIMEOUT_MS + 1)
    await assertion
  })

  it('reuses an already-present vendor global without loading the CDN', async () => {
    ;(window as unknown as { noCaptcha?: unknown }).noCaptcha = FakeNc
    await expect(loadAliyunNcSdk()).resolves.toBe(FakeNc as unknown as AliyunNcConstructor)
    expect(scriptsInDocument()).toHaveLength(0)
  })

  it('only shares one in-flight load between concurrent callers', async () => {
    const first = loadAliyunNcSdk()
    const second = loadAliyunNcSdk()
    const script = lastScript()
    ;(window as unknown as { noCaptcha?: unknown }).noCaptcha = FakeNc
    script.onload?.(new Event('load'))
    const resolved = await Promise.all([first, second])
    expect(resolved[0]).toBe(resolved[1])
    expect(scriptsInDocument()).toHaveLength(1)
  })
})

describe('Aliyun NC helpers', () => {
  it('binds the challenge token to the flow purpose', () => {
    const token = aliyunNcToken('app-key', 'register', 1700000000000)
    expect(token.startsWith('app-key:register:1700000000000:')).toBe(true)
    expect(aliyunNcToken('app-key', 'login')).not.toBe(aliyunNcToken('app-key', 'recover'))
  })

  it('maps locales to the widget language, preferring the server value', () => {
    expect(aliyunNcLanguage('zh_CN')).toBe('cn')
    expect(aliyunNcLanguage('en_US')).toBe('en')
    expect(aliyunNcLanguage('ko_KR')).toBe('ko_KR')
    expect(aliyunNcLanguage('pt_PT')).toBe('en')
    expect(aliyunNcLanguage('zh_CN', 'tw')).toBe('tw')
  })
})

// ---------------------------------------------------------------------------------------------
// Geetest v3
// ---------------------------------------------------------------------------------------------

function fakeGeetestInstance(): GeetestInstance {
  return {
    appendTo: vi.fn(),
    onReady: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    getValidate: vi.fn((): GeetestValidate => ({ geetest_challenge: '', geetest_validate: '', geetest_seccode: '' })),
    destroy: vi.fn(),
    reset: vi.fn(),
  }
}

/** Captures the init options and instance the widget was created with. */
function makeGeetestInit(): { init: GeetestInit; calls: GeetestInitOptions[]; instance: GeetestInstance } {
  const calls: GeetestInitOptions[] = []
  const instance = fakeGeetestInstance()
  const init: GeetestInit = (options, callback) => {
    calls.push(options)
    callback(instance)
  }
  return { init, calls, instance }
}

describe('Geetest v3 SDK loading', () => {
  it('allowlists only the exact official loader', () => {
    expect(isAllowedGeetestSdkUrl(GEETEST_SDK_URL)).toBe(true)
    expect(isAllowedGeetestSdkUrl('https://static.geetest.com/static/js/gt.0.5.0.js')).toBe(true)
    expect(isAllowedGeetestSdkUrl('http://static.geetest.com/static/js/gt.0.5.0.js')).toBe(false)
    expect(isAllowedGeetestSdkUrl('//static.geetest.com/static/js/gt.0.5.0.js')).toBe(false)
    expect(isAllowedGeetestSdkUrl('https://static.geetest.com/static/js/gt.js')).toBe(false)
    expect(isAllowedGeetestSdkUrl('https://static.geetest.com/static/js/gt.0.5.0.js?v=1')).toBe(false)
    expect(isAllowedGeetestSdkUrl('https://static.geetest.com.evil.example/static/js/gt.0.5.0.js')).toBe(false)
    expect(isAllowedGeetestSdkUrl('https://evil.example/static/js/gt.0.5.0.js')).toBe(false)
    expect(isAllowedGeetestSdkUrl('/vendor/gt.0.5.0.js')).toBe(false)
  })

  it('refuses a non-allowlisted URL without injecting anything', async () => {
    await expect(loadGeetestSdk('https://evil.example/gt.js')).rejects.toThrow('auth.captcha.sdkBlocked')
    expect(scriptsInDocument()).toHaveLength(0)
  })

  it('resolves with the vendor initGeetest once the official asset loads', async () => {
    const { init } = makeGeetestInit()
    const pending = loadGeetestSdk()
    const script = lastScript()
    expect(script.src).toBe(GEETEST_SDK_URL)
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = init
    script.onload?.(new Event('load'))
    await expect(pending).resolves.toBe(init)
  })

  it('rejects when the browser refuses the script (CSP / network)', async () => {
    const pending = loadGeetestSdk()
    lastScript().onerror?.(new Event('error'))
    await expect(pending).rejects.toThrow('auth.captcha.sdkUnavailable')
  })

  it('rejects when the asset loads but exposes no initGeetest', async () => {
    const pending = loadGeetestSdk()
    lastScript().onload?.(new Event('load'))
    await expect(pending).rejects.toThrow('auth.captcha.sdkUnavailable')
  })

  it('times out instead of hanging the form forever', async () => {
    vi.useFakeTimers()
    const pending = loadGeetestSdk()
    const assertion = expect(pending).rejects.toThrow('auth.captcha.sdkTimeout')
    vi.advanceTimersByTime(GEETEST_SDK_TIMEOUT_MS + 1)
    await assertion
  })

  it('reuses an already-present initGeetest without loading the CDN', async () => {
    const { init } = makeGeetestInit()
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = init
    await expect(loadGeetestSdk()).resolves.toBe(init)
    expect(scriptsInDocument()).toHaveLength(0)
  })

  it('rejects with a cancellation key when the caller aborts the wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = loadGeetestSdk(GEETEST_SDK_URL, GEETEST_SDK_TIMEOUT_MS, controller.signal)
    const assertion = expect(pending).rejects.toThrow('auth.captcha.cancelled')
    controller.abort()
    await assertion
  })

  it('refuses an already-aborted signal without resolving the loader', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadGeetestSdk(GEETEST_SDK_URL, GEETEST_SDK_TIMEOUT_MS, controller.signal)).rejects.toThrow(
      'auth.captcha.cancelled',
    )
  })

  it('only shares one in-flight load between concurrent callers', async () => {
    const { init } = makeGeetestInit()
    const first = loadGeetestSdk()
    const second = loadGeetestSdk()
    const script = lastScript()
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = init
    script.onload?.(new Event('load'))
    const resolved = await Promise.all([first, second])
    expect(resolved[0]).toBe(resolved[1])
    expect(scriptsInDocument()).toHaveLength(1)
  })
})

describe('Geetest v3 helpers', () => {
  it('maps app locales to the loader language and honours a valid server value', () => {
    expect(geetestLanguage('zh_CN')).toBe('zh-cn')
    expect(geetestLanguage('zh_TW')).toBe('zh-tw')
    expect(geetestLanguage('en_US')).toBe('en')
    expect(geetestLanguage('ko_KR')).toBe('ko')
    expect(geetestLanguage('pt_PT')).toBe('pt')
    // Greek has no geetest locale: fall back to the loader default rather than guessing.
    expect(geetestLanguage('el_GR')).toBe('en')
    expect(geetestLanguage('', 'zh-tw')).toBe('zh-tw')
    // An unrecognised server value must not be forwarded verbatim to the vendor loader.
    expect(geetestLanguage('en_US', 'xx_YY')).toBe('en')
    expect(geetestLanguage('')).toBe('en')
  })

  it('narrows getValidate() into a v3 proof and refuses incomplete/forged tuples', () => {
    expect(
      geetestProof({ geetest_challenge: ' gc ', geetest_validate: 'gv', geetest_seccode: 'gs' }),
    ).toEqual({ verificationType: '2', geetest_challenge: 'gc', geetest_validate: 'gv', geetest_seccode: 'gs' })
    expect(geetestProof({ geetest_challenge: 'gc', geetest_validate: '', geetest_seccode: 'gs' })).toBeNull()
    expect(geetestProof({ geetest_challenge: 'gc', geetest_validate: 'gv' })).toBeNull()
    expect(geetestProof({})).toBeNull()
    expect(geetestProof(undefined)).toBeNull()
    expect(geetestProof('geetest_challenge')).toBeNull()
  })
})

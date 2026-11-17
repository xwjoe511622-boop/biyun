// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App, type VNode } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import RegisterView from '@/views/RegisterView.vue'
import RecoverPasswordView from '@/views/RecoverPasswordView.vue'
import LoginView from '@/views/LoginView.vue'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { setFeatureFlag } from '@/core/feature-flags'
import { resetAliyunNcSdkCache, type AliyunNcInitOptions } from '@/modules/auth/captcha'
import {
  resetGeetestSdkCache,
  type GeetestInit,
  type GeetestInitOptions,
  type GeetestInstance,
  type GeetestValidate,
} from '@/modules/auth/geetest'
import * as onboardingApi from '@/modules/api/onboarding.api'
import * as authApi from '@/modules/api/auth.api'
import { useMarketStore } from '@/stores/market'
import type { PublicInfoV4 } from '@/modules/api/types'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'
import registerSource from '@/views/RegisterView.vue?raw'
import recoverSource from '@/views/RecoverPasswordView.vue?raw'

// Synthetic only: no request reaches a real server and no real Aliyun script is fetched.
vi.mock('@/modules/api/onboarding.api', () => ({
  ONBOARDING_ENDPOINTS: {},
  SMS_OPERATION: {},
  EMAIL_OPERATION: {},
  startTartCaptcha: vi.fn(),
  readGeetestChallenge: vi.fn(),
  registerEmailCheckInfo: vi.fn(),
  registerMobileCheckInfo: vi.fn(),
  registerEmailConfirm: vi.fn(),
  registerMobileConfirm: vi.fn(),
  sendRegisterEmailCode: vi.fn(),
  sendRegisterSmsCode: vi.fn(),
  resetPasswordStepOne: vi.fn(),
  resetPasswordStepTwo: vi.fn(),
  resetPasswordStepThree: vi.fn(),
  sendRecoveryEmailCode: vi.fn(),
  sendRecoverySmsCode: vi.fn(),
  sendLoginSmsCode: vi.fn(),
  sendLoginEmailCode: vi.fn(),
  sendLoginCode: vi.fn(),
}))

vi.mock('@/modules/api/auth.api', () => ({
  fetchUserInfo: vi.fn(),
  logout: vi.fn(),
  loginStepOne: vi.fn(),
  loginStepTwo: vi.fn(),
}))

const APPKEY = 'FFFF0N000000000066A8'

/** A vendor stub that reports a successful solve synchronously — never a fixture proof value. */
class SolvedNc {
  init(options: AliyunNcInitOptions): void {
    options.callback({ csessionid: 'cs-solved', sig: 'sig-solved' })
  }

  reset(): void {}
}

/** A vendor stub whose widget fails to initialise (CSP/load failure equivalent). */
class BrokenNc {
  init(): void {
    throw new Error('widget unavailable')
  }

  reset(): void {}
}

function installVendor(ctor: unknown): void {
  ;(window as unknown as { noCaptcha?: unknown }).noCaptcha = ctor
}

/** A Geetest v3 stub: appends, reports ready, and immediately reports a solved tuple. */
function geetestInstance(validate: GeetestValidate | null): GeetestInstance {
  return {
    appendTo: vi.fn(),
    onReady: vi.fn((callback: () => void) => callback()),
    onError: vi.fn(),
    onSuccess: vi.fn((callback: () => void) => callback()),
    getValidate: vi.fn((): GeetestValidate => validate as GeetestValidate),
    destroy: vi.fn(),
    reset: vi.fn(),
  }
}

const SOLVED_GEETEST: GeetestValidate = {
  geetest_challenge: 'gc-solved',
  geetest_validate: 'gv-solved',
  geetest_seccode: 'gs-solved',
}

/** Installs a `window.initGeetest` stub; `instances` collects every widget the form created. */
function installGeetest(make: () => GeetestInstance = () => geetestInstance(SOLVED_GEETEST)): GeetestInstance[] {
  const instances: GeetestInstance[] = []
  const init: GeetestInit = (_options: GeetestInitOptions, callback) => {
    const instance = make()
    instances.push(instance)
    callback(instance)
  }
  ;(window as unknown as { initGeetest?: unknown }).initGeetest = init
  return instances
}

function publicInfo(overrides: {
  loginRegistType?: string
  verificationType?: string
  appkey?: string
  inviteRequired?: string
  captchaRequired?: string
}): PublicInfoV4 {
  return {
    nc: { nc_appkey: overrides.appkey ?? APPKEY, nc_prefix: 'prefix-', nc_lang: 'en' },
    switch: {
      login_regist_type: overrides.loginRegistType ?? '1',
      verificationType: overrides.verificationType ?? '1',
      is_invitationCode_required: overrides.inviteRequired ?? '0',
      captcha_required: overrides.captchaRequired ?? '1',
    },
    url: {},
  } as unknown as PublicInfoV4
}

let pinia: Pinia
let host: HTMLDivElement
let apps: App[] = []
function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } })
}
let i18n: ReturnType<typeof createTestI18n>
let router: Router

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  resetAliyunNcSdkCache()
  resetGeetestSdkCache()
  delete (window as unknown as { noCaptcha?: unknown }).noCaptcha
  delete (window as unknown as { initGeetest?: unknown }).initGeetest
  setFeatureFlag('loginCaptchaProvider', false)

  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  apps = []
  i18n = createTestI18n()
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/trade', component: { template: '<div />' } },
      { path: '/register', component: { template: '<div />' } },
      { path: '/recover-password', component: { template: '<div />' } },
    ],
  })

  vi.mocked(authApi.fetchUserInfo).mockResolvedValue({})
  vi.mocked(onboardingApi.sendRegisterEmailCode).mockResolvedValue({})
  vi.mocked(onboardingApi.sendRegisterSmsCode).mockResolvedValue({})
  vi.mocked(onboardingApi.sendRecoveryEmailCode).mockResolvedValue({})
  vi.mocked(onboardingApi.sendRecoverySmsCode).mockResolvedValue({})
  vi.mocked(onboardingApi.sendLoginCode).mockResolvedValue({})
  vi.mocked(onboardingApi.startTartCaptcha).mockResolvedValue({
    gt: 'gt-1',
    challenge: 'challenge-1',
    success: true,
    newCaptcha: true,
  })
})

afterEach(() => {
  apps.forEach((app) => app.unmount())
  disposePinia(pinia)
  session.clear()
  vi.restoreAllMocks()
  setFeatureFlag('loginCaptchaProvider', false)
  resetAliyunNcSdkCache()
  resetGeetestSdkCache()
  delete (window as unknown as { noCaptcha?: unknown }).noCaptcha
  delete (window as unknown as { initGeetest?: unknown }).initGeetest
  document.body.innerHTML = ''
})

async function mount(render: () => VNode): Promise<void> {
  const Root = defineComponent({ setup: () => render })
  const app = createApp(Root)
  app.use(pinia)
  app.use(i18n)
  app.use(router)
  app.mount(host)
  apps.push(app)
  await router.isReady()
  await flush()
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function setPublicInfo(info: PublicInfoV4): void {
  const market = useMarketStore()
  market.publicInfo = info
}

function setInput(id: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)
  if (input === null) {
    throw new Error(`missing input #${id} in: ${host.textContent ?? ''}`)
  }
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
  if (found === undefined) {
    throw new Error(`missing button "${text}" in: ${host.textContent ?? ''}`)
  }
  return found
}

async function expectNoticeInBothLanguages(kind: 'info' | 'error', english: string, chinese: string): Promise<void> {
  const notice = () => host.querySelector(`.notice-${kind}`)?.textContent?.trim()
  expect(notice()).toBe(english)
  i18n.global.locale.value = 'zh-CN'
  await nextTick()
  expect(notice()).toBe(chinese)
  i18n.global.locale.value = 'en-US'
  await nextTick()
  expect(notice()).toBe(english)
}

function queryInput(id: string): HTMLInputElement | null {
  return host.querySelector<HTMLInputElement>(`#${id}`)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function registerToVerifyStep(): Promise<void> {
  vi.mocked(onboardingApi.registerEmailCheckInfo).mockResolvedValue('reg-token')
  await mount(() => h(RegisterView))
  setInput('register-email', 'new@example.com')
  setInput('register-password', 'Passw0rd1')
  setInput('register-confirm', 'Passw0rd1')
  // The slider is bound to the account, so give the watcher a tick to re-issue the challenge.
  await flush()
  buttonByText('Next').click()
  await flush()
}

describe('RegisterView', () => {
  it('updates the visible email validation when the language changes', async () => {
    setPublicInfo(publicInfo({}))
    await mount(() => h(RegisterView))
    buttonByText('Next').click()
    await flush()
    await expectNoticeInBothLanguages('error', 'Enter a valid email address.', '请输入有效的邮箱地址。')
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
  })

  it('blocks missing Aliyun configuration unless the server explicitly disables captcha', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    setPublicInfo(publicInfo({ appkey: '' }))
    await mount(() => h(RegisterView))
    setInput('register-email', 'new@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
    expect(host.textContent).toContain('not configured correctly')
  })

  it('hides the phone tab when the server only allows email registration', async () => {
    setPublicInfo(publicInfo({ loginRegistType: '3', appkey: '' }))
    await mount(() => h(RegisterView))
    expect(queryInput('register-email')).not.toBeNull()
    expect(queryInput('register-phone')).toBeNull()
    expect(buttonByText('Next')).toBeTruthy()
  })

  it('blocks step one with a configured slider while the vendor widget is disabled', async () => {
    setPublicInfo(publicInfo({}))
    await mount(() => h(RegisterView))
    setInput('register-email', 'new@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
    expect(host.textContent).toContain('blocked')
  })

  it('blocks step one when the widget itself fails to initialise', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(BrokenNc)
    setPublicInfo(publicInfo({}))
    await mount(() => h(RegisterView))
    setInput('register-email', 'new@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
  })

  it('submits the signed registration info with the solved slider proof and auto-sends the code', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    await registerToVerifyStep()

    expect(onboardingApi.registerEmailCheckInfo).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      invitedCode: '',
      captcha: {
        verificationType: '1',
        csessionid: 'cs-solved',
        sig: 'sig-solved',
        token: expect.stringMatching(/^FFFF0N000000000066A8:register:/),
        scene: 'login',
      },
      signal: expect.any(AbortSignal),
    })
    expect(onboardingApi.sendRegisterEmailCode).toHaveBeenCalledWith(
      'reg-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(queryInput('register-code')).not.toBeNull()
    await expectNoticeInBothLanguages('info', 'Code sent to n**@example.com', '验证码已发送至 n**@example.com')
    // The registration password is dropped as soon as the server accepted it.
    expect(queryInput('register-password')).toBeNull()
  })

  it('does not auto-submit the final confirm when the code has six digits', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.registerEmailConfirm).mockResolvedValue({ autoLoginToken: null, cookieSession: false })
    await registerToVerifyStep()

    setInput('register-code', '123456')
    await flush()
    expect(onboardingApi.registerEmailConfirm).not.toHaveBeenCalled()

    buttonByText('Create account').click()
    await flush()
    expect(onboardingApi.registerEmailConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'reg-token', emailCode: '123456', signal: expect.any(AbortSignal) }),
    )
  })

  it('invalidates a solved slider when the account changes', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.registerEmailCheckInfo).mockResolvedValue('reg-token')
    await mount(() => h(RegisterView))
    setInput('register-email', 'first@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()

    // The proof was solved for `first@…`; switching the account before the challenge is re-issued
    // must not let it be reused.
    setInput('register-email', 'second@example.com')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()

    // After the widget re-issues a challenge for the new account the submit goes through.
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'second@example.com' }),
    )
  })

  it('lets the user resend the code after a failed send', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.sendRegisterEmailCode).mockRejectedValueOnce(
      new ApiError({ kind: 'network', code: '', message: 'network down' }),
    )
    await registerToVerifyStep()
    expect(onboardingApi.sendRegisterEmailCode).toHaveBeenCalledTimes(1)

    buttonByText('Send code').click()
    await flush()
    expect(onboardingApi.sendRegisterEmailCode).toHaveBeenCalledTimes(2)
  })

  it('keeps the user on the form and shows the server error for a malformed step-one response', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.registerEmailCheckInfo).mockRejectedValue(
      new ApiError({ kind: 'parse', code: '', message: 'auth.error.malformed' }),
    )
    await mount(() => h(RegisterView))
    setInput('register-email', 'new@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()
    buttonByText('Next').click()
    await flush()

    expect(host.textContent).toContain('malformed')
    expect(queryInput('register-code')).toBeNull()
    expect(onboardingApi.sendRegisterEmailCode).not.toHaveBeenCalled()
  })

  it('drops a step-one response that arrives after the view was left', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    const pending = deferred<string>()
    vi.mocked(onboardingApi.registerEmailCheckInfo).mockReturnValue(pending.promise)
    await mount(() => h(RegisterView))
    setInput('register-email', 'new@example.com')
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    buttonByText('Next').click()
    await flush()

    apps.forEach((app) => app.unmount())
    apps = []
    pending.resolve('reg-token')
    await flush()
    expect(onboardingApi.sendRegisterEmailCode).not.toHaveBeenCalled()
  })

  it('offers the sign-in path when the server did not auto-issue a session', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.registerEmailConfirm).mockResolvedValue({ autoLoginToken: null, cookieSession: false })
    await registerToVerifyStep()
    setInput('register-code', '123456')
    buttonByText('Create account').click()
    await flush()

    expect(host.textContent).toContain('Account created')
    expect(session.getToken()).toBeNull()
    expect(queryInput('register-code')).toBeNull()
  })

  it('never signs in on its own; the cookie session is only adopted after an explicit click', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.registerEmailConfirm).mockResolvedValue({ autoLoginToken: null, cookieSession: true })
    await registerToVerifyStep()
    setInput('register-code', '123456')
    buttonByText('Create account').click()
    await flush()

    expect(session.getToken()).toBeNull()
    buttonByText('Enter exchange').click()
    await flush()
    expect(session.getToken()).toMatch(/^c[0-9a-f]{32}$/)
    expect(router.currentRoute.value.path).toBe('/trade')
  })
})

describe('RecoverPasswordView', () => {
  async function recoverToStepTwo(challenge: { token: string; googleRequired: boolean | null; certificateRequired: boolean | null }): Promise<void> {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(onboardingApi.resetPasswordStepOne).mockResolvedValue(challenge)
    await mount(() => h(RecoverPasswordView))
    setInput('recover-email', 'u@example.com')
    await flush()
    buttonByText('Next').click()
    await flush()
  }

  it('sends step one with the slider proof and applies the server factor flags', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: true, certificateRequired: false })
    expect(onboardingApi.resetPasswordStepOne).toHaveBeenCalledWith({
      mode: 'email',
      email: 'u@example.com',
      mobileNumber: '',
      captcha: {
        verificationType: '1',
        csessionid: 'cs-solved',
        sig: 'sig-solved',
        token: expect.stringMatching(/^FFFF0N000000000066A8:recover:/),
        scene: 'login',
      },
      signal: expect.any(AbortSignal),
    })
    await expectNoticeInBothLanguages('info', 'Code sent to u*@example.com', '验证码已发送至 u*@example.com')
    expect(queryInput('recover-google')).not.toBeNull()
    expect(queryInput('recover-certificate')).toBeNull()
    expect(onboardingApi.sendRecoveryEmailCode).toHaveBeenCalledWith(
      'rec-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does not auto-submit step two when the code is complete', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: false, certificateRequired: false })
    setInput('recover-code', '123456')
    await flush()
    expect(onboardingApi.resetPasswordStepTwo).not.toHaveBeenCalled()
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.resetPasswordStepTwo).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'rec-token', mode: 'email', code: '123456' }),
    )
  })

  it('blocks step two when the server did not return the factor state', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: null, certificateRequired: null })
    setInput('recover-code', '123456')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.resetPasswordStepTwo).not.toHaveBeenCalled()
    expect(host.textContent).toContain('cannot be determined')
  })

  it('requires the certificate number when the server asks for it', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: false, certificateRequired: true })
    expect(queryInput('recover-certificate')).not.toBeNull()
    setInput('recover-code', '123456')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.resetPasswordStepTwo).not.toHaveBeenCalled()

    setInput('recover-certificate', 'ID-1234')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.resetPasswordStepTwo).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'rec-token', code: '123456', certificateNumber: 'ID-1234' }),
    )
  })

  it('restarts the flow when the recovery token expired', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: false, certificateRequired: false })
    vi.mocked(onboardingApi.resetPasswordStepTwo).mockRejectedValue(
      new ApiError({ kind: 'api', code: '10031', message: 'token expired' }),
    )
    setInput('recover-code', '123456')
    buttonByText('Next').click()
    await flush()
    await expectNoticeInBothLanguages('error', 'The verification expired. Start again.', '验证已过期，请重新开始。')
    expect(queryInput('recover-email')).not.toBeNull()
  })

  it('validates the new password and signs step three', async () => {
    await recoverToStepTwo({ token: 'rec-token', googleRequired: false, certificateRequired: false })
    vi.mocked(onboardingApi.resetPasswordStepTwo).mockResolvedValue({})
    setInput('recover-code', '123456')
    buttonByText('Next').click()
    await flush()

    setInput('recover-password', 'NewPassw0rd')
    setInput('recover-confirm', 'Mismatch123')
    buttonByText('Reset password').click()
    await flush()
    expect(onboardingApi.resetPasswordStepThree).not.toHaveBeenCalled()

    setInput('recover-confirm', 'NewPassw0rd')
    vi.mocked(onboardingApi.resetPasswordStepThree).mockResolvedValue({})
    buttonByText('Reset password').click()
    await flush()
    expect(onboardingApi.resetPasswordStepThree).toHaveBeenCalledWith({
      token: 'rec-token',
      password: 'NewPassw0rd',
      signal: expect.any(AbortSignal),
    })
    expect(host.textContent).toContain('Password reset')
  })
})

describe('LoginView', () => {
  it('blocks credential submit while a configured slider is disabled', async () => {
    setPublicInfo(publicInfo({}))
    await mount(() => h(LoginView))
    setInput('login-account', 'user@example.com')
    setInput('login-password', 'Passw0rd1')
    await flush()
    buttonByText('Sign in').click()
    await flush()
    expect(authApi.loginStepOne).not.toHaveBeenCalled()
    expect(host.textContent).toContain('blocked')
  })

  it('sends the solved slider proof in the login payload', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installVendor(SolvedNc)
    setPublicInfo(publicInfo({}))
    vi.mocked(authApi.loginStepOne).mockResolvedValue({ session: 'cookie', type: '2' })
    await mount(() => h(LoginView))
    setInput('login-account', 'user@example.com')
    setInput('login-password', 'Passw0rd1')
    await flush()
    buttonByText('Sign in').click()
    await flush()

    expect(authApi.loginStepOne).toHaveBeenCalledWith({
      mobileNumber: 'user@example.com',
      loginPword: 'Passw0rd1',
      verificationType: '1',
      csessionid: 'cs-solved',
      sig: 'sig-solved',
      token: expect.stringMatching(/^FFFF0N000000000066A8:login:/),
      scene: 'login',
    })
    // Entering the SMS challenge sends the first code; the challenge itself is the HttpOnly cookie ('' here).
    expect(onboardingApi.sendLoginCode).toHaveBeenCalledWith('2', '')
    expect(queryInput('login-code')).not.toBeNull()
    await expectNoticeInBothLanguages('info', 'Code sent to u***@example.com', '验证码已发送至 u***@example.com')
    // The password is not kept after the request settles.
    expect(queryInput('login-password')).toBeNull()
  })

  it('hides the send button for the Google factor', async () => {
    setPublicInfo(publicInfo({ appkey: '', captchaRequired: '0' }))
    vi.mocked(authApi.loginStepOne).mockResolvedValue({ session: 'cookie', type: '1' })
    await mount(() => h(LoginView))
    setInput('login-account', 'user@example.com')
    setInput('login-password', 'Passw0rd1')
    await flush()
    buttonByText('Sign in').click()
    await flush()
    expect(queryInput('login-code')).not.toBeNull()
    expect(host.querySelectorAll('button.send')).toHaveLength(0)
  })

  it('only confirms on an explicit click and validates the code first', async () => {
    setPublicInfo(publicInfo({ appkey: '', captchaRequired: '0' }))
    vi.mocked(authApi.loginStepOne).mockResolvedValue({ session: 'cookie', type: '3' })
    vi.mocked(authApi.loginStepTwo).mockResolvedValue({})
    await mount(() => h(LoginView))
    setInput('login-account', 'user@example.com')
    setInput('login-password', 'Passw0rd1')
    await flush()
    buttonByText('Sign in').click()
    await flush()

    setInput('login-code', '12')
    buttonByText('Confirm').click()
    await flush()
    expect(authApi.loginStepTwo).not.toHaveBeenCalled()
    await expectNoticeInBothLanguages('error', 'Enter the 6-digit code.', '请输入 6 位数字验证码。')

    setInput('login-code', '123456')
    await flush()
    expect(authApi.loginStepTwo).not.toHaveBeenCalled()
    buttonByText('Confirm').click()
    await flush()
    // cookie mode: no challenge token in the body, the session key is a fresh random marker (not a credential)
    expect(authApi.loginStepTwo).toHaveBeenCalledWith({ authCode: '123456', type: '3' })
    expect(session.getToken()).toMatch(/^c[0-9a-f]{32}$/)
  })
})

describe('Geetest provider (recovered protocol)', () => {
  async function fillRegister(email = 'new@example.com'): Promise<void> {
    setInput('register-email', email)
    setInput('register-password', 'Passw0rd1')
    setInput('register-confirm', 'Passw0rd1')
    await flush()
  }

  it('submits the Geetest proof with verificationType 2 for email registration', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installGeetest()
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '' }))
    vi.mocked(onboardingApi.registerEmailCheckInfo).mockResolvedValue('reg-token')
    await mount(() => h(RegisterView))
    await fillRegister()

    expect(onboardingApi.startTartCaptcha).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    buttonByText('Next').click()
    await flush()

    expect(onboardingApi.registerEmailCheckInfo).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      invitedCode: '',
      captcha: {
        verificationType: '2',
        geetest_challenge: 'gc-solved',
        geetest_validate: 'gv-solved',
        geetest_seccode: 'gs-solved',
      },
      signal: expect.any(AbortSignal),
    })
    expect(onboardingApi.sendRegisterEmailCode).toHaveBeenCalledWith(
      'reg-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('rejects an offline (success: 0) challenge instead of downgrading to a failback proof', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    const initSpy = vi.fn()
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = initSpy
    vi.mocked(onboardingApi.startTartCaptcha).mockResolvedValue({
      gt: 'gt-1',
      challenge: 'challenge-1',
      success: false,
      newCaptcha: false,
    })
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '' }))
    await mount(() => h(RegisterView))
    await fillRegister()

    // The widget must never be initialised with `offline: true`; an offline challenge cannot pass
    // the backend's online (`enhencedValidateRequest`) validation.
    expect(initSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain('unavailable')

    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
  })

  it('fails closed for an unknown provider without mounting a widget or submitting', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    const initSpy = vi.fn()
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = initSpy
    setPublicInfo(publicInfo({ verificationType: '9', appkey: '' }))
    await mount(() => h(RegisterView))
    await fillRegister()

    expect(initSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain('not supported')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
  })

  it('blocks with a concise message when common/tartCaptcha returns a malformed payload', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installGeetest()
    vi.mocked(onboardingApi.startTartCaptcha).mockRejectedValue(
      new ApiError({ kind: 'parse', code: '', message: 'auth.error.malformed' }),
    )
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '' }))
    await mount(() => h(RegisterView))
    await fillRegister()

    expect(host.textContent).toContain('not configured correctly')
    buttonByText('Next').click()
    await flush()
    expect(onboardingApi.registerEmailCheckInfo).not.toHaveBeenCalled()
  })

  it('skips the widget only when the server reports captcha_required "0"', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    const initSpy = vi.fn()
    ;(window as unknown as { initGeetest?: unknown }).initGeetest = initSpy
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '', captchaRequired: '0' }))
    vi.mocked(onboardingApi.registerEmailCheckInfo).mockResolvedValue('reg-token')
    await mount(() => h(RegisterView))
    await fillRegister()

    expect(initSpy).not.toHaveBeenCalled()
    expect(onboardingApi.startTartCaptcha).not.toHaveBeenCalled()
    buttonByText('Next').click()
    await flush()

    // The server's total switch is off, so the body carries only the vendor id and no proof.
    expect(onboardingApi.registerEmailCheckInfo).toHaveBeenCalledWith(
      expect.objectContaining({ captcha: { verificationType: '2' } }),
    )
  })

  it('destroys the Geetest widget and re-issues a challenge when the account changes', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    const instances = installGeetest()
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '' }))
    await mount(() => h(RegisterView))
    await fillRegister()
    const before = instances.length
    expect(before).toBeGreaterThanOrEqual(1)

    setInput('register-email', 'second@example.com')
    await flush()

    expect(instances.length).toBeGreaterThan(before)
    expect(instances[before - 1]?.destroy).toHaveBeenCalled()
    expect(vi.mocked(onboardingApi.startTartCaptcha).mock.calls.length).toBeGreaterThan(before)
  })

  it('submits the Geetest proof in the login payload for the Geetest provider', async () => {
    setFeatureFlag('loginCaptchaProvider', true)
    installGeetest()
    setPublicInfo(publicInfo({ verificationType: '2', appkey: '' }))
    vi.mocked(authApi.loginStepOne).mockResolvedValue({ session: 'cookie', type: '2' })
    await mount(() => h(LoginView))
    setInput('login-account', 'user@example.com')
    setInput('login-password', 'Passw0rd1')
    await flush()
    buttonByText('Sign in').click()
    await flush()

    expect(authApi.loginStepOne).toHaveBeenCalledWith({
      mobileNumber: 'user@example.com',
      loginPword: 'Passw0rd1',
      verificationType: '2',
      geetest_challenge: 'gc-solved',
      geetest_validate: 'gv-solved',
      geetest_seccode: 'gs-solved',
    })
  })
})

describe('auth form chrome (source guard)', () => {
  const views: Record<string, string> = {
    'views/RegisterView.vue': registerSource,
    'views/RecoverPasswordView.vue': recoverSource,
  }

  it('keeps the register/recover tab rows free of the shared vertical scrollbar', () => {
    // `.tabs` in `styles/base.css` sets `overflow-x: auto`; without an explicit
    // `overflow-y: hidden` the browser computes `overflow-y: auto` and draws a stray vertical
    // scrollbar on the two-tab auth rows.
    for (const file of ['views/RegisterView.vue', 'views/RecoverPasswordView.vue']) {
      const source = views[file] ?? ''
      expect(source).not.toBe('')
      expect(source).toMatch(/\.tabs\s*\{[^}]*overflow-y:\s*hidden/)
    }
  })

  it('drops the instructional register subtitle while keeping the title and validation help', () => {
    const source = views['views/RegisterView.vue'] ?? ''
    expect(source).toContain("<AuthShell :title=\"t('auth.register.title')\" wide>")
    expect(source).not.toContain('auth.register.subtitle')
    // Validation help stays: rule keys and the password/invite hints are still rendered.
    expect(source).toContain('auth.rule.password')
    expect(source).toContain('auth.register.passwordHint')
  })
})

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App, type VNode } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import PasswordChangePanel from '@/components/security/PasswordChangePanel.vue'
import TotpEnrollmentPanel from '@/components/security/TotpEnrollmentPanel.vue'
import SecurityView from '@/views/SecurityView.vue'
import { ApiError } from '@/core/errors'
import { SESSION_STORAGE_KEY, newSessionKey, session } from '@/core/session'
import * as authApi from '@/modules/api/auth.api'
import * as securityApi from '@/modules/api/security-settings.api'
import type { UserInfoData } from '@/modules/api/types'

// Synthetic only: no account read, order, password change or enrollment is sent to a server.
// API-key management has its own suite; account-security rendering must not read a live key list.
vi.mock('@/components/account/ApiKeysPanel.vue', () => ({ default: { template: '<div />' } }))

vi.mock('@/modules/api/auth.api', () => ({
  fetchUserInfo: vi.fn(),
  logout: vi.fn(),
  loginStepOne: vi.fn(),
  loginStepTwo: vi.fn(),
}))

vi.mock('@/modules/api/security-settings.api', () => ({
  SECURITY_ENDPOINTS: {},
  startTotpEnrollment: vi.fn(),
  verifyTotpEnrollment: vi.fn(),
  updatePassword: vi.fn(),
  fetchLoginHistory: vi.fn(),
  fetchSettingHistory: vi.fn(),
  requestSecuritySmsCode: vi.fn(),
}))

const SECRET = 'JBSWY3DPEHPK3PXP'

/** `authLevel` is a number in `SessionUser` and `number | string` in `UserInfoData`. */
const fullUser: UserInfoData & { authLevel?: number } = {
  id: 88,
  userAccount: '138****8888',
  nickName: 'tester',
  accountStatus: '1',
  authLevel: 1,
  googleStatus: '1',
  isOpenMobileCheck: '0',
  email: 't***@example.com',
  mobileNumber: '138****8888',
}

let pinia: Pinia
let host: HTMLDivElement
let mountedApps: App[] = []
let router: Router
function createTestI18n() { return createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: {} }) }
let i18n: ReturnType<typeof createTestI18n>

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  mountedApps = []
  i18n = createTestI18n()
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
    ],
  })

  vi.mocked(authApi.fetchUserInfo).mockResolvedValue({} as UserInfoData)
  vi.mocked(authApi.logout).mockResolvedValue({})
  vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: '' })
  vi.mocked(securityApi.verifyTotpEnrollment).mockResolvedValue({})
  vi.mocked(securityApi.updatePassword).mockResolvedValue({})
  vi.mocked(securityApi.requestSecuritySmsCode).mockResolvedValue({})
  vi.mocked(securityApi.fetchLoginHistory).mockResolvedValue({ count: 0, items: [] })
  vi.mocked(securityApi.fetchSettingHistory).mockResolvedValue({ count: 0, items: [] })
})

afterEach(() => {
  mountedApps.forEach((app) => app.unmount())
  disposePinia(pinia)
  session.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function mount(render: () => VNode, withRouter = false): Promise<void> {
  const Root = defineComponent({
    setup() {
      return render
    },
  })
  const app = createApp(Root)
  app.use(pinia)
  app.use(i18n)
  if (withRouter) {
    app.use(router)
    await router.isReady()
  }
  app.mount(host)
  mountedApps.push(app)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
  if (found === undefined) {
    throw new Error(`Missing button "${text}" in: ${host.textContent ?? ''}`)
  }
  return found
}

function inputByLabel(label: string): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (found === null) {
    throw new Error(`Missing input "${label}"`)
  }
  return found
}

async function setInput(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

/** Page text without whitespace: the revealed secret is shown in groups of four. */
function plainText(): string {
  return (host.textContent ?? '').replace(/\s+/g, '')
}

function storageWrites(): number {
  return vi.mocked(Storage.prototype.setItem).mock.calls.length
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function fillPasswordForm(options: {
  current?: string
  next?: string
  repeat?: string
  googleCode?: string
  smsCode?: string
}): Promise<void> {
  await setInput(inputByLabel('Current password'), options.current ?? 'OldPass123')
  await setInput(inputByLabel('New password'), options.next ?? 'NewPass456')
  await setInput(inputByLabel('Repeat new password'), options.repeat ?? 'NewPass456')
  if (host.querySelector('input[aria-label="Google code"]') !== null) {
    await setInput(inputByLabel('Google code'), options.googleCode ?? '123456')
  }
  if (host.querySelector('input[aria-label="SMS code"]') !== null) {
    await setInput(inputByLabel('SMS code'), options.smsCode ?? '654321')
  }
}

describe('TOTP enrollment panel', () => {
  it('never requests enrollment on mount and only does so on an explicit click', async () => {
    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    await flush()
    expect(securityApi.startTotpEnrollment).not.toHaveBeenCalled()

    buttonByText('Start enrollment').click()
    await flush()
    expect(securityApi.startTotpEnrollment).toHaveBeenCalledTimes(1)
  })

  it('masks the server secret, reveals it only on demand and clears it on close', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({
      qrImage: 'data:image/png;base64,AAAA',
      secret: SECRET,
    })

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()

    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(plainText()).not.toContain(SECRET)
    expect(host.textContent ?? '').toContain('••••')

    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(plainText()).toContain(SECRET)

    buttonByText('Close').click()
    await nextTick()
    expect(plainText()).not.toContain(SECRET)
    expect(host.querySelector('img')).toBeNull()

    expect(setItem).not.toHaveBeenCalled()
    expect(storageWrites()).toBe(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('blocks an off-origin QR but still offers the secret for manual entry', async () => {
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({
      qrImage: 'https://third-party.example/qr.png',
      secret: SECRET,
    })
    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()

    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent ?? '').toContain('blocked')
    expect(plainText()).not.toContain(SECRET)
  })

  it('clears an open secret when the session token changes or the panel unmounts', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()
    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(plainText()).toContain(SECRET)

    session.setToken('other-synthetic-session')
    await nextTick()
    expect(plainText()).not.toContain(SECRET)

    buttonByText('Start enrollment').click()
    await flush()
    const app = mountedApps.pop()
    app?.unmount()
    await nextTick()
    expect(plainText()).not.toContain(SECRET)
    // Only the (persisted) session token may be written; the TOTP secret never is.
    expect(setItem.mock.calls.filter(([key]) => key !== SESSION_STORAGE_KEY)).toEqual([])
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(SECRET)
  })

  it('abandons a late enrollment refresh after the panel is closed', async () => {
    const first = 'JBSWY3DPEHPK3PXP'
    const second = 'KRSXG5CTMVRXEZLU'
    const pending = deferred<{ qrImage: string; secret: string }>()
    vi.mocked(securityApi.startTotpEnrollment)
      .mockResolvedValueOnce({ qrImage: '', secret: first })
      .mockReturnValueOnce(pending.promise)

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()
    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(plainText()).toContain(first)

    // Refresh starts a second request while the first secret is still on screen, then the user
    // closes the panel before that request resolves.
    buttonByText('Request again').click()
    await nextTick()
    buttonByText('Close').click()
    await nextTick()
    expect(plainText()).not.toContain(first)

    pending.resolve({ qrImage: '', secret: second })
    await flush()
    expect(plainText()).not.toContain(second)
    expect(host.querySelector('input[aria-label="Login password"]')).toBeNull()
    expect(host.textContent ?? '').toContain('Start enrollment')
  })

  it('abandons a late enrollment response after the session token changes', async () => {
    const pending = deferred<{ qrImage: string; secret: string }>()
    vi.mocked(securityApi.startTotpEnrollment).mockReturnValue(pending.promise)

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await nextTick()

    session.setToken('replacement-synthetic-session')
    await nextTick()
    pending.resolve({ qrImage: '', secret: SECRET })
    await flush()

    expect(plainText()).not.toContain(SECRET)
    expect(host.querySelector('input[aria-label="Login password"]')).toBeNull()
  })

  it('never emits an enrollment result that resolves after unmount', async () => {
    const onEnrolled = vi.fn()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const pending = deferred<unknown>()
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    vi.mocked(securityApi.verifyTotpEnrollment).mockReturnValue(pending.promise)

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled', onEnrolled }))
    buttonByText('Start enrollment').click()
    await flush()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123456')
    // six digits + password auto-submit (no click needed)
    await nextTick()

    mountedApps.pop()?.unmount()
    await nextTick()
    pending.resolve({})
    await flush()
    expect(onEnrolled).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(storageWrites()).toBe(0)
  })

  it('never emits an enrollment result that resolves after the session changed', async () => {
    const onEnrolled = vi.fn()
    const pending = deferred<unknown>()
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    vi.mocked(securityApi.verifyTotpEnrollment).mockReturnValue(pending.promise)

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled', onEnrolled }))
    buttonByText('Start enrollment').click()
    await flush()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123456')
    // six digits + password auto-submit (no click needed)
    await nextTick()

    session.setToken('replacement-synthetic-session')
    await nextTick()
    pending.resolve({})
    await flush()
    expect(onEnrolled).not.toHaveBeenCalled()
  })

  it('blocks a refresh while a verification is in flight', async () => {
    const pending = deferred<unknown>()
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    vi.mocked(securityApi.verifyTotpEnrollment).mockReturnValue(pending.promise)

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123456')
    // six digits + password auto-submit (no click needed)
    await nextTick()

    const refresh = buttonByText('Request again')
    expect(refresh.disabled).toBe(true)
    refresh.click()
    await nextTick()
    expect(securityApi.startTotpEnrollment).toHaveBeenCalledTimes(1)

    pending.resolve({})
    await flush()
    expect(plainText()).not.toContain(SECRET)
  })

  it('clears the rejected OTP but keeps the secret after a failed verification without echoing values', async () => {
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    vi.mocked(securityApi.verifyTotpEnrollment).mockRejectedValue(
      new ApiError({
        kind: 'api',
        code: '1001',
        message: `invalid ${SECRET} code 123456 pwd OldPass123`,
      }),
    )

    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123456')
    // six digits + password auto-submit (no click needed)
    await flush()

    expect(inputByLabel('Authenticator code').value).toBe('')
    expect(inputByLabel('Login password').value).toBe('')

    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(plainText()).toContain(SECRET)

    const text = host.textContent ?? ''
    expect(text).not.toContain('123456')
    expect(text).not.toContain('OldPass123')
    expect(text).toContain('invalid')
  })
})

describe('TOTP enrollment UX (2026-09-27)', () => {
  async function openPanel(): Promise<void> {
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: 'data:image/png;base64,AAAA', secret: SECRET })
    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled' }))
    buttonByText('Start enrollment').click()
    await flush()
  }

  it('auto-submits once six digits are entered and strips non-digits from a pasted code', async () => {
    await openPanel()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123 45')
    expect(securityApi.verifyTotpEnrollment).not.toHaveBeenCalled()
    expect(inputByLabel('Authenticator code').value).toBe('12345')
    await setInput(inputByLabel('Authenticator code'), 'Code: 123-456')
    await flush()
    expect(securityApi.verifyTotpEnrollment).toHaveBeenCalledTimes(1)
    expect(securityApi.verifyTotpEnrollment).toHaveBeenCalledWith({ secret: SECRET, code: '123456', loginPassword: 'OldPass123' })
  })

  it('does not auto-submit without the login password, then submits when it is typed', async () => {
    await openPanel()
    await setInput(inputByLabel('Authenticator code'), '654321')
    await flush()
    expect(securityApi.verifyTotpEnrollment).not.toHaveBeenCalled()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await flush()
    expect(securityApi.verifyTotpEnrollment).toHaveBeenCalledTimes(1)
  })

  it('on a wrong code keeps the password, clears the code and shows the clock-drift hint', async () => {
    vi.mocked(securityApi.verifyTotpEnrollment).mockRejectedValue(
      new ApiError({ kind: 'api', code: '10010', message: 'Google code incorrect' }),
    )
    await openPanel()
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '111111')
    await flush()
    expect(inputByLabel('Authenticator code').value).toBe('')
    expect(inputByLabel('Login password').value).toBe('OldPass123')
    const text = host.textContent ?? ''
    expect(text).toContain('The code is incorrect or has expired.')
    expect(text).toContain('automatic date & time')
    expect(text).not.toContain('111111')
  })

  it('on a wrong password clears the password and says so', async () => {
    vi.mocked(securityApi.verifyTotpEnrollment).mockRejectedValue(
      new ApiError({ kind: 'api', code: '10050', message: 'pwd' }),
    )
    await openPanel()
    await setInput(inputByLabel('Login password'), 'WrongPass1')
    await setInput(inputByLabel('Authenticator code'), '222222')
    await flush()
    expect(inputByLabel('Login password').value).toBe('')
    expect(host.textContent ?? '').toContain('The login password is incorrect.')
  })

  it('copies the secret without revealing it and shows the backup/recovery hint', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await openPanel()
    expect(host.textContent ?? '').toContain('store it somewhere safe')
    host.querySelector<HTMLButtonElement>('button[aria-label="Copy secret"]')?.click()
    await flush()
    expect(writeText).toHaveBeenCalledWith(SECRET)
    expect(host.textContent ?? '').toContain('Secret copied')
    expect(plainText()).not.toContain(SECRET)
  })

  it('shows the revealed secret in groups of four and a success notice after enrollment', async () => {
    const onEnrolled = vi.fn()
    vi.mocked(securityApi.startTotpEnrollment).mockResolvedValue({ qrImage: '', secret: SECRET })
    await mount(() => h(TotpEnrollmentPanel, { factorState: 'disabled', onEnrolled }))
    buttonByText('Start enrollment').click()
    await flush()
    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(host.textContent ?? '').toContain('JBSW Y3DP EHPK 3PXP')
    await setInput(inputByLabel('Login password'), 'OldPass123')
    await setInput(inputByLabel('Authenticator code'), '123456')
    await flush()
    expect(onEnrolled).toHaveBeenCalledTimes(1)
    expect(host.textContent ?? '').toContain('Authenticator enabled.')
    expect(host.textContent ?? '').not.toContain('JBSW')
  })
})

describe('password change panel', () => {
  it('requires the Google factor the account has enabled and submits explicit values only', async () => {
    const onChanged = vi.fn()
    await mount(() =>
      h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled', onChanged }),
    )
    buttonByText('Change password').click()
    await nextTick()

    await setInput(inputByLabel('Current password'), 'OldPass123')
    await setInput(inputByLabel('New password'), 'NewPass456')
    await setInput(inputByLabel('Repeat new password'), 'NewPass456')
    await setInput(inputByLabel('Google code'), '12345')
    // Clickable; the click explains (10-01: no disabled button without a reason) and sends nothing.
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(securityApi.updatePassword).not.toHaveBeenCalled()

    await setInput(inputByLabel('Google code'), '123456')
    const submit = buttonByText('Confirm change')
    expect(submit.disabled).toBe(false)

    submit.click()
    await flush()
    expect(securityApi.updatePassword).toHaveBeenCalledWith({
      loginPword: 'OldPass123',
      newLoginPword: 'NewPass456',
      googleCode: '123456',
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
    // Drafts and codes are gone once the form closes.
    expect(host.querySelector('input[aria-label="Current password"]')).toBeNull()
  })

  it('stays blocked while the legacy factors are off (never weakens verification)', async () => {
    await mount(() =>
      h(PasswordChangePanel, { googleFactor: 'disabled', smsFactor: 'disabled' }),
    )
    await flush()
    expect(host.textContent ?? '').toContain('cannot be changed here')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Change password'))).toBe(false)
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
  })

  it('never auto-submits when the form opens', async () => {
    await mount(() => h(PasswordChangePanel, { googleFactor: 'disabled', smsFactor: 'enabled' }))
    buttonByText('Change password').click()
    await flush()
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
    expect(securityApi.requestSecuritySmsCode).not.toHaveBeenCalled()
  })

  it('does not duplicate the request when the form is submitted repeatedly', async () => {
    const pending = deferred<unknown>()
    vi.mocked(securityApi.updatePassword).mockReturnValue(pending.promise)
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled' }))
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})

    // Enter / a double submit bypasses the disabled button, so the guard must live in submit().
    const form = host.querySelector('form')
    expect(form).not.toBeNull()
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(securityApi.updatePassword).toHaveBeenCalledTimes(1)

    pending.resolve({})
    await flush()
  })

  it('blocks submit when a factor state is unknown instead of guessing', async () => {
    await mount(() => h(PasswordChangePanel, { googleFactor: 'unknown', smsFactor: 'enabled' }))
    await flush()
    expect(host.textContent ?? '').toContain('cannot be changed here')
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Change password')),
    ).toBe(false)
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
  })

  it('accepts an existing password that does not match the new-password policy', async () => {
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled' }))
    buttonByText('Change password').click()
    await nextTick()
    // `legacy` is a 6-character legacy credential: valid to submit, invalid as a *new* password.
    await fillPasswordForm({ current: 'legacy' })

    const submit = buttonByText('Confirm change')
    expect(submit.disabled).toBe(false)
    submit.click()
    await flush()

    expect(securityApi.updatePassword).toHaveBeenCalledWith({
      loginPword: 'legacy',
      newLoginPword: 'NewPass456',
      googleCode: '123456',
    })
  })

  it('refuses a new password that equals the current one', async () => {
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled' }))
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({ current: 'OldPass123', next: 'OldPass123', repeat: 'OldPass123' })

    expect(buttonByText('Confirm change').disabled).toBe(false)
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
    expect(host.textContent ?? '').toContain('must differ')
  })

  it('clears the OTP after a failed submit without echoing the submitted values', async () => {
    vi.mocked(securityApi.updatePassword).mockRejectedValue(
      new ApiError({ kind: 'api', code: '1001', message: 'wrong OldPass123 code 123456' }),
    )
    const onChanged = vi.fn()
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})
    buttonByText('Confirm change').click()
    await flush()

    expect(onChanged).not.toHaveBeenCalled()
    expect(inputByLabel('Google code').value).toBe('')
    const text = host.textContent ?? ''
    expect(text).not.toContain('123456')
    expect(text).not.toContain('OldPass123')
    expect(text).toContain('wrong')
  })

  it('sends a single pending SMS request and enforces the 60s cooldown', async () => {
    const pending = deferred<unknown>()
    vi.mocked(securityApi.requestSecuritySmsCode).mockReturnValue(pending.promise)
    await mount(() => h(PasswordChangePanel, { googleFactor: 'disabled', smsFactor: 'enabled' }))
    buttonByText('Change password').click()
    await nextTick()

    const send = buttonByText('Send code')
    send.click()
    await nextTick()
    send.click()
    await nextTick()
    expect(securityApi.requestSecuritySmsCode).toHaveBeenCalledTimes(1)
    expect(securityApi.requestSecuritySmsCode).toHaveBeenCalledWith(5)

    pending.resolve({})
    await flush()
    expect(host.textContent ?? '').toContain('Code sent')

    const cooled = buttonByText('Resend in 60s')
    expect(cooled.disabled).toBe(true)
    cooled.click()
    await nextTick()
    expect(securityApi.requestSecuritySmsCode).toHaveBeenCalledTimes(1)
  })

  it('does not emit for a change that resolves after the session was replaced', async () => {
    const pending = deferred<unknown>()
    vi.mocked(securityApi.updatePassword).mockReturnValue(pending.promise)
    const onChanged = vi.fn()
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})
    buttonByText('Confirm change').click()
    await nextTick()

    session.setToken('brand-new-synthetic-session')
    await nextTick()
    pending.resolve({})
    await flush()

    expect(onChanged).not.toHaveBeenCalled()
    expect(authApi.logout).not.toHaveBeenCalled()
  })

  it('keeps a new request pending when an abandoned one resolves late', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    vi.mocked(securityApi.updatePassword)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const onChanged = vi.fn()
    await mount(() => h(PasswordChangePanel, { googleFactor: 'enabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})
    buttonByText('Confirm change').click()
    await nextTick()

    session.setToken('replacement-session')
    await nextTick()

    // Re-open the form under the replacement session and submit again.
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})
    buttonByText('Confirm change').click()
    await nextTick()
    expect(securityApi.updatePassword).toHaveBeenCalledTimes(2)

    // The abandoned first request resolves: it must not clear the second request's pending state.
    first.resolve({})
    await nextTick()
    expect(buttonByText('Submitting…').disabled).toBe(true)

    second.resolve({})
    await flush()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('security view', () => {
  it('shows the sign-in state without calling any security mutation when logged out', async () => {
    await mount(() => h(SecurityView), true)
    await flush()
    expect(host.textContent ?? '').toContain('Sign in to view account security settings.')
    expect(securityApi.startTotpEnrollment).not.toHaveBeenCalled()
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
  })

  it('renders profile, KYC and factor status from /common/user_info', async () => {
    session.setUser(fullUser)
    session.setToken('synthetic-security-session')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)

    await mount(() => h(SecurityView), true)
    await flush()

    const text = host.textContent ?? ''
    expect(text).toContain('138****8888')
    expect(text).toContain('tester')
    expect(text).toContain('Verified')
    expect(text).toContain('Enabled')
    expect(text).toContain('Disabled')
    // Opening the page must not start enrollment or change anything.
    expect(securityApi.startTotpEnrollment).not.toHaveBeenCalled()
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
  })

  it.each([['0', 'Normal'], ['1', 'Trading and withdrawals frozen'], ['2', 'Trading frozen'], ['3', 'Withdrawals frozen'], ['99', 'Unknown']])('QA142 translates actual account status %s and preserves known-empty fields', async (status, expected) => {
    const user = { ...fullUser, accountStatus: status, nickName: '', mobileNumber: '' }
    session.setUser(user); session.setToken(newSessionKey())
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(user)
    await mount(() => h(SecurityView), true); await flush()
    const rows = [...host.querySelectorAll('.security-row')]
    const valueOf = (label: string) => rows.find(row => row.querySelector('.row-label')?.textContent === label)?.querySelector('.row-side')?.textContent ?? ''
    expect(valueOf('Account status')).toContain(expected)
    expect(valueOf('Nickname')).toBe('Not set')
    expect(valueOf('Phone')).toContain('Not bound')
    expect(valueOf('Phone')).not.toContain('Not returned')
    expect(securityApi.updatePassword).not.toHaveBeenCalled()
    expect(securityApi.verifyTotpEnrollment).not.toHaveBeenCalled()
  })
  it('QA142 renders Chinese states and treats whitespace-only profile values as unset', async () => {
    i18n.global.locale.value = 'zh-CN'
    const user = { ...fullUser, accountStatus: '3', nickName: ' ', mobileNumber: ' ' }
    session.setUser(user); session.setToken(newSessionKey())
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(user)
    await mount(() => h(SecurityView), true); await flush()
    const rows = [...host.querySelectorAll('.security-row')]
    const row = (label: string) => rows.find(item => item.querySelector('.row-label')?.textContent === label)?.querySelector('.row-side')?.textContent ?? ''
    expect(row('账户状态')).toBe('提现冻结')
    expect(row('昵称')).toBe('未设置')
    expect(row('手机号')).toContain('未绑定')
    expect(row('手机号')).not.toContain('接口未返回')
  })
  it('QA142 keeps missing profile fields distinct from known-empty values', async () => {
    const user = { id: 9 }
    session.setUser(user); session.setToken(newSessionKey())
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(user)
    await mount(() => h(SecurityView), true); await flush()
    const rows = [...host.querySelectorAll('.security-row')]
    for (const label of ['Account status', 'Nickname', 'Phone']) {
      const row = rows.find(item => item.querySelector('.row-label')?.textContent === label)
      expect(row?.textContent).toContain('Not returned')
    }
  })
  it.each([['en-US', 'Enable authenticator (TOTP)', 'Unknown operation (99)'], ['zh-CN', '开启谷歌验证（TOTP）', '未知操作（99）']])('QA143 localizes empty operation names in %s and keeps unknown codes unknown', async (lang, expected, unknown) => {
    i18n.global.locale.value = lang
    session.setUser(fullUser); session.setToken(newSessionKey())
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)
    vi.mocked(securityApi.fetchSettingHistory).mockResolvedValue({ count: 4, items: [
      { time: '', operation: '', operationType: '11', ip: '' },
      { time: '', operation: ' ', operationType: '99', ip: '' },
      { time: '', operation: '', ip: '' },
      { time: '', operation: 'Provided operation', operationType: '11', ip: '' },
    ] })
    await mount(() => h(SecurityView), true); await flush()
    buttonByText(lang === 'zh-CN' ? '安全设置记录' : 'Security settings history').click(); await flush()
    expect(host.textContent).toContain(expected)
    expect(host.textContent).toContain(unknown)
    expect(host.textContent).toContain('--')
    expect(host.textContent).toContain('Provided operation')
  })

  it('shows unknown (not off) when the API omits the factor flags', async () => {
    session.setUser({ id: 9 })
    session.setToken('synthetic-security-session')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue({ id: 9 })

    await mount(() => h(SecurityView), true)
    await flush()

    const text = host.textContent ?? ''
    expect(text).toContain('Unknown')
    expect(text).toContain('cannot be changed here')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Start enrollment'))).toBe(false)
  })

  it('loads the first page of login activity for an authenticated session', async () => {
    session.setUser(fullUser)
    session.setToken('synthetic-security-session')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)

    await mount(() => h(SecurityView), true)
    await flush()
    expect(securityApi.fetchLoginHistory).toHaveBeenCalledWith({ page: 1, pageSize: 10 })
  })

  it('logs out through the server after a password change and clears the session', async () => {
    session.setUser(fullUser)
    session.setToken('synthetic-security-session')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)

    await mount(() => h(SecurityView), true)
    await flush()
    buttonByText('Change password').click()
    await nextTick()
    await setInput(inputByLabel('Current password'), 'OldPass123')
    await setInput(inputByLabel('New password'), 'NewPass456')
    await setInput(inputByLabel('Repeat new password'), 'NewPass456')
    await setInput(inputByLabel('Google code'), '123456')
    buttonByText('Confirm change').click()
    await flush()
    await flush()

    expect(securityApi.updatePassword).toHaveBeenCalledTimes(1)
    expect(authApi.logout).toHaveBeenCalledTimes(1)
    expect(session.getToken()).toBeNull()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('shows a visible error when a history page is malformed instead of an empty table', async () => {
    session.setUser(fullUser)
    session.setToken('synthetic-security-session')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)
    vi.mocked(securityApi.fetchLoginHistory).mockRejectedValue(
      new ApiError({
        kind: 'parse',
        code: '',
        message: 'API contract mismatch: security/login_history [count, historyLoginList]',
      }),
    )

    await mount(() => h(SecurityView), true)
    await flush()

    const text = host.textContent ?? ''
    expect(text).toContain('malformed')
    expect(text).not.toContain('No records')
  })

  it('clears the previous account activity as soon as the session token changes', async () => {
    session.setUser(fullUser)
    session.setToken('account-a')
    vi.mocked(authApi.fetchUserInfo).mockResolvedValue(fullUser)
    const nextPage = deferred<{
      count: number
      items: Array<{ time: string; ip: string; platform: string; status: string }>
    }>()
    vi.mocked(securityApi.fetchLoginHistory)
      .mockResolvedValueOnce({
        count: 1,
        items: [{ time: '2026-09-01 10:00:00', ip: '203.0.113.9', platform: 'Chrome', status: '1' }],
      })
      .mockReturnValueOnce(nextPage.promise)

    await mount(() => h(SecurityView), true)
    await flush()
    expect(host.textContent ?? '').toContain('203.0.113.9')

    session.setToken('account-b')
    await nextTick()
    expect(host.textContent ?? '').not.toContain('203.0.113.9')

    nextPage.resolve({
      count: 1,
      items: [{ time: '2026-09-02 11:00:00', ip: '198.51.100.7', platform: 'Firefox', status: '1' }],
    })
    await flush()
    expect(host.textContent ?? '').toContain('198.51.100.7')
  })

  it('never logs out a replacement session when the password change resolves late', async () => {
    session.setUser(fullUser)
    session.setToken('synthetic-security-session')
    const pendingRefresh = deferred<UserInfoData>()
    vi.mocked(authApi.fetchUserInfo)
      .mockResolvedValueOnce(fullUser)
      .mockReturnValueOnce(pendingRefresh.promise)

    await mount(() => h(SecurityView), true)
    await flush()
    buttonByText('Change password').click()
    await nextTick()
    await fillPasswordForm({})
    buttonByText('Confirm change').click()
    await flush()
    expect(securityApi.updatePassword).toHaveBeenCalledTimes(1)

    // A new login happens while the post-change status refresh is still in flight.
    session.setToken('brand-new-synthetic-session')
    await nextTick()
    pendingRefresh.resolve(fullUser)
    await flush()
    await flush()

    expect(authApi.logout).not.toHaveBeenCalled()
    expect(session.getToken()).toBe('brand-new-synthetic-session')
    expect(router.currentRoute.value.path).not.toBe('/login')
  })
})

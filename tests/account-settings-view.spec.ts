// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App, type VNode } from 'vue'
import { createI18n } from 'vue-i18n'
import ApiKeysPanel from '@/components/account/ApiKeysPanel.vue'
import EmailBindingPanel from '@/components/account/EmailBindingPanel.vue'
import MobileBindingPanel from '@/components/account/MobileBindingPanel.vue'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import * as api from '@/modules/api/account-settings.api'

// Synthetic only: no account read, code send or key mutation is sent to a server.
vi.mock('@/modules/api/account-settings.api', () => ({
  ACCOUNT_ENDPOINTS: {},
  SMS_OPERATION: { bindMobile: 2, updateMobileOld: 3, updateEmailOld: 15, openApi: 16 },
  EMAIL_OPERATION: { bindEmail: 2, updateEmailOld: 15 },
  sendEmailCode: vi.fn(),
  sendSmsCode: vi.fn(),
  bindEmail: vi.fn(),
  updateEmail: vi.fn(),
  bindMobile: vi.fn(),
  updateMobile: vi.fn(),
  fetchApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}))

let host: HTMLDivElement
let mountedApps: App[] = []
let i18n: ReturnType<typeof createI18n>

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  mountedApps = []
  i18n = createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: {} })

  vi.mocked(api.sendEmailCode).mockResolvedValue({})
  vi.mocked(api.sendSmsCode).mockResolvedValue({})
  vi.mocked(api.bindEmail).mockResolvedValue({})
  vi.mocked(api.updateEmail).mockResolvedValue({})
  vi.mocked(api.bindMobile).mockResolvedValue({})
  vi.mocked(api.updateMobile).mockResolvedValue({})
  vi.mocked(api.fetchApiKeys).mockResolvedValue({ count: 0, items: [] })
  vi.mocked(api.createApiKey).mockResolvedValue({ secretKey: 'once', token: 'tk', qrCode: '' })
  vi.mocked(api.updateApiKey).mockResolvedValue({})
  vi.mocked(api.deleteApiKey).mockResolvedValue({})
})

afterEach(() => {
  mountedApps.forEach((app) => app.unmount())
  session.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function mount(render: () => VNode): Promise<void> {
  const Root = defineComponent({ setup: () => render })
  const app = createApp(Root)
  app.use(i18n)
  app.mount(host)
  mountedApps.push(app)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function buttonByText(text: string, root: ParentNode = host): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
  if (found === undefined) {
    throw new Error(`Missing button "${text}" in: ${host.textContent ?? ''}`)
  }
  return found
}

function queryButton(text: string): HTMLButtonElement | null {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) ?? null
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

function sendButtonFor(inputId: string): HTMLButtonElement {
  const input = host.querySelector<HTMLInputElement>(`#${inputId}`)
  const button = input?.closest('.field')?.querySelector<HTMLButtonElement>('button')
  if (button === null || button === undefined) {
    throw new Error(`Missing send button for "${inputId}"`)
  }
  return button
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

describe('email binding panel', () => {
  it('never requests anything on mount and binds only after an explicit submit', async () => {
    const onChanged = vi.fn()
    await mount(() => h(EmailBindingPanel, { currentEmail: '', googleFactor: 'disabled', smsFactor: 'disabled', onChanged }))
    await flush()
    expect(api.bindEmail).not.toHaveBeenCalled()
    expect(api.sendEmailCode).not.toHaveBeenCalled()

    buttonByText('Bind email').click()
    await nextTick()
    await setInput(inputByLabel('New email'), 'new@example.com')
    await setInput(inputByLabel('Email code'), '123456')

    sendButtonFor('account-email-new-code').click()
    await flush()
    expect(api.sendEmailCode).toHaveBeenCalledWith({ email: 'new@example.com', operationType: 2 })

    buttonByText('Confirm binding').click()
    await flush()
    expect(api.bindEmail).toHaveBeenCalledWith({ email: 'new@example.com', emailValidCode: '123456' })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('blocks a duplicated bind submit', async () => {
    const pending = deferred<unknown>()
    vi.mocked(api.bindEmail).mockReturnValue(pending.promise)
    await mount(() => h(EmailBindingPanel, { currentEmail: '', googleFactor: 'disabled', smsFactor: 'disabled' }))
    buttonByText('Bind email').click()
    await nextTick()
    await setInput(inputByLabel('New email'), 'new@example.com')
    await setInput(inputByLabel('Email code'), '123456')

    const submit = buttonByText('Confirm binding')
    submit.click()
    submit.click()
    await nextTick()
    expect(api.bindEmail).toHaveBeenCalledTimes(1)
    pending.resolve({})
    await flush()
  })

  it('requires the Google factor when the account has Google enabled (rebind)', async () => {
    const onChanged = vi.fn()
    await mount(() =>
      h(EmailBindingPanel, { currentEmail: 'old@example.com', googleFactor: 'enabled', smsFactor: 'disabled', onChanged }),
    )
    buttonByText('Change email').click()
    await nextTick()

    await setInput(inputByLabel('New email'), 'new@example.com')
    await setInput(inputByLabel('Current email code'), '111111')
    await setInput(inputByLabel('New email code'), '222222')
    await setInput(inputByLabel('Google code'), '12345')
    // Clickable; the click says why and sends nothing (10-01: no disabled button without a reason).
    buttonByText('Confirm change').click()
    await flush()
    expect(api.updateEmail).not.toHaveBeenCalled()
    expect(host.querySelector('.notice-error')?.textContent ?? '').not.toBe('')

    await setInput(inputByLabel('Google code'), '123456')
    buttonByText('Confirm change').click()
    await flush()
    expect(api.updateEmail).toHaveBeenCalledWith({
      emailOldValidCode: '111111',
      email: 'new@example.com',
      emailNewValidCode: '222222',
      smsValidCode: undefined,
      googleCode: '123456',
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('stays blocked when no second factor is enabled and never weakens verification', async () => {
    await mount(() =>
      h(EmailBindingPanel, { currentEmail: 'old@example.com', googleFactor: 'disabled', smsFactor: 'disabled' }),
    )
    buttonByText('Change email').click()
    await flush()
    expect(host.textContent ?? '').toContain('neither is on')
    expect(queryButton('Confirm change')).toBeNull()
    expect(api.updateEmail).not.toHaveBeenCalled()
  })

  it('blocks a rebind while a factor state is unknown', async () => {
    await mount(() =>
      h(EmailBindingPanel, { currentEmail: 'old@example.com', googleFactor: 'unknown', smsFactor: 'enabled' }),
    )
    buttonByText('Change email').click()
    await flush()
    expect(host.textContent ?? '').toContain('cannot be determined')
    expect(queryButton('Confirm change')).toBeNull()
  })

  it('drops a bind that resolves after the form was closed (mode switch)', async () => {
    const pending = deferred<unknown>()
    vi.mocked(api.bindEmail).mockReturnValue(pending.promise)
    const onChanged = vi.fn()
    await mount(() => h(EmailBindingPanel, { currentEmail: '', googleFactor: 'disabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Bind email').click()
    await nextTick()
    await setInput(inputByLabel('New email'), 'new@example.com')
    await setInput(inputByLabel('Email code'), '123456')
    buttonByText('Confirm binding').click()
    await nextTick()

    buttonByText('Cancel').click()
    await nextTick()
    buttonByText('Bind email').click()
    await nextTick()

    pending.resolve({})
    await flush()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('clears drafts and never emits when the session token changes', async () => {
    const onChanged = vi.fn()
    await mount(() => h(EmailBindingPanel, { currentEmail: '', googleFactor: 'disabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Bind email').click()
    await nextTick()
    await setInput(inputByLabel('New email'), 'new@example.com')

    session.setToken('replacement-session')
    await nextTick()

    expect(host.querySelector('input[aria-label="New email"]')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('clears the rejected codes after a failure without echoing them', async () => {
    vi.mocked(api.bindEmail).mockRejectedValue(
      new ApiError({ kind: 'api', code: '1001', message: 'email new@example.com code 123456 is taken' }),
    )
    const onChanged = vi.fn()
    await mount(() => h(EmailBindingPanel, { currentEmail: '', googleFactor: 'disabled', smsFactor: 'disabled', onChanged }))
    buttonByText('Bind email').click()
    await nextTick()
    await setInput(inputByLabel('New email'), 'new@example.com')
    await setInput(inputByLabel('Email code'), '123456')
    buttonByText('Confirm binding').click()
    await flush()

    expect(onChanged).not.toHaveBeenCalled()
    expect(inputByLabel('Email code').value).toBe('')
    const text = host.textContent ?? ''
    expect(text).not.toContain('123456')
    expect(text).not.toContain('new@example.com')
    expect(text).toContain('is taken')
  })
})

describe('phone binding panel', () => {
  it('binds a number, sending the new-number code and only the required Google field', async () => {
    const onChanged = vi.fn()
    await mount(() =>
      h(MobileBindingPanel, { currentMobile: '', countryCode: '+86', googleFactor: 'enabled', onChanged }),
    )
    buttonByText('Bind phone').click()
    await nextTick()
    await setInput(inputByLabel('New phone number'), '13800000000')
    await setInput(inputByLabel('New phone code'), '123456')
    await setInput(inputByLabel('Google code'), '654321')

    sendButtonFor('account-mobile-new-code').click()
    await flush()
    expect(api.sendSmsCode).toHaveBeenCalledWith({ countryCode: '+86', mobile: '13800000000', operationType: 2 })

    buttonByText('Confirm binding').click()
    await flush()
    expect(api.bindMobile).toHaveBeenCalledWith({
      countryCode: '+86',
      mobileNumber: '13800000000',
      smsAuthCode: '123456',
      googleCode: '654321',
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('rebinds a number with the current-number code and the new-number code', async () => {
    const onChanged = vi.fn()
    await mount(() =>
      h(MobileBindingPanel, { currentMobile: '138****8888', countryCode: '+86', googleFactor: 'disabled', onChanged }),
    )
    buttonByText('Change phone').click()
    await nextTick()
    await setInput(inputByLabel('New phone number'), '13900000000')
    await setInput(inputByLabel('Current phone code'), '222222')
    await setInput(inputByLabel('New phone code'), '333333')

    sendButtonFor('account-mobile-old-code').click()
    await flush()
    expect(api.sendSmsCode).toHaveBeenCalledWith({ operationType: 3 })

    buttonByText('Confirm change').click()
    await flush()
    expect(api.updateMobile).toHaveBeenCalledWith({
      countryCode: '+86',
      mobileNumber: '13900000000',
      smsAuthCode: '333333',
      authenticationCode: '222222',
      googleCode: undefined,
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('blocks submit while the Google factor state is unknown', async () => {
    await mount(() =>
      h(MobileBindingPanel, { currentMobile: '', countryCode: '+86', googleFactor: 'unknown' }),
    )
    buttonByText('Bind phone').click()
    await flush()
    expect(host.textContent ?? '').toContain('cannot be determined')
    expect(queryButton('Confirm binding')).toBeNull()
    expect(api.bindMobile).not.toHaveBeenCalled()
  })
})

describe('API keys panel', () => {
  it('lists keys for an authenticated session and never auto-creates', async () => {
    session.setToken('synthetic-session')
    vi.mocked(api.fetchApiKeys).mockResolvedValue({
      count: 1,
      items: [{ token: 'tk-1', label: 'bots', ips: '203.0.113.9', permissions: { earn: false, loan: false } }],
    })
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()
    expect(api.fetchApiKeys).toHaveBeenCalledWith({ page: 1, pageSize: 10 })
    expect(host.textContent ?? '').toContain('bots')
    expect(host.textContent ?? '').toContain('tk-1')
    expect(api.createApiKey).not.toHaveBeenCalled()
  })

  it('blocks create/edit while no second factor is enabled', async () => {
    session.setToken('synthetic-session')
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'disabled', smsFactor: 'disabled' }))
    await flush()
    expect(host.textContent ?? '').toContain('neither is on')
    expect(queryButton('Create key')).toBeNull()
    expect(api.createApiKey).not.toHaveBeenCalled()
  })

  it('blocks create while a factor state is unknown', async () => {
    session.setToken('synthetic-session')
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'unknown', smsFactor: 'enabled' }))
    await flush()
    expect(host.textContent ?? '').toContain('cannot be determined')
    expect(queryButton('Create key')).toBeNull()
  })

  it('creates a key with the exact body, masks the secret, and clears it on close', async () => {
    session.setToken('synthetic-session')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(api.createApiKey).mockResolvedValue({ secretKey: 'SECRET-XYZ', token: 'tk-new', qrCode: '' })

    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()
    buttonByText('Create key').click()
    await nextTick()
    await setInput(inputByLabel('Label'), 'main')
    await setInput(inputByLabel('IP allowlist (optional, comma separated, max 5)'), '203.0.113.9')
    await setInput(inputByLabel('Google code'), '123456')

    // SMS factor is disabled: no SMS code field is rendered.
    expect(host.querySelector('#api-create-sms')).toBeNull()

    buttonByText('Create').click()
    await flush()
    expect(api.createApiKey).toHaveBeenCalledWith({
      believeIps: '203.0.113.9',
      label: 'main',
      permissions: { earn: false, loan: false },
      smsValidCode: undefined,
      googleCode: '123456',
    })

    // Secret is masked by default and never written to storage or the console.
    expect(host.textContent ?? '').not.toContain('SECRET-XYZ')
    expect(host.textContent ?? '').toContain('••••')
    host.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')?.click()
    await nextTick()
    expect(host.textContent ?? '').toContain('SECRET-XYZ')

    buttonByText('Close').click()
    await nextTick()
    expect(host.textContent ?? '').not.toContain('SECRET-XYZ')
    expect(setItem).not.toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('drops a create that resolves after the session changed', async () => {
    session.setToken('synthetic-session')
    const pending = deferred<{ secretKey: string; token: string; qrCode: string }>()
    vi.mocked(api.createApiKey).mockReturnValue(pending.promise)
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()
    buttonByText('Create key').click()
    await nextTick()
    await setInput(inputByLabel('Label'), 'main')
    await setInput(inputByLabel('Google code'), '123456')
    buttonByText('Create').click()
    await nextTick()

    session.setToken('replacement-session')
    await nextTick()
    pending.resolve({ secretKey: 'LATE-SECRET', token: 'tk-late', qrCode: '' })
    await flush()
    expect(host.textContent ?? '').not.toContain('LATE-SECRET')
  })

  it('asks for the bound factor before deleting, sends token + code, and never reveals a stored secret', async () => {
    session.setToken('synthetic-session')
    vi.mocked(api.fetchApiKeys).mockResolvedValue({
      count: 1,
      items: [{ token: 'tk-1', label: 'bots', ips: '', permissions: { earn: false, loan: false } }],
    })
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()

    buttonByText('Delete').click()
    await nextTick()
    expect(api.deleteApiKey).not.toHaveBeenCalled()
    expect(host.textContent ?? '').toContain('Delete it?')

    // Google is bound: the code is required before the request is sent.
    buttonByText('Delete key').click()
    await flush()
    expect(api.deleteApiKey).not.toHaveBeenCalled()
    await setInput(inputByLabel('Google code'), '112233')
    buttonByText('Delete key').click()
    await flush()
    expect(api.deleteApiKey).toHaveBeenCalledWith({ token: 'tk-1', smsValidCode: undefined, googleCode: '112233' })
    // The legacy "view" screen (which returned a stored secret) is never called.
    expect('openApiOne' in api).toBe(false)
  })

  it('clears previous account rows immediately when the session token changes', async () => {
    session.setToken('account-a')
    vi.mocked(api.fetchApiKeys)
      .mockResolvedValueOnce({ count: 1, items: [{ token: 'tk-a', label: 'a', ips: '', permissions: { earn: false, loan: false } }] })
      .mockResolvedValueOnce({ count: 0, items: [] })
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()
    expect(host.textContent ?? '').toContain('tk-a')

    session.setToken('account-b')
    await nextTick()
    expect(host.textContent ?? '').not.toContain('tk-a')
    await flush()
  })

  it('reports a malformed list as an error instead of an empty table', async () => {
    session.setToken('synthetic-session')
    vi.mocked(api.fetchApiKeys).mockRejectedValue(
      new ApiError({ kind: 'parse', code: '', message: 'API contract mismatch: openapi/my_api_list [count, apiList]' }),
    )
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain('malformed')
    expect(text).not.toContain('No API keys')
  })

  it('edits a key with the token plus allowlist and the (unchanged) permissions', async () => {
    session.setToken('synthetic-session')
    vi.mocked(api.fetchApiKeys).mockResolvedValue({
      count: 1,
      items: [{ token: 'tk-1', label: 'bots', ips: '203.0.113.9', permissions: { earn: false, loan: false } }],
    })
    await mount(() => h(ApiKeysPanel, { authenticated: true, googleFactor: 'enabled', smsFactor: 'disabled' }))
    await flush()

    buttonByText('Edit').click()
    await nextTick()
    await setInput(inputByLabel('Label'), 'renamed')
    await setInput(inputByLabel('IP allowlist (optional, comma separated, max 5)'), '203.0.113.10')
    await setInput(inputByLabel('Google code'), '654321')
    buttonByText('Save').click()
    await flush()
    expect(api.updateApiKey).toHaveBeenCalledWith({
      token: 'tk-1',
      believeIps: '203.0.113.10',
      label: 'renamed',
      permissions: { earn: false, loan: false },
      smsValidCode: undefined,
      googleCode: '654321',
    })
    const [call] = vi.mocked(api.updateApiKey).mock.calls
    expect(call?.[0]).not.toHaveProperty('withdraw')
  })
})

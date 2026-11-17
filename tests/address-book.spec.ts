// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { i18n, setLocale } from '@/i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import LocalePanel from '@/components/layout/LocalePanel.vue'
import AddressBookPanel from '@/components/wallet/AddressBookPanel.vue'
import { session, type SessionUser } from '@/core/session'
import * as authApi from '@/modules/api/auth.api'
import * as walletApi from '@/modules/api/wallet.api'
import type { CoinRow } from '@/modules/wallet/coins'
import type { WalletAddress } from '@/modules/wallet/types'
import type { PublicInfoV4 } from '@/modules/api/types'
import { useMarketStore } from '@/stores/market'
import { ApiError } from '@/core/errors'

// Synthetic only: no wallet request reaches a real server in this suite.
vi.mock('@/modules/api/wallet.api', () => ({
  WALLET_PATHS: {},
  WALLET_GATEWAY_PATHS: [],
  fetchDepositAddress: vi.fn(),
  fetchWithdrawConfig: vi.fn(),
  fetchAddressBook: vi.fn(),
  addWalletAddress: vi.fn(),
  deleteWalletAddress: vi.fn(),
  submitWithdrawal: vi.fn(),
  cancelWithdrawal: vi.fn(),
  fetchDepositHistory: vi.fn(),
  fetchWithdrawHistory: vi.fn(),
  sendSmsCode: vi.fn(),
  sendEmailCode: vi.fn(),
  sendAddressBookSmsCode: vi.fn(),
  sendAddressBookEmailCode: vi.fn(),
  fetchWalletNetworks: vi.fn(),
}))

vi.mock('@/modules/api/auth.api', () => ({
  fetchUserInfo: vi.fn(),
  logout: vi.fn(),
  loginStepOne: vi.fn(),
  loginStepTwo: vi.fn(),
}))

const publicInfo = {
  market: {
    coinList: {
      BTC: { showName: 'Bitcoin', showPrecision: 8 },
      USDT: { showName: 'Tether', showPrecision: 6, mainChainType: 1 },
      XRP: { showName: 'XRP', showPrecision: 6, tagType: 2 },
    },
    followCoinList: {
      USDT: {
        USDT: { mainChainName: 'TRC20', showPrecision: 6 },
        USDTETH: { mainChainName: 'ERC20', showPrecision: 6 },
      },
    },
  },
} as unknown as PublicInfoV4

const coins: CoinRow[] = [
  { coin: 'BTC', showName: 'Bitcoin', available: '2', locked: '0', total: '2', btcValuation: '2', depositOpen: true, withdrawOpen: true, isFiat: false },
  { coin: 'USDT', showName: 'Tether', available: '100', locked: '0', total: '100', btcValuation: '100', depositOpen: true, withdrawOpen: true, isFiat: false },
  { coin: 'XRP', showName: 'XRP', available: '50', locked: '0', total: '50', btcValuation: '50', depositOpen: true, withdrawOpen: true, isFiat: false },
]

function row(overrides: Partial<WalletAddress> = {}): WalletAddress {
  return { id: '1', coin: 'BTC', address: 'bc1addr', tag: '', label: 'cold', raw: 'bc1addr', ...overrides }
}

let pinia: Pinia
let host: HTMLDivElement
let apps: App[] = []

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  apps = []

  vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([])
  vi.mocked(walletApi.addWalletAddress).mockResolvedValue({ created: true })
  // Historical backend by default: no `addr/networks`.
  vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue(null)
  vi.mocked(walletApi.deleteWalletAddress).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendAddressBookSmsCode).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendAddressBookEmailCode).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendSmsCode).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendEmailCode).mockResolvedValue(undefined)
  vi.mocked(authApi.fetchUserInfo).mockResolvedValue({ googleStatus: '1', isOpenMobileCheck: '1', email: '', authLevel: '1' })

  useMarketStore().publicInfo = publicInfo
})

afterEach(() => {
  apps.forEach(app => app.unmount())
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

/** Mobile-only account: Google + SMS codes required, email channel not applicable. */
function authenticate(token = 'session-a', overrides: Partial<SessionUser> = {}): void {
  session.setToken(token)
  session.setUser({ id: 1, googleStatus: '1', isOpenMobileCheck: '1', email: '', authLevel: 1, ...overrides })
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(render: () => ReturnType<typeof h>): Promise<void> {
  const Root = defineComponent({
    setup() {
      return render
    },
  })
  const app = createApp(Root)
  app.use(pinia)
  setLocale('en-US')
  app.use(i18n)
  app.mount(host)
  apps.push(app)
  await flush()
}

async function expectTranslatedStatus(chinese: string, english: string): Promise<void> {
  const status = host.querySelector('[role="status"]')
  setLocale('zh-CN')
  await nextTick()
  expect(status?.textContent).toContain(chinese)
  setLocale('en-US')
  await nextTick()
  expect(status?.textContent).toContain(english)
}

function buttonByText(text: string): HTMLButtonElement {
  // Dialogs are teleported to <body>, so search the whole document.
  const found = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  if (found === undefined) {
    throw new Error(`Missing button "${text}" in: ${document.body.textContent ?? ''}`)
  }
  return found
}

function inputByLabel(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (found === null) {
    throw new Error(`Missing input "${label}" in: ${document.body.textContent ?? ''}`)
  }
  return found
}

async function setInput(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function byTestId(id: string): HTMLButtonElement {
  const found = document.body.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
  if (found === null) throw new Error(`Missing ${id}`)
  return found
}

async function openAdd(): Promise<void> {
  byTestId('book-add').click()
  await flush()
}

async function saveAdd(): Promise<void> {
  byTestId('book-save').click()
  await flush()
}

async function armDelete(): Promise<void> {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label')?.startsWith('Delete'))
  if (row === undefined) throw new Error('Missing row delete')
  row.click()
  await flush()
}

async function fillAddForm(options: {
  address: string
  label: string
  tag?: string
  google?: string
  sms?: string
  email?: string
}): Promise<void> {
  await setInput(inputByLabel('Address'), options.address)
  if (options.tag !== undefined) {
    await setInput(inputByLabel('Tag / Memo'), options.tag)
  }
  await setInput(inputByLabel('Label'), options.label)
  if (options.google !== undefined) {
    await setInput(inputByLabel('Google code'), options.google)
  }
  if (options.sms !== undefined) {
    await setInput(inputByLabel('SMS code'), options.sms)
  }
  if (options.email !== undefined) {
    await setInput(inputByLabel('Email code'), options.email)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('address book error language', () => {
  it('retranslates a known list error and keeps an unknown retry error verbatim', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockRejectedValueOnce(new ApiError({ kind: 'api', code: '10010', message: 'server detail' }))
      .mockRejectedValueOnce(new Error('backend unavailable'))
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    expect(host.querySelector('.state-text')?.textContent).toBe('Incorrect Google code')
    setLocale('zh-CN')
    await nextTick()
    expect(host.querySelector('.state-text')?.textContent).toBe('谷歌验证码错误')
    expect(walletApi.fetchAddressBook).toHaveBeenCalledTimes(1)
    host.querySelector<HTMLButtonElement>('.state.error button')?.click()
    await flush()
    expect(host.querySelector('.state-text')?.textContent).toBe('backend unavailable')
    setLocale('en-US')
    await nextTick()
    expect(host.querySelector('.state-text')?.textContent).toBe('backend unavailable')
  })

  it('updates the open dialog validation and clears it on close', async () => {
    authenticate()
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    await fillAddForm({ address: 'bc1new', label: 'cold' })
    await saveAdd()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Enter the 6-digit Google code')
    setLocale('zh-CN')
    await nextTick()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('请输入 6 位谷歌验证码')
    buttonByText('取消').click()
    await openAdd()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(walletApi.addWalletAddress).not.toHaveBeenCalled()
  })
})

describe('address book code namespace', () => {
  it('sends the legacy add SMS discriminator and never the CIAO withdrawal code', async () => {
    authenticate()
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    buttonByText('Send code').click()
    await flush()

    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledTimes(1)
    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledWith('add')
    // The CIAO withdrawal code endpoints are a different namespace and must never be used here.
    expect(walletApi.sendSmsCode).not.toHaveBeenCalled()
    expect(walletApi.sendEmailCode).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Code sent')
    buttonByText('Cancel').click()
    await nextTick()
    await expectTranslatedStatus('验证码已发送', 'Code sent')
    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledTimes(1)
  })

  it('sends the legacy delete SMS discriminator when a row is armed for deletion', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([row()])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await armDelete()
    await flush()
    buttonByText('Send code').click()
    await flush()

    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledWith('delete')
    expect(walletApi.sendSmsCode).not.toHaveBeenCalled()
  })

  it('sends the legacy address-book email code, not the CIAO email code', async () => {
    authenticate('session-a', { isOpenMobileCheck: '0', email: 'u@example.com' })
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    buttonByText('Send code').click()
    await flush()

    expect(walletApi.sendAddressBookEmailCode).toHaveBeenCalledTimes(1)
    expect(walletApi.sendAddressBookSmsCode).not.toHaveBeenCalled()
    expect(walletApi.sendEmailCode).not.toHaveBeenCalled()
  })

  it('never duplicates a code send while one is pending and the cooldown blocks repeats', async () => {
    authenticate()
    const pending = deferred<void>()
    vi.mocked(walletApi.sendAddressBookSmsCode).mockReturnValue(pending.promise)
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    buttonByText('Send code').click()
    await flush()
    buttonByText('Send code').click()
    await flush()
    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledTimes(1)

    pending.resolve(undefined)
    await flush()
    expect(document.body.textContent).toContain('Resend in')

    buttonByText('Resend in').click()
    await flush()
    expect(walletApi.sendAddressBookSmsCode).toHaveBeenCalledTimes(1)
  })
})

describe('address book session isolation', () => {
  it('does not read the address book while unauthenticated', async () => {
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    expect(walletApi.fetchAddressBook).not.toHaveBeenCalled()
  })

  it('keeps the typed draft across a same-token profile refresh', async () => {
    authenticate('session-a')
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await setInput(inputByLabel('Address'), 'bc1draft')
    await setInput(inputByLabel('Label'), 'cold')

    // A normal profile update notifies the session but keeps the token: the draft must survive.
    session.setUser({ id: 1, nickName: 'renamed', googleStatus: '1', isOpenMobileCheck: '1', email: '', authLevel: 1 })
    await flush()

    expect(inputByLabel('Address').value).toBe('bc1draft')
    expect(inputByLabel('Label').value).toBe('cold')
  })

  it('resets drafts, rows and the cooldown on an account change', async () => {
    authenticate('session-a')
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([row()])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await setInput(inputByLabel('Address'), 'bc1draft')
    await setInput(inputByLabel('Label'), 'cold')
    buttonByText('Send code').click()
    await flush()
    expect(document.body.textContent).toContain('Resend in')

    authenticate('session-b')
    await flush()
    // The dialog closes on an account change; reopening shows an empty draft.
    expect(document.body.querySelector('input[aria-label="Address"]')).toBeNull()
    await openAdd()

    expect(inputByLabel('Address').value).toBe('')
    expect(inputByLabel('Label').value).toBe('')
    // The cooldown is reset too: the new account may request a code immediately.
    expect(buttonByText('Send code').disabled).toBe(false)
  })

  it('ignores a stale list response that resolves after the account changes', async () => {
    authenticate('session-a')
    const stale = deferred<WalletAddress[]>()
    const fresh = deferred<WalletAddress[]>()
    vi.mocked(walletApi.fetchAddressBook)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    authenticate('session-b')
    await flush()
    fresh.resolve([row({ id: '2', address: 'freshaddr', raw: 'freshaddr' })])
    await flush()
    stale.resolve([row({ id: '1', address: 'staleaddr', raw: 'staleaddr' })])
    await flush()

    expect(document.body.textContent).toContain('freshaddr')
    expect(document.body.textContent).not.toContain('staleaddr')
  })

  it('ignores a stale list failure after the account changes', async () => {
    authenticate('session-a')
    const stale = deferred<WalletAddress[]>()
    vi.mocked(walletApi.fetchAddressBook)
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue([])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    authenticate('session-b')
    await flush()
    stale.reject(new Error('stale load failed'))
    await flush()

    expect(document.body.textContent).not.toContain('stale load failed')
  })

  it('ignores a stale add success after the account changes', async () => {
    authenticate('session-a')
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    await fillAddForm({ address: 'bc1new', label: 'cold', google: '123456', sms: '654321' })

    const pendingAdd = deferred<{ created: boolean }>()
    vi.mocked(walletApi.addWalletAddress).mockReturnValue(pendingAdd.promise)
    byTestId('book-save').click()
    await flush()
    expect(walletApi.addWalletAddress).toHaveBeenCalledTimes(1)

    authenticate('session-b')
    await flush()
    const readsBefore = vi.mocked(walletApi.fetchAddressBook).mock.calls.length
    pendingAdd.resolve({ created: true })
    await flush()

    expect(document.body.textContent).not.toContain('Address added')
    // The stale result must not trigger a follow-up read either.
    expect(vi.mocked(walletApi.fetchAddressBook).mock.calls.length).toBe(readsBefore)
  })

  it('ignores a stale add failure after the account changes', async () => {
    authenticate('session-a')
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    await fillAddForm({ address: 'bc1new', label: 'cold', google: '123456', sms: '654321' })

    const pendingAdd = deferred<{ created: boolean }>()
    vi.mocked(walletApi.addWalletAddress).mockReturnValue(pendingAdd.promise)
    byTestId('book-save').click()
    await flush()

    authenticate('session-b')
    await flush()
    pendingAdd.reject(new Error('stale add rejected'))
    await flush()

    expect(document.body.textContent).not.toContain('stale add rejected')
  })

  it('ignores stale code success and failure after the account changes', async () => {
    authenticate('session-a')
    const pendingCode = deferred<void>()
    vi.mocked(walletApi.sendAddressBookSmsCode).mockReturnValue(pendingCode.promise)
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    buttonByText('Send code').click()
    await flush()
    authenticate('session-b')
    await flush()
    pendingCode.resolve(undefined)
    await flush()
    expect(document.body.textContent).not.toContain('Code sent')

    const failingCode = deferred<void>()
    vi.mocked(walletApi.sendAddressBookSmsCode).mockReturnValue(failingCode.promise)
    await openAdd()
    buttonByText('Send code').click()
    await flush()
    authenticate('session-c')
    await flush()
    failingCode.reject(new Error('stale code rejected'))
    await flush()
    expect(document.body.textContent).not.toContain('stale code rejected')
  })

  it('ignores a stale add result after the panel unmounts', async () => {
    authenticate('session-a')
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    await fillAddForm({ address: 'bc1new', label: 'cold', google: '123456', sms: '654321' })

    const pendingAdd = deferred<{ created: boolean }>()
    vi.mocked(walletApi.addWalletAddress).mockReturnValue(pendingAdd.promise)
    byTestId('book-save').click()
    await flush()

    apps.forEach(app => app.unmount())
    apps = []
    pendingAdd.resolve({ created: true })
    await flush()

    expect(document.body.textContent).not.toContain('Address added')
  })
})

describe('address book selection isolation', () => {
  it('clears the address when the network changes on a multi-chain coin', async () => {
    authenticate()
    await mount(() => h(AddressBookPanel, { coin: 'USDT', coins }))
    await openAdd()

    await setInput(inputByLabel('Address'), 'TaddrOld')
    const network = document.body.querySelector<HTMLSelectElement>('select[aria-label="Network"]')
    expect(network).not.toBeNull()
    network!.value = 'coin:USDTETH'
    network!.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    expect(inputByLabel('Address').value).toBe('')
  })

  it('clears the address and memo when the coin changes', async () => {
    authenticate()
    const coin = ref('XRP')
    await mount(() => h(AddressBookPanel, {
      coin: coin.value,
      coins,
      'onUpdate:coin': (next: string) => {
        coin.value = next
      },
    }))
    await openAdd()

    await setInput(inputByLabel('Address'), 'rAddr')
    await setInput(inputByLabel('Tag / Memo'), 'memo1')

    coin.value = 'BTC'
    await flush()

    expect(inputByLabel('Address').value).toBe('')
    expect(host.querySelector('input[aria-label="Tag / Memo"]')).toBeNull()
  })
})

describe('address book add/delete confirmation', () => {
  it('confirms an add only when the full address including memo matches', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ id: '9', coin: 'XRP', address: 'rAddr', tag: 'memo1', label: 'cold', raw: 'rAddr_memo1' })])
    const languageOpen = ref(false)
    await mount(() => h('div', [
      h(AddressBookPanel, { coin: 'XRP', coins }),
      h(LocalePanel, { open: languageOpen.value, anchor: null, 'onUpdate:open': open => { languageOpen.value = open } }),
    ]))
    await openAdd()
    await fillAddForm({ address: 'rAddr', tag: 'memo1', label: 'cold', google: '123456', sms: '654321' })

    byTestId('book-save').click()
    await flush()

    expect(walletApi.addWalletAddress).toHaveBeenCalledWith({
      coinSymbol: 'XRP',
      address: 'rAddr_memo1',
      label: 'cold',
      googleCode: '123456',
      smsValidCode: '654321',
      emailValidCode: '',
    })
    expect(document.body.textContent).toContain('Address added')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    languageOpen.value = true
    await nextTick()
    const chinese = document.querySelector<HTMLElement>('#lp-pane-language [role="option"]:has([lang="zh-CN"])')
    if (!chinese) throw new Error('Missing Chinese language option')
    chinese.click()
    await nextTick()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('地址已添加')
    expect(walletApi.addWalletAddress).toHaveBeenCalledTimes(1)
  })

  it('does not claim success when the reloaded memo differs', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ id: '9', coin: 'XRP', address: 'rAddr', tag: 'other-memo', label: 'cold', raw: 'rAddr_other-memo' })])
    await mount(() => h(AddressBookPanel, { coin: 'XRP', coins }))
    await openAdd()
    await fillAddForm({ address: 'rAddr', tag: 'memo1', label: 'cold', google: '123456', sms: '654321' })

    byTestId('book-save').click()
    await flush()

    expect(document.body.textContent).toContain('not confirmed')
    await expectTranslatedStatus('未确认添加结果', 'not confirmed')
    expect(document.body.textContent).not.toContain('Address added')
  })

  it('does not claim success when the add reload fails', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('reload failed'))
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    await fillAddForm({ address: 'bc1new', label: 'cold', google: '123456', sms: '654321' })

    byTestId('book-save').click()
    await flush()

    expect(document.body.textContent).toContain('reload failed')
    expect(document.body.textContent).not.toContain('Address added')
  })

  it('reports a delete only after the reload confirms the row is gone', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockResolvedValueOnce([row({ id: '5' })])
      .mockResolvedValueOnce([])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await armDelete()
    await setInput(inputByLabel('Google code'), '123456')
    await setInput(inputByLabel('SMS code'), '654321')
    byTestId('book-delete-confirm').click()
    await flush()

    expect(walletApi.deleteWalletAddress).toHaveBeenCalledWith(['5'], { googleCode: '123456', smsValidCode: '654321' }, {})
    expect(document.body.textContent).toContain('Address deleted')
    await expectTranslatedStatus('地址已删除', 'Address deleted')
  })

  it('is never reported as deleted when the reload fails', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook)
      .mockResolvedValueOnce([row({ id: '5' })])
      .mockRejectedValueOnce(new Error('reload failed'))
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await armDelete()
    await setInput(inputByLabel('Google code'), '123456')
    await setInput(inputByLabel('SMS code'), '654321')
    byTestId('book-delete-confirm').click()
    await flush()

    expect(document.body.textContent).toContain('reload failed')
    expect(document.body.textContent).not.toContain('Address deleted')
  })

  it('is never reported as deleted when the row is still listed', async () => {
    authenticate()
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([row({ id: '5' })])
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()

    await armDelete()
    await setInput(inputByLabel('Google code'), '123456')
    await setInput(inputByLabel('SMS code'), '654321')
    byTestId('book-delete-confirm').click()
    await flush()

    expect(document.body.textContent).not.toContain('Address deleted')
    expect(document.body.textContent).toContain('the delete is not confirmed')
    await expectTranslatedStatus('未确认删除结果', 'the delete is not confirmed')
  })
})

describe('address book fail-closed guards', () => {
  it('blocks the add when a required memo is blank', async () => {
    authenticate()
    await mount(() => h(AddressBookPanel, { coin: 'XRP', coins }))
    await openAdd()
    await fillAddForm({ address: 'rAddr', label: 'cold', google: '123456', sms: '654321' })

    expect(byTestId('book-save').disabled).toBe(true)
    byTestId('book-save').click()
    await flush()
    expect(walletApi.addWalletAddress).not.toHaveBeenCalled()
  })

  it('blocks the add when the security snapshot is unknown', async () => {
    session.setToken('session-a')
    // No googleStatus / isOpenMobileCheck reported -> security is unknown, so nothing may be sent.
    session.setUser({ id: 1 })
    await mount(() => h(AddressBookPanel, { coin: 'BTC', coins }))
    await openAdd()
    // With unknown flags only the always-required Google field is rendered; the SMS channel is
    // deliberately absent rather than assumed.
    await fillAddForm({ address: 'bc1new', label: 'cold', google: '123456' })

    byTestId('book-save').click()
    await flush()

    expect(walletApi.addWalletAddress).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('security settings are unknown')
  })
})

describe('address book contract v2 (per network)', () => {
  const BSC = {
    network: 'BSC', displayName: 'BNB Smart Chain (BEP-20)', coins: ['USDC'], addressRegex: '^0x[0-9a-fA-F]{40}$',
    needMemo: false, tokenContracts: { USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }, checksum: 'EIP-55', chainId: 56,
  }
  const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const v2Coins: CoinRow[] = [...coins, { coin: 'USDC', showName: 'USDC', available: '1', locked: '0', total: '1', btcValuation: '0', depositOpen: true, withdrawOpen: true, isFiat: false }]

  function v2Row(overrides: Partial<WalletAddress> = {}): WalletAddress {
    return { id: '12', coin: 'USDC', address: CHECKSUMMED, tag: '', label: 'ledger', raw: CHECKSUMMED, network: 'BSC', ...overrides }
  }

  beforeEach(() => {
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue([BSC])
  })

  it('groups rows by network, not by coin, and keeps legacy rows in their own group', async () => {
    authenticate('session-a', { isOpenMobileCheck: '0', email: 'u@example.com' })
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([
      v2Row(),
      v2Row({ id: '13', coin: 'USDT', label: 'second', address: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359' }),
      row({ id: '3', coin: 'BTC', network: undefined }),
    ])
    await mount(() => h(AddressBookPanel, { coin: 'USDC', coins: v2Coins }))

    const groups = [...host.querySelectorAll('[data-group]')].map(node => node.getAttribute('data-group'))
    expect(groups).toEqual(['net:BSC', 'coin:BTC'])
    expect(host.querySelector('[data-group="net:BSC"]')?.querySelectorAll('[data-address-id]')).toHaveLength(2)
    expect(host.textContent).toContain('Verified · no email code')
  })

  it('adds with network + Google + email (label optional) and reports an idempotent re-add', async () => {
    authenticate('session-a', { isOpenMobileCheck: '0', email: 'u@example.com' })
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValueOnce([]).mockResolvedValueOnce([v2Row({ label: 'original' })])
    vi.mocked(walletApi.addWalletAddress).mockResolvedValue({ created: false })
    await mount(() => h(AddressBookPanel, { coin: 'USDC', coins: v2Coins }))
    await openAdd()

    expect(document.body.querySelector('input[aria-label="SMS code"]')).toBeNull()
    await setInput(inputByLabel('Address'), CHECKSUMMED.toLowerCase())
    await setInput(inputByLabel('Google code'), '123456')
    await setInput(inputByLabel('Email code'), '654321')
    expect(byTestId('book-save').disabled).toBe(false)
    await saveAdd()

    expect(walletApi.addWalletAddress).toHaveBeenCalledWith({
      coinSymbol: '',
      network: 'BSC',
      address: CHECKSUMMED.toLowerCase(),
      label: '',
      googleCode: '123456',
      smsValidCode: '',
      emailValidCode: '654321',
    })
    expect(document.body.textContent).toContain('already in the address book')
    await expectTranslatedStatus('该地址已在地址簿中', 'already in the address book')
  })

  it('rejects a bad EIP-55 checksum before anything is sent', async () => {
    authenticate('session-a', { isOpenMobileCheck: '0', email: 'u@example.com' })
    await mount(() => h(AddressBookPanel, { coin: 'USDC', coins: v2Coins }))
    await openAdd()
    await setInput(inputByLabel('Address'), '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    expect(document.body.textContent).toContain('Checksum mismatch')
    expect(byTestId('book-save').disabled).toBe(true)
  })

  it('deletes a network row with the Google code only', async () => {
    authenticate('session-a', { isOpenMobileCheck: '1', email: 'u@example.com' })
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValueOnce([v2Row()]).mockResolvedValueOnce([])
    await mount(() => h(AddressBookPanel, { coin: 'USDC', coins: v2Coins }))
    await armDelete()

    expect(document.body.querySelector('input[aria-label="SMS code"]')).toBeNull()
    await setInput(inputByLabel('Google code'), '111111')
    byTestId('book-delete-confirm').click()
    await flush()

    expect(walletApi.deleteWalletAddress).toHaveBeenCalledWith(['12'], { googleCode: '111111', smsValidCode: '' }, { network: true })
    expect(document.body.textContent).toContain('Address deleted')
    await expectTranslatedStatus('地址已删除', 'Address deleted')
  })
})

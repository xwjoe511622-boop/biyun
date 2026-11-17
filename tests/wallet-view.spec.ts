// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import AssetsView from '@/views/AssetsView.vue'
import DepositPanel from '@/components/wallet/DepositPanel.vue'
import WithdrawPanel from '@/components/wallet/WithdrawPanel.vue'
import RecordsPanel from '@/components/wallet/RecordsPanel.vue'
import { session } from '@/core/session'
import { ApiError } from '@/core/errors'
import * as authApi from '@/modules/api/auth.api'
import * as walletApi from '@/modules/api/wallet.api'
import * as depositQr from '@/modules/wallet/depositQr'
import type { CoinRow } from '@/modules/wallet/coins'
import { normalizeWalletNetworks } from '@/modules/wallet/networks'
import type { DepositAddress, HistoryEntry, HistoryPage, WithdrawConfig } from '@/modules/wallet/types'
import type { PublicInfoV4 } from '@/modules/api/types'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

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
  fetchWalletNetworks: vi.fn(),
}))

vi.mock('@/modules/api/auth.api', () => ({
  fetchUserInfo: vi.fn(),
  logout: vi.fn(),
  loginStepOne: vi.fn(),
  loginStepTwo: vi.fn(),
}))

vi.mock('@/modules/wallet/depositQr', () => ({
  generateDepositQrDataUrl: vi.fn(),
}))

// The wallet views mount the market store (AssetValuation calls market.start), whose shared socket
// would otherwise open a REAL WebSocket (a jsdom/undici realm mismatch). Isolate the socket pool so
// no test in this suite ever connects out; the fake lease never fires events and never throws.
vi.mock('@/modules/ws/shared-socket', () => {
  const makeLease = (url: string) => ({
    url,
    state: 'closed' as const,
    isOpen: false,
    onMessage: () => () => undefined,
    onStateChange: () => () => undefined,
    registerChannel: () => undefined,
    unsubscribe: () => undefined,
    unsubscribeAll: () => undefined,
    request: (_channel: string, _params: Record<string, unknown>, options: { onSettle?: (outcome: string) => void }) => {
      options.onSettle?.('cancelled')
      return () => undefined
    },
    send: () => false,
    connect: () => undefined,
    release: () => undefined,
  })
  return {
    SOCKET_RELEASE_GRACE_MS: 15000,
    sharedSockets: {
      acquire: (url: string) => makeLease(url),
      closeAll: () => undefined,
      size: 0,
      leaseCount: () => 0,
    },
    SharedSocketPool: class {
      acquire = (url: string) => makeLease(url)
      closeAll = () => undefined
      size = 0
      leaseCount = () => 0
    },
  }
})

const WALLET_BASE = '/wallet-api/'

/** Client idempotency key shape the Rust wallet enforces (`buildWithdrawRequestBody`). */
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const publicInfo = {
  market: {
    coinList: {
      BTC: { showName: 'Bitcoin', showPrecision: 8 },
      ETH: { showName: 'Ether', showPrecision: 6 },
      USDT: { showName: 'Tether', showPrecision: 6, mainChainType: 1 },
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
  { coin: 'ETH', showName: 'Ether', available: '0', locked: '0', total: '0', btcValuation: '0', depositOpen: true, withdrawOpen: true, isFiat: false },
  { coin: 'USDT', showName: 'Tether', available: '100', locked: '0', total: '100', btcValuation: '100', depositOpen: true, withdrawOpen: true, isFiat: false },
]

const config: WithdrawConfig = {
  coin: 'USDT',
  feeMin: '0.1',
  feeMax: '1',
  withdrawMin: '10',
  withdrawMax: '5000',
  defaultFee: '0.5',
  chainTip: '',
  addresses: [{ id: '7', coin: 'USDT', address: 'Taddr', tag: '', label: 'saved', raw: 'Taddr' }],
}

const emptyHistory: HistoryPage = { count: 0, list: [] }

let pinia: Pinia
let host: HTMLDivElement
let apps: App[] = []

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  vi.stubEnv('VITE_WALLET_API_BASE', WALLET_BASE)
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  apps = []

  vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({ address: '', tag: '', hasTag: false, qrCode: '' })
  vi.mocked(walletApi.fetchWithdrawConfig).mockResolvedValue(config)
  vi.mocked(walletApi.fetchWithdrawHistory).mockResolvedValue(emptyHistory)
  vi.mocked(walletApi.fetchDepositHistory).mockResolvedValue(emptyHistory)
  vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([])
  vi.mocked(walletApi.submitWithdrawal).mockResolvedValue('')
  vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue(null)
  vi.mocked(walletApi.cancelWithdrawal).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendSmsCode).mockResolvedValue(undefined)
  vi.mocked(walletApi.sendEmailCode).mockResolvedValue(undefined)
  vi.mocked(authApi.fetchUserInfo).mockResolvedValue({ googleStatus: '1', isOpenMobileCheck: '0', email: 'u@example.com', authLevel: '1' })
  vi.mocked(depositQr.generateDepositQrDataUrl).mockImplementation(async address => `data:image/png;base64,LOCAL-${address}`)

  const market = useMarketStore()
  market.publicInfo = publicInfo
})

afterEach(() => {
  apps.forEach(app => app.unmount())
  disposePinia(pinia)
  vi.unstubAllEnvs()
  session.clear()
  document.body.innerHTML = ''
})

async function mount(render: () => ReturnType<typeof h>): Promise<void> {
  const Root = defineComponent({
    setup() {
      // Returning the function keeps the render reactive for prop changes driven by emits.
      return render
    },
  })
  const app = createApp(Root)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.mount(host)
  apps.push(app)
  await flush()
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

/** Balances the withdraw panel derives `withdrawOpen` / `normal_balance` from. */
function seedAccount(): void {
  const account = useAccountStore()
  account.data = {
    allCoinMap: {
      BTC: { normal_balance: '2', depositOpen: 1, withdrawOpen: 1 },
      ETH: { normal_balance: '0', depositOpen: 1, withdrawOpen: 1 },
      USDT: { normal_balance: '100', depositOpen: 1, withdrawOpen: 1 },
    },
  }
}

function authenticate(): void {
  session.setToken('synthetic-wallet-session')
  // Google-only account: the mobile/email channels stay out of the requirement matrix.
  session.setUser({ id: 1, googleStatus: '1', isOpenMobileCheck: '0', email: '', authLevel: 1 })
  // Must run *after* the session change: the account store clears itself on a token change.
  seedAccount()
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  if (found === undefined) {
    throw new Error(`Missing button "${text}" in: ${host.textContent ?? ''}`)
  }
  return found
}

function inputByLabel(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (found === null) {
    throw new Error(`Missing input "${label}" in: ${host.textContent ?? ''}`)
  }
  return found
}

function byTestId<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  const found = document.body.querySelector<T>(`[data-testid="${id}"]`)
  if (found === null) throw new Error(`Missing ${id} in: ${document.body.textContent ?? ''}`)
  return found
}

async function pickSaved(id: string): Promise<void> {
  byTestId('saved-toggle').click()
  await flush()
  const option = document.body.querySelector<HTMLElement>(`[data-address-id="${id}"]`)
  if (option === null) throw new Error(`Missing saved ${id}`)
  option.click()
  await flush()
}

async function setAddress(value: string): Promise<void> {
  const area = byTestId<HTMLTextAreaElement>('withdraw-address')
  area.value = value
  area.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

async function review(): Promise<void> {
  byTestId('withdraw-submit').click()
  await flush()
}

async function confirm(): Promise<void> {
  byTestId('confirm-withdraw').click()
  await flush()
}

/** Dismiss the review dialog without submitting (the confirm dialog's explicit Cancel). */
async function closeReview(): Promise<void> {
  const cancel = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Cancel')
  if (cancel === undefined) throw new Error('Missing review Cancel button')
  cancel.click()
  await flush()
}

async function setInput(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('assets view', () => {
  it('routes the deposit shortcut to deposits instead of withdrawals', async () => {
    authenticate()
    vi.spyOn(useAccountStore(), 'load').mockResolvedValue(undefined)
    // The grouped overview requests a fresh read; keep this navigation test's
    // synthetic snapshot and never let its refresh reach an HTTP transport.
    vi.spyOn(useAccountStore(), 'refresh').mockResolvedValue(undefined)
    await mount(() => h(AssetsView))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Deposit BTC"]')
    expect(button).not.toBeNull()
    button!.click()
    await flush()
    expect(host.querySelector('#wallet-panel-deposit')).not.toBeNull()
    expect(host.querySelector('#wallet-panel-withdraw')).toBeNull()
  })

  it('shows the sign-in gate and issues no wallet request while unauthenticated', async () => {
    await mount(() => h(AssetsView))
    await flush()

    expect(host.textContent).toContain('Sign in to view balances and transfers')
    expect(walletApi.fetchWithdrawConfig).not.toHaveBeenCalled()
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })
})

describe('deposit panel', () => {
  it('uses per-asset deposit eligibility for both network choices and the coin picker', async () => {
    authenticate()
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue(normalizeWalletNetworks({ networks: [
      { network: 'BSC', coins: ['BTC', 'USDT'], assets: [
        { coin: 'BTC', depositEnabled: false, withdrawEnabled: true },
        { coin: 'USDT', depositEnabled: false, withdrawEnabled: true },
      ] },
      { network: 'TRC20', coins: ['USDT'], assets: [
        { coin: 'USDT', depositEnabled: true, withdrawEnabled: false },
      ] },
    ] }))
    const selectedCoin = ref('BTC')
    await mount(() => h(DepositPanel, { coin: selectedCoin.value, coins }))
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
    byTestId<HTMLButtonElement>('coin-picker-trigger').click()
    await flush()
    expect([...host.querySelectorAll('[role="option"]')].map(row => row.getAttribute('data-coin'))).toEqual(['USDT'])

    selectedCoin.value = 'USDT'
    await flush()
    expect(walletApi.fetchDepositAddress).toHaveBeenCalledExactlyOnceWith('USDT', expect.objectContaining({ network: 'TRC20' }))
  })

  it('does not offer or request an unsupported current coin after a native directory arrives', async () => {
    authenticate()
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue([{
      network: 'BNBCHAIN-MAINNET', displayName: 'BNB Chain', coins: ['USDT'],
      addressRegex: '', needMemo: false, tokenContracts: {}, checksum: '',
    }])
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
    byTestId<HTMLButtonElement>('coin-picker-trigger').click()
    await flush()
    expect([...host.querySelectorAll('[role="option"]')].map(row => row.getAttribute('data-coin'))).toEqual(['USDT'])
  })

  it('uses the native supported network when the retired deposit flag is closed', async () => {
    authenticate()
    useAccountStore().data = { allCoinMap: { BTC: { normal_balance: '2', depositOpen: 0 } } }
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue([{
      network: 'BITCOIN-MAINNET', displayName: 'Bitcoin', coins: ['BTC'],
      addressRegex: '', needMemo: false, tokenContracts: {}, checksum: '',
    }])
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    expect(walletApi.fetchDepositAddress).toHaveBeenCalledWith('BTC', expect.objectContaining({ network: 'BITCOIN-MAINNET' }))
    expect(host.textContent).not.toContain('Deposits are disabled')
  })

  it('does not confuse the disabled savings product with crypto deposits', async () => {
    authenticate()
    useMarketStore().publicInfo = { ...publicInfo, switch: { is_deposit_open: '0' } } as unknown as PublicInfoV4
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({ address: 'owned-address', tag: '', hasTag: false, qrCode: '' })
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    expect(walletApi.fetchDepositAddress).toHaveBeenCalled()
    expect(host.querySelector('[data-testid="deposit-address"]')?.textContent).toBe('owned-address')
  })

  it('keeps a safe server QR and falls back to a locally generated raster for an unsafe QR URL', async () => {
    authenticate()
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({ address: 'synthetic-address', tag: '', hasTag: false, qrCode: 'https://third-party.invalid/qr.png' })
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    expect(depositQr.generateDepositQrDataUrl).toHaveBeenCalledWith('synthetic-address')
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,LOCAL-synthetic-address')
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({ address: 'synthetic-address', tag: '', hasTag: false, qrCode: 'data:image/png;base64,AAAA' })
    buttonByText('Refresh').click()
    await flush()
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('shows the backend network, chain, token contract and confirmations when supplied', async () => {
    authenticate()
    // Single-chain projection: the panel must use the backend network name, not infer one from the symbol.
    useMarketStore().publicInfo = {
      market: {
        coinList: {
          USDT: { showName: 'Tether', showPrecision: 6 },
        },
      },
    } as unknown as PublicInfoV4
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      tag: '',
      hasTag: false,
      qrCode: '',
      networkName: 'BNB Smart Chain (BEP-20)',
      chainId: 56,
      tokenContract: '0x55d398326f99059fF775485246999027B3197955',
      confirmations: 64,
    })

    await mount(() => h(DepositPanel, { coin: 'USDT', coins }))

    expect(host.querySelector('select[aria-label="Network"]')).toBeNull()
    expect(host.querySelector('[data-testid="deposit-network"]')?.textContent).toContain('BNB Smart Chain (BEP-20)')
    expect(host.querySelector('[data-testid="deposit-chain-id"]')?.textContent).toContain('56')
    expect(host.querySelector('[data-testid="deposit-token-contract"]')?.textContent).toContain('0x55d398326f99059fF775485246999027B3197955')
    expect(host.querySelector('[data-testid="deposit-confirmations"]')?.textContent).toContain('64')
    expect(host.textContent).not.toContain('Ethereum')
    expect(host.textContent).not.toContain('ERC20')
  })

  it('clears the old address while a replacement address is loading', async () => {
    authenticate()
    const coin = ref('BTC')
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValueOnce({ address: 'old-address', tag: '', hasTag: false, qrCode: '' })
    await mount(() => h(DepositPanel, { coin: coin.value, coins }))
    expect(host.textContent).toContain('old-address')
    const pending = deferred<DepositAddress>()
    vi.mocked(walletApi.fetchDepositAddress).mockReturnValue(pending.promise)
    coin.value = 'ETH'
    await flush()
    expect(host.textContent).not.toContain('old-address')
    pending.resolve({ address: 'new-address', tag: '', hasTag: false, qrCode: '' })
    await flush()
    expect(host.textContent).toContain('new-address')
  })

  it('ignores a late address after deposits are disabled', async () => {
    authenticate()
    const pending = deferred<DepositAddress>()
    vi.mocked(walletApi.fetchDepositAddress).mockReturnValue(pending.promise)
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    useAccountStore().data = { allCoinMap: { BTC: { depositOpen: 0 } } }
    await flush()
    pending.resolve({ address: 'late-address', tag: '', hasTag: false, qrCode: '' })
    await flush()
    expect(host.textContent).not.toContain('late-address')
    expect(host.textContent).toContain('Deposits are disabled')
  })

  it('blocks deposit address requests when the coin flag is unknown', async () => {
    authenticate()
    useAccountStore().data = { allCoinMap: { BTC: { normal_balance: '1' } } }
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Deposit availability is unknown')
  })
  it('renders the split deposit address with its memo/tag', async () => {
    authenticate()
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({ address: 'rAddr', tag: 'memo1', hasTag: true, qrCode: '' })
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))

    expect(host.querySelector('[data-testid="deposit-address"]')?.textContent).toBe('rAddr')
    expect(host.querySelector('[data-testid="deposit-tag"]')?.textContent).toBe('memo1')
  })

  it('shows the generating state for PROVISIONING, polls on its own, then reveals the address once READY', async () => {
    authenticate()
    vi.mocked(walletApi.fetchDepositAddress).mockResolvedValue({
      address: '', tag: '', hasTag: false, qrCode: '', status: 'PROVISIONING',
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'], shouldAdvanceTime: true })
    try {
      await mount(() => h(DepositPanel, { coin: 'BTC', coins }))

      // Generating state with the elapsed counter; nothing address-like is rendered.
      expect(byTestId('deposit-provisioning').textContent).toContain('Generating your address')
      expect(host.textContent).toContain('Waiting 0:0')
      expect(host.querySelector('[data-testid="deposit-address"]')).toBeNull()
      expect(host.querySelector('[data-testid="deposit-qr"]')).toBeNull()
      expect(host.querySelector('[data-testid="deposit-tag"]')).toBeNull()
      expect(depositQr.generateDepositQrDataUrl).not.toHaveBeenCalled()
      expect(host.textContent).not.toContain('did not return a deposit address')
      // No manual button in the normal phase: the page re-checks by itself.
      expect(host.querySelector('[data-testid="deposit-provisioning-retry"]')).toBeNull()

      // First automatic re-check after 3 s turns READY: the address appears with the "ready" confirmation.
      const callsBefore = vi.mocked(walletApi.fetchDepositAddress).mock.calls.length
      vi.mocked(walletApi.fetchDepositAddress).mockResolvedValueOnce({
        address: 'bc1qready', tag: '', hasTag: false, qrCode: '', status: 'READY',
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await flush()

      expect(vi.mocked(walletApi.fetchDepositAddress).mock.calls.length).toBe(callsBefore + 1)
      expect(host.querySelector('[data-testid="deposit-address"]')?.textContent).toBe('bc1qready')
      expect(host.querySelector('[data-testid="deposit-provisioning"]')).toBeNull()
      expect(host.textContent).toContain('Address ready')

      // READY stops the polling.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.mocked(walletApi.fetchDepositAddress).mock.calls.length).toBe(callsBefore + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the blocked reason and sends nothing when the wallet gateway is not configured', async () => {
    authenticate()
    vi.stubEnv('VITE_WALLET_API_BASE', '')
    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))

    expect(host.textContent).toContain('wallet gateway is not configured')
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
  })

  it('shows the server reason and sends nothing when the coin disables deposits', async () => {
    authenticate()
    const account = useAccountStore()
    account.data = { allCoinMap: { BTC: { normal_balance: '1', depositOpen: 0 } } }

    await mount(() => h(DepositPanel, { coin: 'BTC', coins }))

    expect(host.textContent).toContain('Deposits are disabled for this coin')
    expect(walletApi.fetchDepositAddress).not.toHaveBeenCalled()
  })

  it('discards a stale address response after the coin changed', async () => {
    authenticate()
    const coin = ref('BTC')
    const btc = deferred<DepositAddress>()
    const eth = deferred<DepositAddress>()
    vi.mocked(walletApi.fetchDepositAddress).mockImplementation((target: string) =>
      target === 'BTC' ? btc.promise : eth.promise)

    await mount(() => h(DepositPanel, {
      coin: coin.value,
      coins,
      'onUpdate:coin': (next: string) => {
        coin.value = next
      },
    }))

    byTestId('coin-picker-trigger').click()
    await flush()
    document.body.querySelector<HTMLElement>('[role="option"][data-coin="ETH"]')!.click()
    await flush()

    eth.resolve({ address: 'eth-address', tag: '', hasTag: false, qrCode: '' })
    await flush()
    btc.resolve({ address: 'btc-address', tag: '', hasTag: false, qrCode: '' })
    await flush()

    expect(host.querySelector('[data-testid="deposit-address"]')?.textContent).toBe('eth-address')
  })
})

describe('withdraw panel (historical per-coin backend)', () => {
  it('sends one verification code request and ignores its result after logout', async () => {
    authenticate()
    session.setUser({ id: 1, googleStatus: 1, isOpenMobileCheck: 0, email: 'synthetic@example.invalid' })
    const pending = deferred<void>()
    vi.mocked(walletApi.sendEmailCode).mockReturnValue(pending.promise)
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    buttonByText('Send code').click()
    buttonByText('Send code').click()
    await flush()
    expect(walletApi.sendEmailCode).toHaveBeenCalledTimes(1)
    session.clear()
    await flush()
    pending.resolve()
    await flush()
    expect(document.body.textContent).not.toContain('Code sent')
    expect(document.body.textContent).not.toContain('Resend in')
  })

  it('never submits on load or review; the request fires only on explicit confirm with codes', async () => {
    authenticate()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()

    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()

    // The Google code is required, so the confirm button stays disabled.
    expect(byTestId('confirm-withdraw').disabled).toBe(true)
    await confirm()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()

    await setInput(inputByLabel('Google code'), '123456')
    await confirm()

    expect(walletApi.submitWithdrawal).toHaveBeenCalledTimes(1)
    // Historical body shape is unchanged: no network, no raw address; the idempotency key is a UUID.
    expect(walletApi.submitWithdrawal).toHaveBeenCalledWith({
      requestId: expect.stringMatching(REQUEST_ID_RE),
      symbol: 'USDT',
      addressId: '7',
      // Gross amount, not the computed net (CIAO derives payAmount = amount - fee).
      amount: '20',
      fee: '0.5',
      googleCode: '123456',
      smsAuthCode: '',
      emailValidCode: '',
    })
    expect(byTestId('withdraw-result').textContent).toContain('Withdrawal request submitted')
  })

  it('keeps the same requestId after a timeout when the unchanged draft is closed and retried', async () => {
    authenticate()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')

    // First attempt: a timeout leaves the confirm dialog open with the draft (money fields) untouched.
    vi.mocked(walletApi.submitWithdrawal).mockRejectedValueOnce(new ApiError({ kind: 'timeout', code: '', message: 'timed out' }))
    await confirm()
    const first = vi.mocked(walletApi.submitWithdrawal).mock.calls[0]?.[0]
    expect(first?.requestId).toMatch(REQUEST_ID_RE)

    // Close the review and reopen the SAME draft: the idempotency key must survive the timeout.
    await closeReview()
    await review()
    await setInput(inputByLabel('Google code'), '123456')
    await confirm()

    const calls = vi.mocked(walletApi.submitWithdrawal).mock.calls
    expect(calls).toHaveLength(2)
    const second = calls[1]?.[0]
    expect(second?.requestId).toBe(first?.requestId)
    // The money fields and the target are identical across the retry.
    expect(second).toMatchObject({
      symbol: first!.symbol,
      addressId: first!.addressId,
      amount: first!.amount,
      fee: first!.fee,
    })
  })

  it('blocks the form entirely when the wallet gateway is not configured', async () => {
    authenticate()
    vi.stubEnv('VITE_WALLET_API_BASE', '')
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))

    expect(document.body.textContent).toContain('wallet gateway is not configured')
    expect(byTestId('withdraw-submit').disabled).toBe(true)
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    expect(document.body.querySelector('[data-testid="confirm-withdraw"]')).toBeNull()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })

  it('blocks submission when the account security flags are unknown (no 2FA factor)', async () => {
    session.setToken('synthetic-wallet-session')
    session.setUser({ id: 1 })
    seedAccount()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))

    expect(document.body.textContent).toContain('security settings are unknown')
    expect(byTestId('withdraw-submit').disabled).toBe(true)
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })

  it('blocks submission when the server did not report the withdraw flag', async () => {
    authenticate()
    useAccountStore().data = { allCoinMap: { USDT: { normal_balance: '100' } } }
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))

    expect(document.body.textContent).toContain('withdraw flag')
    expect(byTestId('withdraw-submit').disabled).toBe(true)
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })

  it('clears the typed address and config when the network changes', async () => {
    authenticate()
    vi.mocked(walletApi.fetchWithdrawConfig).mockImplementation(async (coin: string) =>
      coin === 'USDTETH' ? { ...config, coin: 'USDTETH', addresses: [] } : config)
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    expect(byTestId<HTMLTextAreaElement>('withdraw-address').value).toBe('Taddr')

    document.body.querySelector<HTMLButtonElement>('[role="radio"][data-network="USDTETH"]')!.click()
    await flush()
    await flush()

    // The address belongs to the previous chain and must not survive the switch.
    expect(byTestId<HTMLTextAreaElement>('withdraw-address').value).toBe('')
    expect(vi.mocked(walletApi.fetchWithdrawConfig).mock.calls.at(-1)?.[0]).toBe('USDTETH')
  })

  it('never offers a direct-address withdrawal on the historical backend', async () => {
    authenticate()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await setAddress('TnewAddressNotSaved')
    await setInput(inputByLabel('Withdrawal amount'), '20')

    expect(byTestId('address-status').textContent).toContain('only withdraws to address-book entries')
    await review()
    expect(document.body.querySelector('[data-testid="confirm-withdraw"]')).toBeNull()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })

  it('invalidates the review when the amount changes after review', async () => {
    authenticate()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')

    await setInput(inputByLabel('Withdrawal amount'), '25')
    await flush()

    expect(document.body.querySelector('[data-testid="confirm-withdraw"]')).toBeNull()
    expect(document.body.querySelector('input[aria-label="Google code"]')).toBeNull()
    expect(walletApi.submitWithdrawal).not.toHaveBeenCalled()
  })

  it('does not send a second request while the first one is pending', async () => {
    authenticate()
    const pending = deferred<string>()
    vi.mocked(walletApi.submitWithdrawal).mockReturnValue(pending.promise)
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')

    await confirm()
    expect(byTestId('confirm-withdraw').textContent).toContain('Submitting')
    await confirm()

    expect(walletApi.submitWithdrawal).toHaveBeenCalledTimes(1)
    pending.resolve('1')
    await flush()
  })

  it('discards a stale submit result after the session is dropped', async () => {
    authenticate()
    const pending = deferred<string>()
    vi.mocked(walletApi.submitWithdrawal).mockReturnValue(pending.promise)
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')
    await confirm()

    const historyCallsBefore = vi.mocked(walletApi.fetchWithdrawHistory).mock.calls.length

    session.clear()
    await flush()
    pending.resolve('9')
    await flush()

    // No success state, no follow-up reads from the stale result.
    expect(document.body.textContent).not.toContain('Withdrawal request submitted')
    expect(vi.mocked(walletApi.fetchWithdrawHistory).mock.calls.length).toBe(historyCallsBefore)
  })

  it('keeps the draft but wipes one-time codes when the server rejects the request', async () => {
    authenticate()
    vi.mocked(walletApi.submitWithdrawal).mockRejectedValueOnce(new Error('withdraw rejected'))
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')
    await confirm()

    expect(inputByLabel('Withdrawal amount').value).toBe('20')
    expect(inputByLabel('Google code').value).toBe('')
    expect(document.body.textContent).toContain('withdraw rejected')
  })

  it('never renders a javascript: explorer link', async () => {
    authenticate()
    vi.mocked(walletApi.fetchWithdrawHistory).mockResolvedValue({
      count: 1,
      list: [{
        id: '1', coin: 'USDT', amount: '5', fee: '0.5', address: 'Taddr', tag: '', txid: '',
        txidUrl: 'javascript:alert(1)', label: '', status: '0', statusText: 'pending',
        confirmDesc: '', createdAt: '2026-01-01', walletTime: '',
      }],
    })
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))

    const hrefs = [...document.body.querySelectorAll('a')].map(anchor => anchor.getAttribute('href') ?? '')
    expect(hrefs.some(href => href.startsWith('javascript:'))).toBe(false)
  })

  it('drops the draft and the one-time codes when the session changes', async () => {
    authenticate()
    await mount(() => h(WithdrawPanel, { coin: 'USDT', coins }))
    await pickSaved('7')
    await setInput(inputByLabel('Withdrawal amount'), '20')
    await review()
    await setInput(inputByLabel('Google code'), '123456')

    session.clear()
    await flush()
    // Re-authentication must not restore the previous draft or the codes.
    authenticate()
    await flush()

    expect(inputByLabel('Withdrawal amount').value).toBe('')
    expect(byTestId<HTMLTextAreaElement>('withdraw-address').value).toBe('')
    expect(document.body.querySelector('input[aria-label="Google code"]')).toBeNull()
  })
})

describe('withdraw panel (contract v2, per network)', () => {
  const BSC = {
    network: 'BSC', displayName: 'BNB Smart Chain (BEP-20)', coins: ['USDC'], addressRegex: '^0x[0-9a-fA-F]{40}$',
    needMemo: false, tokenContracts: {}, checksum: 'EIP-55', chainId: 56,
  }
  const SAVED = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
  const NEW = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const usdcCoins: CoinRow[] = [{ coin: 'USDC', showName: 'USDC', available: '0.0456', locked: '0', total: '0.0456', btcValuation: '0', depositOpen: true, withdrawOpen: true, isFiat: false }]
  const v2Config: WithdrawConfig = {
    coin: 'USDC', feeMin: '0', feeMax: '0', withdrawMin: '0.001', withdrawMax: '0.01', defaultFee: '0', chainTip: '', addresses: [],
    network: 'BSC', dailyRemaining: '0.049', autoApprovalThreshold: '0.002', withdrawOpen: true, precision: 6,
  }

  function seedUsdc(user: Record<string, unknown> = {}): void {
    session.setToken('synthetic-wallet-session')
    session.setUser({ id: 1, googleStatus: '1', isOpenMobileCheck: '0', email: 'u@example.invalid', authLevel: 1, ...user })
    useAccountStore().data = { allCoinMap: { USDC: { normal_balance: '0.0456', depositOpen: 1, withdrawOpen: 1 } } }
    useMarketStore().publicInfo = { market: { coinList: { USDC: { showName: 'USDC', showPrecision: 8 } } } } as unknown as PublicInfoV4
  }

  beforeEach(() => {
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue([BSC])
    vi.mocked(walletApi.fetchWithdrawConfig).mockResolvedValue(v2Config)
    vi.mocked(walletApi.fetchAddressBook).mockResolvedValue([
      { id: '12', coin: 'USDC', address: SAVED, tag: '', label: 'ledger', raw: SAVED, network: 'BSC' },
    ])
  })

  it('reads the v2 config and book for the network and shows fee, receive and daily remaining', async () => {
    seedUsdc()
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))

    expect(vi.mocked(walletApi.fetchWithdrawConfig).mock.calls[0]).toEqual(['USDC', expect.objectContaining({ network: 'BSC' })])
    expect(vi.mocked(walletApi.fetchAddressBook).mock.calls[0]?.[0]).toEqual({ network: 'BSC' })
    await setInput(inputByLabel('Withdrawal amount'), '0.0015')
    expect(byTestId('withdraw-receive').textContent).toContain('0.0015')
    expect(byTestId('daily-remaining').textContent).toContain('0.049')
    expect(byTestId('withdraw-fee').textContent).toContain('0 USDC')
  })

  it('saved address: Google code only, addressId + network sent, auto-approval hint', async () => {
    seedUsdc()
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await pickSaved('12')
    await setInput(inputByLabel('Withdrawal amount'), '0.002')

    expect(byTestId('address-status').textContent).toContain('Google code only')
    expect(byTestId('approval-hint').textContent).toContain('auto-approval')
    await review()
    expect(document.body.querySelector('input[aria-label="Email code"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="save-to-book"]')).toBeNull()
    await setInput(inputByLabel('Google code'), '123456')
    await confirm()

    expect(walletApi.submitWithdrawal).toHaveBeenCalledWith({
      requestId: expect.stringMatching(REQUEST_ID_RE),
      symbol: 'USDC', addressId: '12', amount: '0.002', fee: '0', googleCode: '123456', smsAuthCode: '', emailValidCode: '', network: 'BSC',
    })
  })

  it('a pasted address that is already saved (any case) counts as saved', async () => {
    seedUsdc()
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await setAddress(SAVED.toLowerCase())
    expect(byTestId('address-status').textContent).toContain('Saved address')
  })

  it('direct address: Google + email, optional save with label, manual approval unless saved', async () => {
    seedUsdc()
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await setAddress(NEW)
    await setInput(inputByLabel('Withdrawal amount'), '0.002')

    expect(byTestId('address-status').textContent).toContain('Google + email')
    expect(byTestId('approval-hint').textContent).toContain('dual manual approval')
    await review()
    expect(inputByLabel('Email code')).toBeDefined()
    const save = byTestId<HTMLInputElement>('save-to-book')
    save.click()
    await flush()
    expect(byTestId('confirm-approval').textContent).toContain('auto-approval')
    await setInput(inputByLabel('Label'), 'new wallet')
    await setInput(inputByLabel('Google code'), '123456')
    expect(byTestId('confirm-withdraw').disabled).toBe(true)
    await setInput(inputByLabel('Email code'), '654321')
    await confirm()

    expect(walletApi.submitWithdrawal).toHaveBeenCalledWith({
      requestId: expect.stringMatching(REQUEST_ID_RE),
      symbol: 'USDC', addressId: '', amount: '0.002', fee: '0', googleCode: '123456', smsAuthCode: '', emailValidCode: '654321',
      network: 'BSC', address: NEW, saveAddress: true, label: 'new wallet',
    })
  })

  it('direct address on a mobile-only account asks for the SMS code instead of email', async () => {
    seedUsdc({ email: '', isOpenMobileCheck: '1' })
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await setAddress(NEW)
    await setInput(inputByLabel('Withdrawal amount'), '0.002')
    await review()
    expect(document.body.querySelector('input[aria-label="Email code"]')).toBeNull()
    expect(inputByLabel('SMS code')).toBeDefined()
  })

  it('blocks a direct address with a bad EIP-55 checksum', async () => {
    seedUsdc()
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await setAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    await setInput(inputByLabel('Withdrawal amount'), '0.002')

    expect(byTestId('address-status').textContent).toContain('Checksum mismatch')
    await review()
    expect(document.body.querySelector('[data-testid="confirm-withdraw"]')).toBeNull()
  })

  it('shows the mapped message for a contract error code', async () => {
    seedUsdc()
    vi.mocked(walletApi.submitWithdrawal).mockRejectedValueOnce(new ApiError({ kind: 'api', code: '10053', message: 'raw' }))
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    await pickSaved('12')
    await setInput(inputByLabel('Withdrawal amount'), '0.002')
    await review()
    await setInput(inputByLabel('Google code'), '123456')
    await confirm()
    expect(document.body.textContent).toContain('Platform addresses are not allowed')
  })

  it('blocks when the v2 config reports withdrawOpen = false', async () => {
    seedUsdc()
    vi.mocked(walletApi.fetchWithdrawConfig).mockResolvedValue({ ...v2Config, withdrawOpen: false })
    await mount(() => h(WithdrawPanel, { coin: 'USDC', coins: usdcCoins }))
    expect(document.body.textContent).toContain('Withdrawals are disabled')
    expect(byTestId('withdraw-submit').disabled).toBe(true)
  })
})

describe('records panel', () => {
  it('renders a cancel action only for the exact server status "0"', async () => {
    authenticate()
    const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
      id: '1', coin: 'USDT', amount: '5', fee: '0.5', address: 'Taddr', tag: '', txid: '', txidUrl: '',
      label: '', status: '0', statusText: 'pending', confirmDesc: '', createdAt: '2026-01-01', walletTime: '',
      ...overrides,
    })
    vi.mocked(walletApi.fetchWithdrawHistory).mockResolvedValue({
      count: 2,
      list: [entry({ id: '1' }), entry({ id: '2', status: '1', statusText: 'done', createdAt: '2026-01-02' })],
    })
    await mount(() => h(RecordsPanel, { coins, initialKind: 'withdraw' }))

    const cancelButtons = [...host.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Cancel')
    expect(cancelButtons).toHaveLength(1)
  })

  it('links BSC hashes to BscScan only when the network is known, and never a javascript: URL', async () => {
    authenticate()
    vi.mocked(walletApi.fetchWalletNetworks).mockResolvedValue([{
      network: 'BSC', displayName: 'BSC', coins: ['USDC'], addressRegex: '', needMemo: false, tokenContracts: {}, checksum: '',
    }])
    const hash = `0x${'a'.repeat(64)}`
    const base: HistoryEntry = {
      id: '1', coin: 'USDC', amount: '0.002', fee: '0', address: '0xabc', tag: '', txid: hash, txidUrl: '', label: '',
      status: '5', statusText: '', confirmDesc: '', createdAt: '2026-01-01', walletTime: '', rawStatus: '5',
    }
    vi.mocked(walletApi.fetchWithdrawHistory).mockResolvedValue({
      count: 3,
      list: [base, { ...base, id: '2', coin: 'BTC', txid: hash }, { ...base, id: '3', txidUrl: 'javascript:alert(1)', txid: '' }],
    })
    await mount(() => h(RecordsPanel, { coins, initialKind: 'withdraw' }))
    const hrefs = [...host.querySelectorAll('a')].map(anchor => anchor.getAttribute('href') ?? '')
    expect(hrefs).toEqual([`https://bscscan.com/tx/${hash}`])
    expect(host.textContent).toContain('Completed')
  })
})

describe('wallet records lifecycle', () => {
  it('ignores a late history response after logout', async () => {
    authenticate()
    const pending = deferred<HistoryPage>()
    vi.mocked(walletApi.fetchDepositHistory).mockReturnValue(pending.promise)
    await mount(() => h(RecordsPanel, { coins }))
    session.clear()
    await flush()
    pending.resolve({ count: 1, list: [{ id: '1', coin: 'OLDCOIN', amount: '1', fee: '', address: '', tag: '', txid: '', txidUrl: '', label: '', status: '', statusText: 'old-success', confirmDesc: '', createdAt: '2026-01-01', walletTime: '' }] })
    await flush()
    expect(host.textContent).not.toContain('OLDCOIN')
    expect(host.textContent).not.toContain('old-success')
  })
})

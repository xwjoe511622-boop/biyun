// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import AssetsView from '@/views/AssetsView.vue'
import InternalTransferPanel from '@/components/wallet/InternalTransferPanel.vue'
import { session } from '@/core/session'
import { ApiError } from '@/core/errors'
import { request } from '@/modules/api/http'
import { fetchFapiAccount, type FapiAccount } from '@/modules/futures/fapi'
import { fetchAssets } from '@/modules/futures/api'
import { createTransfer, listTransferHistory, loadTransferConfig, previewTransfer } from '@/modules/api/internal-transfer.api'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useMarginStore } from '@/stores/margin'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('@/modules/api/http', async original => ({ ...await original<typeof import('@/modules/api/http')>(), request: vi.fn() }))
vi.mock('@/modules/futures/fapi', async original => ({ ...await original<typeof import('@/modules/futures/fapi')>(), fetchFapiAccount: vi.fn() }))
vi.mock('@/modules/futures/api', async original => ({ ...await original<typeof import('@/modules/futures/api')>(), fetchAssets: vi.fn() }))
vi.mock('@/modules/api/internal-transfer.api', async original => ({
  ...await original<typeof import('@/modules/api/internal-transfer.api')>(),
  loadTransferConfig: vi.fn(), listTransferHistory: vi.fn(), createTransfer: vi.fn(), previewTransfer: vi.fn(),
}))
// This emits only the existing completion event; it never executes a transfer.
vi.mock('@/components/transfer/TransferDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ emits: ['transferred'], setup: (_, { emit }) => () => h('button', { 'data-testid': 'mock-transfer-completed', onClick: () => emit('transferred') }, 'Completed transfer') }) }
})
vi.mock('@/components/margin/MarginAccountsPanel.vue', () => ({ default: { template: '<div data-testid="mock-margin-panel" />' } }))

let pinia: Pinia
let app: App | undefined
let host: HTMLDivElement
let spot = '0.1'
let account: ReturnType<typeof useAccountStore>
let accountLoad: ReturnType<typeof vi.spyOn>

function seedSpot(): void {
  account.data = { allCoinMap: { USDT: { normal_balance: spot, lock_balance: '0', total_balance: spot, btcValuatin: spot, depositOpen: 1, withdrawOpen: 1 } } }
}
function futures(amount: string): FapiAccount {
  return { positions: [], assets: [{ asset: 'USDT', walletBalance: amount, unrealizedProfit: '0', marginBalance: amount,
    maintMargin: '0', initialMargin: '0', positionInitialMargin: '0', openOrderInitialMargin: '0', crossWalletBalance: amount,
    crossUnPnl: '0', availableBalance: amount, maxWithdrawAmount: amount }] }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() }
}
async function mount(component: Component, locale = 'en-US'): Promise<void> {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: locale, messages: { 'en-US': enUS, 'zh-CN': zhCN } })
  changeLocale = value => { i18n.global.locale.value = value }
  app = createApp(component).use(pinia).use(i18n)
  app.mount(host)
  await flush()
}
let changeLocale: (locale: 'zh-CN' | 'en-US') => void
function total(): string { return host.querySelector('[data-testid="valuation-total"]')?.textContent ?? '' }
function completeTransfer(): void { host.querySelector<HTMLButtonElement>('[data-testid="mock-transfer-completed"]')!.click() }
async function showUsdt(): Promise<void> {
  const unit = host.querySelector<HTMLSelectElement>('[data-testid="valuation-unit"]')!
  unit.value = 'USDT'; unit.dispatchEvent(new Event('change', { bubbles: true })); await flush()
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear(); sessionStorage.clear(); session.clear()
  session.setToken('synthetic-wallet-merge-session'); session.setUser({ id: 10000011 })
  pinia = createPinia(); setActivePinia(pinia)
  host = document.createElement('div'); document.body.append(host)
  // Any accidentally unmocked network path fails locally instead of contacting a real service.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network call')))
  const market = useMarketStore()
  market.publicInfo = { market: { coinList: { USDT: { showName: 'Tether', showPrecision: 16 } } } }
  vi.spyOn(market, 'start').mockReturnValue(() => undefined)
  account = useAccountStore(); spot = '0.1'; seedSpot()
  accountLoad = vi.spyOn(account, 'load').mockImplementation(async () => { seedSpot(); account.error = null })
  vi.spyOn(account, 'refresh').mockImplementation(() => account.load())
  vi.mocked(fetchFapiAccount).mockResolvedValue(futures('0.2'))
  vi.mocked(fetchAssets).mockRejectedValue(new Error('Futures read failed'))
  vi.mocked(request).mockImplementation(async path => {
    if (path === 'lever/finance/balance') return { portfolioHoldings: [] }
    throw new Error(`Unexpected API path: ${path}`)
  })
  vi.mocked(listTransferHistory).mockResolvedValue({ list: [], page: 1, pageSize: 50 })
})
afterEach(() => {
  app?.unmount(); app = undefined
  disposePinia(pinia); session.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('frontend engineer QA072 overview reload (real AssetsView/BalancesPanel)', () => {
  it('reloads spot, futures and margin after completion without double-counting moved assets', async () => {
    await mount(AssetsView); await showUsdt()
    expect(total()).toBe('0.30')
    spot = '0.2'; vi.mocked(fetchFapiAccount).mockResolvedValue(futures('0.1'))
    completeTransfer(); await flush()
    expect(accountLoad).toHaveBeenCalledTimes(2)
    expect(fetchFapiAccount).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith('lever/finance/balance', { body: {} })
    expect(total()).toBe('0.30') // 0.2 + 0.1 exactly; stale futures would display 0.40.
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps the previous complete total with a refresh label while the refreshed futures leg is pending', async () => {
    await mount(AssetsView); await showUsdt()
    let finish: (value: FapiAccount) => void = () => { throw new Error('Missing pending read') }
    vi.mocked(fetchFapiAccount).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    spot = '0.2'; completeTransfer(); await flush()
    expect(total()).toBe('0.30'); expect(host.textContent).toContain('Refreshing')
    finish(futures('0.1')); await flush()
    expect(total()).toBe('0.30')
  })
  it('keeps a failed refreshed account unknown instead of treating it as zero', async () => {
    await mount(AssetsView); await showUsdt()
    vi.mocked(fetchFapiAccount).mockRejectedValueOnce(new Error('Futures unavailable'))
    spot = '0.2'; completeTransfer(); await flush()
    expect(total()).toBe('--'); expect(host.textContent).toContain('Some account values are unavailable')
    expect(fetchAssets).toHaveBeenCalledOnce()
  })
  it('retains spot and margin refresh when the overview is unmounted', async () => {
    const marginLoad = vi.spyOn(useMarginStore(), 'loadOverview').mockResolvedValue(undefined)
    await mount(AssetsView)
    host.querySelector<HTMLButtonElement>('#wallet-tab-margin')!.click(); await flush()
    expect(host.querySelector('[data-testid="mock-margin-panel"]')).not.toBeNull()
    accountLoad.mockClear(); vi.mocked(fetchFapiAccount).mockClear()
    completeTransfer(); await flush()
    expect(accountLoad).toHaveBeenCalledOnce(); expect(marginLoad).toHaveBeenCalledOnce()
    expect(fetchFapiAccount).not.toHaveBeenCalled()
  })
})

describe('frontend engineer QA128 unavailable internal transfer (real panel)', () => {
  it.each([
    ['standalone', InternalTransferPanel],
    ['assets tab', AssetsView],
  ])('updates the existing refusal on language switches in %s without refetching', async (_, component) => {
    vi.mocked(loadTransferConfig).mockRejectedValue(new ApiError({ kind: 'api', code: 'INNER_TRANSFER_ERROR', message: '站内转账暂未开放' }))
    await mount(component, 'zh-CN')
    if (component === AssetsView) {
      host.querySelector<HTMLButtonElement>('#wallet-tab-internalTransfer')!.click()
      await flush()
    }
    expect(host.textContent).toContain('站内转账暂未开放')
    for (let round = 0; round < 2; round++) {
      changeLocale('en-US'); await flush()
      expect(host.textContent).toContain('Internal transfer is not available yet')
      expect(host.textContent).not.toContain('站内转账暂未开放')
      changeLocale('zh-CN'); await flush()
      expect(host.textContent).toContain('站内转账暂未开放')
      expect(host.textContent).not.toContain('Internal transfer is not available yet')
    }
    expect(loadTransferConfig).toHaveBeenCalledOnce()
    expect(host.querySelector('.state.error')).not.toBeNull()
    expect(host.querySelector('.state.error button')).toBeNull()
    expect(createTransfer).not.toHaveBeenCalled()
    expect(previewTransfer).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([
    ['en-US', 'Internal transfer is not available yet'],
    ['zh-CN', '站内转账暂未开放'],
  ])('shows the unavailable reason in %s without offering an action', async (locale, expected) => {
    vi.mocked(loadTransferConfig).mockRejectedValue(new ApiError({ kind: 'api', code: 'INNER_TRANSFER_ERROR', message: '站内转账暂未开放' }))
    await mount(InternalTransferPanel, locale)
    expect(host.textContent).toContain(expected)
    if (locale === 'en-US') expect(host.textContent).not.toContain('站内转账暂未开放')
    expect(host.querySelector('form')).toBeNull()
    expect(createTransfer).not.toHaveBeenCalled(); expect(previewTransfer).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves another specific refusal rather than calling every failure not open', async () => {
    vi.mocked(loadTransferConfig).mockRejectedValue(new ApiError({ kind: 'api', code: 'INNER_TRANSFER_ERROR', message: 'Fee configuration is invalid' }))
    await mount(InternalTransferPanel)
    expect(host.textContent).toContain('Fee configuration is invalid')
    expect(host.textContent).not.toContain('Internal transfer is not available yet')
    changeLocale('zh-CN'); await flush()
    expect(host.textContent).toContain('Fee configuration is invalid')
    expect(host.textContent).not.toContain('站内转账暂未开放')
    expect(createTransfer).not.toHaveBeenCalled()
  })
})

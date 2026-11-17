// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import AssetsView from '@/views/AssetsView.vue'
import { session } from '@/core/session'
import * as accountApi from '@/modules/api/account.api'
import type { PublicInfoV4 } from '@/modules/api/types'
import * as marginApi from '@/modules/margin/api'
import { normalizeAccountsOverview, normalizeSymbolAccount } from '@/modules/margin/normalize'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only: balances and margin accounts are mocked.
vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn(), fetchAccountBalanceV5: vi.fn() }))
vi.mock('@/modules/margin/api', () => ({ fetchMarginAccounts: vi.fn(), fetchMarginSymbolAccount: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The assets page boots the futures stores lazily when they ship; keep them offline here.
vi.mock('@/stores/futures-market', () => ({ useFuturesMarketStore: () => ({ loaded: true, loadPublicInfo: async () => undefined }) }))
const futuresOpen = vi.hoisted(() => ({ status: 'unopened' as string, error: null as string | null, initFailed: false }))
const ensureOpened = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/stores/futures-account', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    available: '7',
    open: futuresOpen,
    refresh: async () => undefined,
    ensureOpened: async () => { ensureOpened.calls += 1; store.open.status = 'opened'; return true },
  })
  return { useFuturesAccountStore: () => store }
})

/** Same existence probe the view uses: resolves to an empty map while the futures module has no panel. */
const FUTURES_PANEL_SHIPPED = Object.keys(import.meta.glob('../src/components/futures/FuturesAccountPanel.vue')).length > 0

let pinia: Pinia
let app: App | null = null
let host: HTMLDivElement

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  session.setToken('synthetic-assets-session')
  vi.mocked(accountApi.fetchAccountBalance).mockResolvedValue({ allCoinMap: { USDT: { normal_balance: '10' } } })
  vi.mocked(marginApi.fetchMarginAccounts).mockResolvedValue(normalizeAccountsOverview({
    totalBalance: '0.002', totalBalanceSymbol: 'BTC',
    leverMap: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', baseCoin: 'BTC', quoteCoin: 'USDT', riskRate: 125, burstPrice: 38000.5, quoteTotalBalance: 100, quoteBorrowBalance: 80, rate: 0.0005, multiple: 3 } },
  }))
  vi.mocked(marginApi.fetchMarginSymbolAccount).mockResolvedValue(
    normalizeSymbolAccount({ symbol: 'btcusdt', name: 'BTC/USDT', baseCoin: 'BTC', quoteCoin: 'USDT', quoteCanTransfer: 5 }) as MarginSymbolAccount,
  )
  useMarketStore().publicInfo = {
    switch: { lever_open: '1' },
    market: { coinList: {}, market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1 } } } },
  } as unknown as PublicInfoV4
})
afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(): Promise<void> {
  app = createApp(defineComponent({ setup: () => () => h(AssetsView) }))
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
}

describe('assets page margin integration', () => {
  it('adds a margin account tab showing risk per pair from lever/finance/balance', async () => {
    await mount()
    const tab = host.querySelector<HTMLButtonElement>('#wallet-tab-margin')
    expect(tab?.textContent).toContain('Margin')
    tab?.click()
    await flush()
    expect(marginApi.fetchMarginAccounts).toHaveBeenCalledTimes(1)
    const card = host.querySelector('[data-testid="margin-account-card"]')
    expect(card?.textContent).toContain('BTC/USDT')
    expect(card?.textContent).toContain('125%')
    expect(card?.textContent).toContain('Danger')
    expect(card?.textContent).toContain('38000.50')
  })

  it('offers the futures tab only when the futures module ships its account panel', async () => {
    await mount()
    const hasFuturesTab = host.querySelector('#wallet-tab-futures') !== null
    expect(hasFuturesTab).toBe(FUTURES_PANEL_SHIPPED)
  })

  it('opens the unified transfer dialog from the header action', async () => {
    await mount()
    host.querySelector<HTMLButtonElement>('[data-testid="assets-transfer"]')?.click()
    await flush()
    expect(document.body.querySelector('[data-testid="transfer-route"]')).not.toBeNull()
  })

  it('never asks to open futures on the assets page: an unopened account is created silently before the transfer', async () => {
    expect(FUTURES_PANEL_SHIPPED).toBe(true)
    futuresOpen.status = 'unopened'
    ensureOpened.calls = 0
    await mount()
    host.querySelector<HTMLButtonElement>('#wallet-tab-futures')?.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-testid="assets-transfer"]')?.click()
    await flush()
    expect(document.body.querySelector<HTMLSelectElement>('[data-testid="transfer-to"]')?.value).toBe('futures')
    expect(ensureOpened.calls).toBe(1)
    expect(document.body.querySelector('[data-testid="transfer-futures-gate"]')).toBeNull()
    expect(document.body.textContent ?? '').not.toMatch(/open a futures account|Enable futures|开通/)
    expect(document.body.querySelector('input[type="checkbox"]')).toBeNull()
  })
})

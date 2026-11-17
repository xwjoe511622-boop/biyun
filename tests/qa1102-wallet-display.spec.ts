// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import HomeBinance from '@/views/home/HomeBinance.vue'
import OkxHero from '@/components/home/okx/OkxHero.vue'
import BalancesPanel from '@/components/wallet/BalancesPanel.vue'
import { newSessionKey, session } from '@/core/session'
import { ApiError } from '@/core/errors'
import { request } from '@/modules/api/http'
import { fetchFapiAccount, type FapiAccount } from '@/modules/futures/fapi'
import { fetchAssets } from '@/modules/futures/api'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('@/modules/api/http', async original => ({ ...await original<typeof import('@/modules/api/http')>(), request: vi.fn() }))
vi.mock('@/modules/futures/fapi', async original => ({ ...await original<typeof import('@/modules/futures/fapi')>(), fetchFapiAccount: vi.fn() }))
vi.mock('@/modules/futures/api', async original => ({ ...await original<typeof import('@/modules/futures/api')>(), fetchAssets: vi.fn() }))
// Keep the actual home, wallet, and valuation components. Unrelated news, animation and market streams are inert.
vi.mock('@/components/home/fx/HomeSky.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/home/binance/HeroNewsCard.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/home/binance/use-home-markets', async original => {
  const { computed } = await import('vue')
  return { ...await original<typeof import('@/components/home/binance/use-home-markets')>(),
    useHomeMarkets: () => ({ spotRows: computed(() => []), futuresRows: computed(() => []), totalTurnover: computed(() => ''), maxLever: computed(() => 0) }),
    useOpenMarket: () => vi.fn(),
  }
})

let pinia: Pinia
let app: App | undefined
let host: HTMLDivElement
let spot = '0.1'
let account: ReturnType<typeof useAccountStore>
let accountLoad: ReturnType<typeof vi.spyOn>
function seedSpot(): void {
  account.data = { allCoinMap: { USDT: { normal_balance: spot, lock_balance: '0', total_balance: spot, btcValuatin: '', depositOpen: 1, withdrawOpen: 1 } } }
}
function futures(amount: string, asset = 'USDT'): FapiAccount {
  return { positions: [], assets: [{ asset, walletBalance: amount, unrealizedProfit: '0', marginBalance: amount,
    maintMargin: '0', initialMargin: '0', positionInitialMargin: '0', openOrderInitialMargin: '0', crossWalletBalance: amount,
    crossUnPnl: '0', availableBalance: amount, maxWithdrawAmount: amount }] }
}
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
async function showUsdt(): Promise<void> {
  const unit = host.querySelector<HTMLSelectElement>('[data-testid="valuation-unit"]')
  if (unit) { unit.value = 'USDT'; unit.dispatchEvent(new Event('change', { bubbles: true })); await flush() }
}
async function mount(component: Component, locale = 'en-US'): Promise<void> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/'); await router.isReady()
  app = createApp(component, component === OkxHero ? { rows: [], live: false } : {})
    .use(pinia).use(router).use(createI18n({ legacy: false, locale, fallbackLocale: locale, messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.mount(host); await flush()
  await showUsdt()
}
function total(): string { return host.querySelector('[data-testid="valuation-total"]')?.textContent ?? '' }

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); session.clear()
  session.setToken(newSessionKey()); session.setUser({ id: 10000011 })
  pinia = createPinia(); setActivePinia(pinia)
  host = document.createElement('div'); document.body.append(host)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')))
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const market = useMarketStore()
  market.publicInfo = { market: { coinList: { USDT: { showPrecision: 8, showName: 'Tether' } } } }
  vi.spyOn(market, 'start').mockReturnValue(() => undefined)
  vi.spyOn(market, 'loadTrends').mockImplementation(() => undefined)
  vi.spyOn(market, 'loadPublicInfo').mockResolvedValue(undefined)
  account = useAccountStore(); spot = '0.1'; seedSpot()
  accountLoad = vi.spyOn(account, 'load').mockImplementation(async () => { seedSpot(); account.error = null })
  vi.spyOn(account, 'refresh').mockImplementation(() => account.load())
  vi.mocked(fetchFapiAccount).mockResolvedValue(futures('0.2'))
  vi.mocked(fetchAssets).mockRejectedValue(new Error('Account read unavailable'))
  vi.mocked(request).mockImplementation(async path => {
    if (path === 'lever/finance/balance') return { portfolioHoldings: [{ coin: 'USDT', balance: '-0.05' }] }
    throw new Error(`Unexpected API path ${path}`)
  })
})
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); session.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('QA-213 authoritative asset row BTC valuation', () => {
  it.each(['en-US', 'zh-CN'])('revalues the current USDT holding with quotes and explicitly reports a missing quote in %s', async locale => {
    const market = useMarketStore()
    market.tickers = { btcusdt: { close: '2', open: '2', high: '2', low: '2', vol: '0', amount: '0', rose: '0' } }
    await mount(BalancesPanel, locale)
    const btcCell = () => host.querySelector('[data-testid="holding-btc-value"]')!
    expect(btcCell().textContent).toContain('0.05')
    expect(btcCell().textContent).not.toContain('Unavailable')
    // This authoritative row deliberately has no btcValuatin. Its current total remains the source.
    expect(account.allCoinMap?.USDT?.btcValuatin).toBe('')
    market.tickers = { btcusdt: { close: '4', open: '4', high: '4', low: '4', vol: '0', amount: '0', rose: '0' } }; await flush()
    expect(btcCell().textContent).toContain('0.025')
    market.tickers = {}; await flush()
    expect(btcCell().textContent).toContain(locale === 'en-US' ? 'Unavailable' : '暂无数据')
    expect(btcCell().getAttribute('title')).toContain(locale === 'en-US' ? 'market quote' : '行情')
    const visibility = host.querySelector<HTMLButtonElement>('.val-eye')!
    visibility.click(); await flush()
    try {
      expect(btcCell().textContent?.trim()).toBe('******')
      expect(btcCell().getAttribute('title')).toBeNull()
    } finally { visibility.click(); await flush() } // Restore the shared per-user preference for other readers.
  })
})

describe('QA-167 complete portfolio reads in real home/asset components', () => {
  it.each([['Binance home', HomeBinance], ['OKX home hero', OkxHero], ['assets overview', BalancesPanel]] as const)('%s uses the same exact spot + futures equity + net margin value', async (_, component) => {
    await mount(component)
    expect(total()).toBe('0.25') // 0.1 + 0.2 - 0.05, without duplicating futures wallet/unrealized PnL.
    expect(host.textContent).toContain('margin net assets')
    expect(accountLoad).toHaveBeenCalledOnce() // Home bootstrap must not issue a second spot request.
    expect(fetchFapiAccount).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps a failed account unknown instead of displaying spot as the complete total', async () => {
    vi.mocked(fetchFapiAccount).mockRejectedValue(new Error('Futures unavailable'))
    await mount(HomeBinance)
    expect(total()).toBe('--'); expect(host.textContent).toContain('Some account values are unavailable')
    expect(fetchAssets).toHaveBeenCalledOnce()
  })
  it.each([HomeBinance, OkxHero, BalancesPanel])('retains a complete snapshot while a changed spot balance triggers the other account reads', async component => {
    await mount(component)
    expect(total()).toBe('0.25')
    let finish: (value: FapiAccount) => void = () => { throw new Error('Missing refreshed futures') }
    vi.mocked(fetchFapiAccount).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    spot = '0.2'; seedSpot(); await flush()
    expect(total()).toBe('0.25')
    expect(host.textContent).toContain('Refreshing')
    finish(futures('0.1')); await flush()
    expect(total()).toBe('0.25')
    expect(fetchFapiAccount).toHaveBeenCalledTimes(2)
  })
  it('does not mix an old spot snapshot when its refresh was superseded by a still-pending reader', async () => {
    accountLoad.mockImplementation(async () => { account.loading = true })
    await mount(HomeBinance)
    expect(total()).toBe('--')
    expect(host.textContent).toContain('Some account values are unavailable')
    expect(host.querySelector('[data-testid="home-coin-amount"]')).toBeNull()
  })
  it.each([OkxHero, BalancesPanel])('does not interpret a missing spot snapshot as an empty zero account', async component => {
    accountLoad.mockImplementation(async () => { account.data = {}; account.error = null })
    await mount(component)
    expect(total()).toBe('--'); expect(host.textContent).toContain('Some account values are unavailable')
    expect(host.textContent).not.toContain('No balance records for this account')
  })
  it('keeps an unpriced nonzero holding unknown and preserves large exact sums', async () => {
    spot = '9007199254740993.1234567890123456'
    await mount(OkxHero)
    expect(total()).toBe('9,007,199,254,740,993.27')
    app!.unmount(); app = undefined
    vi.mocked(fetchFapiAccount).mockResolvedValue(futures('1', 'UNPRICED'))
    await mount(OkxHero)
    expect(total()).toBe('--'); expect(host.textContent).toContain('Some account values are unavailable')
  })
  it.each(['session', 'uid'] as const)('discards old-user late reads after a %s change and after logout', async mode => {
    let finishOld: (value: FapiAccount) => void = () => { throw new Error('Missing old read') }
    vi.mocked(fetchFapiAccount).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    await mount(HomeBinance); expect(total()).toBe('--')
    let finishSpot: () => void = () => { throw new Error('Missing new-user spot read') }
    accountLoad.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpot = () => { seedSpot(); account.error = null; resolve() } }))
    spot = '4'
    if (mode === 'session') session.setToken(newSessionKey())
    session.setUser({ id: 10000012 }); await flush()
    expect(host.querySelector('[data-testid="home-coin-amount"]')).toBeNull()
    finishSpot(); await flush(); await showUsdt()
    expect(total()).toBe('4.15')
    finishOld(futures('9999999')); await flush()
    expect(total()).toBe('4.15')
    let finishLogout: (value: FapiAccount) => void = () => { throw new Error('Missing logout read') }
    vi.mocked(fetchFapiAccount).mockImplementationOnce(() => new Promise(resolve => { finishLogout = resolve }))
    session.setToken(newSessionKey()); session.setUser({ id: 10000013 }); await flush()
    expect(total()).toBe('--')
    session.clear(); await flush(); finishLogout(futures('8888888')); await flush()
    expect(host.querySelector('[data-testid="valuation-total"]')).toBeNull()
  })
})


describe('QA-001 explicit futures PnL breakdown', () => {
  it.each([HomeBinance, OkxHero, BalancesPanel])('separates unchanged balance valuation from refreshed futures PnL without changing total scope', async component => {
    const first = futures('0.3')
    first.assets[0]!.walletBalance = '0.2'; first.assets[0]!.unrealizedProfit = '0.1'
    vi.mocked(fetchFapiAccount).mockResolvedValue(first)
    await mount(component)
    expect(total()).toBe('0.35')
    expect(host.querySelector('[data-testid="portfolio-balance-value"]')?.textContent).toBe('0.25 USDT')
    expect(host.querySelector('[data-testid="portfolio-futures-pnl"]')?.textContent).toBe('0.10 USDT')
    expect(host.textContent).toContain('including futures unrealized PnL')
    expect(host.querySelector('time[data-testid="portfolio-read-time"]')?.getAttribute('datetime')).toMatch(/Z$/)
    const second = futures('0.4')
    second.assets[0]!.walletBalance = '0.2'; second.assets[0]!.unrealizedProfit = '0.2'
    vi.mocked(fetchFapiAccount).mockResolvedValue(second)
    spot = '0.1'; seedSpot(); await flush()
    expect(total()).toBe('0.45')
    expect(host.querySelector('[data-testid="portfolio-balance-value"]')?.textContent).toBe('0.25 USDT')
    expect(host.querySelector('[data-testid="portfolio-futures-pnl"]')?.textContent).toBe('0.20 USDT')
    await host.querySelector<HTMLButtonElement>('.val-eye')?.click(); await flush()
    expect(host.querySelector('[data-testid="portfolio-balance-value"]')?.textContent).toBe('****** USDT')
    expect(host.querySelector('[data-testid="portfolio-futures-pnl"]')?.textContent).toBe('****** USDT')
    host.querySelector<HTMLButtonElement>('.val-eye')!.click(); await flush()
  })
  it('keeps all valuations unknown when futures wallet, PnL and equity do not reconcile', async () => {
    const bad = futures('0.3'); bad.assets[0]!.walletBalance = '0.1'; bad.assets[0]!.unrealizedProfit = '0.1'
    vi.mocked(fetchFapiAccount).mockResolvedValue(bad)
    await mount(BalancesPanel)
    expect(total()).toBe('--')
    expect(host.querySelector('[data-testid="portfolio-balance-value"]')?.textContent).toBe('-- USDT')
    expect(host.querySelector('[data-testid="portfolio-futures-pnl"]')?.textContent).toBe('-- USDT')
    expect(fetchAssets).not.toHaveBeenCalled() // malformed success is never an unopened-account fallback
  })
  it('shows the meaning of the figures in Chinese and preserves a confirmed unopened-account zero', async () => {
    vi.mocked(fetchFapiAccount).mockRejectedValue(new Error('Futures account not opened'))
    vi.mocked(fetchAssets).mockRejectedValue(new ApiError({ kind: 'api', code: '100501', message: 'Not opened', product: 'futures' }))
    await mount(BalancesPanel, 'zh-CN')
    expect(host.textContent).toContain('含合约浮盈')
    expect(host.textContent).toContain('余额估值（不含合约浮盈）')
    expect(host.textContent).toContain('合约未实现盈亏')
    expect(total()).toBe('0.05')
    expect(host.querySelector('[data-testid="portfolio-futures-pnl"]')?.textContent).toBe('0.00 USDT')
  })
  it("does not capture another reader's spot update after this round's spot read completed", async () => {
    await mount(BalancesPanel)
    let finish: (value: FapiAccount) => void = () => { throw new Error('Missing first delayed futures') }
    let finishNext: (value: FapiAccount) => void = () => { throw new Error('Missing trailing futures') }
    vi.mocked(fetchFapiAccount)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve }))
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Refresh'))!
    button.click(); await flush() // this round read spot 0.1
    spot = '0.9'; seedSpot(); await flush() // another reader completed while futures was pending
    finish(futures('0.2')); await flush()
    expect(total()).toBe('0.25') // never publish the external 0.9 with this round's old futures
    expect(host.textContent).toContain('Refreshing')
    expect(fetchFapiAccount).toHaveBeenCalledTimes(3)
    finishNext(futures('0.2')); await flush()
    expect(total()).toBe('1.05') // the trailing complete group can publish the new quantities
  })
})

describe('QA-168 real assets empty states', () => {
  it.each(['en-US', 'zh-CN'] as const)('distinguishes search, hidden zeros, and no records in %s', async locale => {
    spot = '0'; await mount(BalancesPanel, locale)
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'missing'; search.dispatchEvent(new Event('input', { bubbles: true })); await flush()
    expect(host.textContent).toContain(locale === 'en-US' ? 'No assets match your search' : '没有匹配的资产')
    expect(host.textContent).not.toContain(locale === 'en-US' ? 'No balance records for this account' : '该账户暂无资产记录')
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }))
    const zero = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    zero.checked = true; zero.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(host.textContent).toContain(locale === 'en-US' ? 'Matching assets have zero balances' : '匹配的资产均为零余额')
    accountLoad.mockImplementation(async () => { account.data = { allCoinMap: {} }; account.error = null })
    account.data = { allCoinMap: {} }; await flush()
    expect(host.textContent).toContain(locale === 'en-US' ? 'No balance records for this account' : '该账户暂无资产记录')
  })
})

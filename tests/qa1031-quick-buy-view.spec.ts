// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import QuickBuyView from '@/views/QuickBuyView.vue'
import { fetchSpotOrder, type SpotV3Order } from '@/modules/spot/spot-api'
import { fetchTradesByOrder } from '@/modules/api/order.api'
import type { PlacedOrder } from '@/stores/orders'
import type { MarketSymbol } from '@/modules/market/symbols'
const context = vi.hoisted(() => ({ market: {} as Record<string, unknown>, account: {} as Record<string, unknown>, orders: {} as Record<string, unknown>, session: {} as Record<string, unknown> }))
vi.mock('@/stores/market', () => ({ useMarketStore: () => context.market }))
vi.mock('@/stores/account', () => ({ useAccountStore: () => context.account }))
vi.mock('@/stores/orders', () => ({ useOrdersStore: () => context.orders }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => context.session }))
vi.mock('@/modules/spot/spot-api', async original => ({ ...await original<typeof import('@/modules/spot/spot-api')>(), fetchSpotOrder: vi.fn() }))
vi.mock('@/modules/api/order.api', () => ({ fetchTradesByOrder: vi.fn() }))
vi.mock('@/modules/api/exchange-filters', async original => ({ ...await original<typeof import('@/modules/api/exchange-filters')>(), loadSpotFilters: vi.fn().mockResolvedValue({}) }))
vi.mock('@/modules/content/fees.api', async original => ({ ...await original<typeof import('@/modules/content/fees.api')>(), fetchSpotFees: vi.fn().mockResolvedValue([]) }))
const order = (over: Partial<SpotV3Order> = {}): SpotV3Order => ({ symbol: 'BTCUSDT', orderId: '9007199254740993', price: '0', origQty: '1', executedQty: '0', cummulativeQuoteQty: '0', status: 'NEW', type: 'MARKET', side: 'BUY', ...over })
const marketSymbol: MarketSymbol = { symbol: 'btcusdt', pair: 'BTC/USDT', showPair: 'BTC/USDT', base: 'BTC', quote: 'USDT', quoteGroup: 'USDT', pricePrecision: 2, volumePrecision: 8, rules: { pricePrecision: 2, volumePrecision: 8, limitPriceMin: '0', limitVolumeMin: '0', marketBuyMin: '1', marketSellMin: '0.00000001', depthSteps: ['0.01'] }, depthLevels: [0], coin: undefined, sort: 0 }
let app: App | undefined
let host: HTMLDivElement
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  host = document.createElement('div'); document.body.append(host)
  context.market = reactive({ symbols: [marketSymbol], currentSymbol: marketSymbol, publicInfoError: null, publicInfo: {}, selectedPair: 'BTC/USDT', asks: [{ price: '100', amount: '10' }], buys: [{ price: '99', amount: '10' }], ticker: { close: '100' }, tickers: {}, loadPublicInfo: vi.fn().mockResolvedValue(undefined), start: vi.fn(() => () => undefined), resubscribe: vi.fn() })
  context.account = reactive({ data: {}, quoteAvailable: '1000', baseSellable: '2', load: vi.fn().mockResolvedValue(undefined) })
  context.session = reactive({ isAuthenticated: true })
  context.orders = reactive({ submitting: false, submitError: null, lastPlaced: { id: '9007199254740993', symbol: 'btcusdt', v3: order() } satisfies PlacedOrder, submitOrder: vi.fn().mockResolvedValue(true) })
  vi.mocked(fetchSpotOrder).mockReset().mockResolvedValue(order())
  vi.mocked(fetchTradesByOrder).mockReset().mockResolvedValue({ trade_list: [] })
})
afterEach(() => { app?.unmount(); app = undefined; vi.clearAllTimers(); vi.useRealTimers(); document.body.innerHTML = '' })
async function mountPage(lang = 'zh-CN') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: QuickBuyView }, { path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/'); await router.isReady()
  const i18n = createI18n({ legacy: false, locale: lang, fallbackLocale: lang, messages: {} })
  app = createApp(QuickBuyView).use(router).use(i18n)
  app.mount(host); await flush()
  return i18n.global.locale
}
async function place(lang = 'zh-CN'): Promise<void> {
  await mountPage(lang)
  const input = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
  input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  host.querySelector<HTMLButtonElement>('[data-testid="quick-buy-submit"]')!.click(); await flush()
  document.querySelector<HTMLButtonElement>('[data-testid="quick-buy-confirm"]')!.click(); await flush()
}
const text = () => document.body.textContent ?? ''
describe('QA148 real quick-buy result reconciliation (all APIs mocked)', () => {
  it('keeps the exact USDT budget when choosing a buy coin and clears a sell amount when its coin changes', async () => {
    const eth = { ...marketSymbol, symbol: 'ethusdt', pair: 'ETH/USDT', showPair: 'ETH/USDT', base: 'ETH' }
    context.market.symbols = [marketSymbol, eth]
    context.market.selectPair = vi.fn((pair: string) => {
      context.market.selectedPair = pair
      context.market.currentSymbol = pair === eth.pair ? eth : marketSymbol
    })
    await mountPage('en-US')
    const amount = host.querySelector<HTMLInputElement>('#qb-amount')!
    const enter = async (value: string) => {
      amount.value = value
      amount.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    }
    const choose = async (coin: string) => {
      host.querySelector<HTMLButtonElement>('.qb-coin-btn')!.click()
      await flush()
      const options = [...host.querySelectorAll<HTMLButtonElement>('.qb-coin-row')]
      options.find((row) => row.querySelector('strong')?.textContent === coin)!.click()
      await flush()
    }
    await enter('125.05')
    await choose('BTC')
    expect(amount.value).toBe('125.05')
    expect(context.market.selectPair).not.toHaveBeenCalled()
    await choose('ETH')
    expect(context.market.selectPair).toHaveBeenCalledWith('ETH/USDT')
    expect(amount.value).toBe('125.05')
    host.querySelectorAll<HTMLButtonElement>('.qb-tab')[1]!.click()
    await flush()
    await enter('0.25')
    await choose('BTC')
    expect(amount.value).toBe('')
    expect(context.orders.submitOrder).not.toHaveBeenCalled()
  })

  it('QA-166 truncates the SELL balance at coin precision without changing its exact Max amount', async () => {
    context.market.publicInfo = { market: { coinList: { BTC: { showPrecision: 4 }, USDT: { showPrecision: 2 } } } }
    context.account.baseSellable = '9007199254740993.1234567890123456'
    await mountPage('en-US')
    host.querySelectorAll<HTMLButtonElement>('.qb-tab')[1]!.click(); await flush()
    expect(host.querySelector('.qb-avail')?.textContent).toContain('9,007,199,254,740,993.1234 BTC')
    expect(host.querySelector('.qb-avail')?.getAttribute('title')).toBe('9007199254740993.1234567890123456')
    host.querySelector<HTMLButtonElement>('.qb-max')!.click(); await flush()
    expect(host.querySelector<HTMLInputElement>('#qb-amount')?.value).toBe('9007199254740993.12345678')
    expect(context.orders.submitOrder).not.toHaveBeenCalled()
  })
  it('continues after partial fills and shows a later authoritative FILLED state', async () => {
    vi.mocked(fetchSpotOrder).mockResolvedValueOnce(order({ status: 'PARTIALLY_FILLED', executedQty: '0.25', cummulativeQuoteQty: '25' })).mockResolvedValueOnce(order({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' }))
    vi.mocked(fetchTradesByOrder).mockResolvedValue({ trade_list: [{ id: '1', price: '100', volume: '0.25' }] })
    await place()
    expect(text()).toContain('部分成交'); expect(text()).not.toContain('全部成交')
    await vi.advanceTimersByTimeAsync(300); await flush()
    expect(text()).toContain('全部成交')
    expect(fetchSpotOrder).toHaveBeenCalledTimes(2)
    expect(fetchSpotOrder).toHaveBeenLastCalledWith('BTCUSDT', '9007199254740993', expect.any(AbortSignal))
    expect(document.querySelector('[data-testid="quick-buy-refresh-result"]')).toBeNull()
    expect(context.orders.submitOrder).toHaveBeenCalledTimes(1)
  })
  it('never infers fully-filled from spend/fills when order status cannot be confirmed; refresh reads the original order', async () => {
    vi.mocked(fetchSpotOrder).mockRejectedValue(new Error('read unavailable'))
    vi.mocked(fetchTradesByOrder).mockResolvedValue({ trade_list: [{ id: '1', price: '100', volume: '1' }] })
    await place('en-US'); await vi.advanceTimersByTimeAsync(4000); await flush()
    expect(text()).toContain('latest order status is unconfirmed')
    expect(text()).not.toContain('StatusFilled')
    expect(fetchSpotOrder).toHaveBeenCalledTimes(4)
    // A separate accepted order elsewhere must not change this dialog's reconciliation target.
    context.orders.lastPlaced = { id: 'other', symbol: 'ethusdt', v3: null }
    vi.mocked(fetchSpotOrder).mockResolvedValue(order({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' }))
    document.querySelector<HTMLButtonElement>('[data-testid="quick-buy-refresh-result"]')!.click(); await flush()
    expect(fetchSpotOrder).toHaveBeenLastCalledWith('BTCUSDT', '9007199254740993', expect.any(AbortSignal))
    expect(text()).toContain('StatusFilled')
    expect(context.orders.submitOrder).toHaveBeenCalledTimes(1)
  })
  it('preserves an authoritative cancelled partial result and cumulative totals over paginated trades', async () => {
    vi.mocked(fetchSpotOrder).mockResolvedValue(order({ status: 'CANCELED', executedQty: '0.5', cummulativeQuoteQty: '50' }))
    vi.mocked(fetchTradesByOrder).mockResolvedValue({ trade_list: [{ id: '1', price: '100', volume: '99' }] })
    await place()
    expect(text()).toContain('已撤销')
    expect(text()).toContain('0.5 BTC')
    expect(text()).not.toContain('99 BTC')
    expect(fetchSpotOrder).toHaveBeenCalledOnce()
  })
  it('shows authoritative final status without waiting for the separate trade-list service', async () => {
    vi.mocked(fetchSpotOrder).mockResolvedValue(order({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' }))
    vi.mocked(fetchTradesByOrder).mockReturnValue(new Promise(() => undefined))
    await place()
    expect(text()).toContain('全部成交')
    expect(fetchTradesByOrder).not.toHaveBeenCalled()
  })
  it('closes and discards pending order reads when the session ends', async () => {
    let resolve: (value: SpotV3Order) => void = () => undefined
    vi.mocked(fetchSpotOrder).mockReturnValue(new Promise(r => { resolve = r }))
    await place()
    context.session.isAuthenticated = false; await flush()
    resolve(order({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' })); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(context.orders.submitOrder).toHaveBeenCalledOnce()
  })
  it('keeps NEW ongoing after the bounded checks instead of fabricating a terminal state', async () => {
    await place(); await vi.advanceTimersByTimeAsync(4000); await flush()
    expect(text()).toContain('已提交，等待撮合')
    expect(text()).toContain('订单尚未结束')
    expect(text()).not.toContain('全部成交')
    expect(document.querySelector('[data-testid="quick-buy-refresh-result"]')).toBeTruthy()
  })
  it('reads a classic accepted order by id and ignores late results after the dialog closes', async () => {
    context.orders.lastPlaced = { id: '9007199254740993', symbol: 'btcusdt', v3: null }
    let resolve: (value: SpotV3Order) => void = () => undefined
    vi.mocked(fetchSpotOrder).mockReturnValue(new Promise(r => { resolve = r }))
    await place()
    expect(fetchSpotOrder).toHaveBeenCalledOnce()
    const close = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '再来一笔')!
    close.click(); await flush()
    resolve(order({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' })); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fetchSpotOrder).toHaveBeenCalledOnce()
    expect(context.orders.submitOrder).toHaveBeenCalledOnce()
  })
})

it('updates the visible small-balance shortcut notice on each language switch', async () => {
  context.account.quoteAvailable = '0.001'
  const locale = await mountPage()
  host.querySelector<HTMLButtonElement>('[data-testid="quick-buy-ratio-0.25"]')!.click()
  await flush()
  const notice = () => host.querySelector('[data-testid="quick-buy-notice"]')?.textContent
  expect(notice()).toContain('可用 0.001 USDT 不足最小下单单位 0.01 USDT')
  locale.value = 'en-US'
  await flush()
  expect(notice()).toContain('Available 0.001 USDT is below the minimum order unit 0.01 USDT')
  locale.value = 'zh-CN'
  await flush()
  expect(notice()).toContain('无法买入')
})

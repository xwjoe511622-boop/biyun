// @vitest-environment jsdom

import { clearToasts, useToasts } from '@/core/toast'
import { resetLadderCache } from '@/modules/futures/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import FuturesOrderPanel from '@/components/futures/FuturesOrderPanel.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { resetFuturesFiltersCache } from '@/modules/api/exchange-filters'
import { buildContract } from '@/modules/futures/contracts'
import { useQuoteMode } from '@/modules/futures/order-entry'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import type { DepthSnapshotRow } from '@/modules/ws/protocol'

/**
 * Binance WEB futures ticket (2026-09-30): 全仓/逐仓 + 杠杆 + 单币 chips, an 开仓/平仓 segmented control,
 * 限价/市价/条件委托 text tabs (dropdown on phones), labels above 40px inputs, per-button 强平/保证金/可开(可平)
 * meta lines, and a 手续费等级 link. The min-opening size is the 数量 placeholder; 只做Maker is picked in 生效方式.
 */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null
let orders: Record<string, string>[] = []
let pendingSubmits = new Set<Promise<void>>()
let stopTrackingSubmits: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  session.clear()
  orders = []
  pendingSubmits = new Set()
  resetFuturesFiltersCache()
  pinia = createPinia()
  setActivePinia(pinia)
  const market = useFuturesMarketStore()
  const info = normalizePublicInfo({
    contractList: [{
      id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 125,
      coinResultVo: { symbolPricePrecision: 2, marginCoinPrecision: 6, minOrderVolume: 1, minOrderMoney: 1, maxLimitVolume: 99999999, maxMarketVolume: 99999999, maxMarketMoney: 99999999, fundsInStatus: 1, fundsOutStatus: 1, depth: ['2', '1', '0'] },
    }],
  })
  market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
  market.selectedName = 'E-BTC-USDT'
  session.setToken('jwt')
  // Toasts are global: a late toast of the previous test (same key) must not replace this test's.
  clearToasts()
  useSizeUnit().value = 'quote'
  useQuoteMode().value = 'notional'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 10, marginModel: 1 } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
    if (path === 'common/getMakerAndTaker') return respond({ code: '0', data: [{ multiplierCoin: 'BTC', marginCoin: 'USDT', openTakerFee: 0.00075, openMakerFee: 0.00025, closeTakerFee: 0.00075, closeMakerFee: 0.00025, multiplier: 0.0001 }] })
    if (path === 'common/exchange_filters') return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.001', minNotional: '50' } } } } })
    if (path === 'order/order_create') {
      orders.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>)
      return respond({ code: '0', data: { ids: ['1'] } })
    }
    return respond({ code: '0', data: {} })
  }))
})

afterEach(async () => {
  // Market closes can keep polling for 3 seconds after the order response. Await their actual
  // action promises while this test's fetch fixture is still installed; a fixed 50 ms allowed
  // an old close to read the next test's assets and overwrite its `fut-submit` toast.
  await Promise.all([...pendingSubmits])
  await flush()
  stopTrackingSubmits?.()
  stopTrackingSubmits = null
  app?.unmount()
  app = null
  // Toasts are global: drop any left over so a late one cannot leak into the next test.
  clearToasts()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  session.clear()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function feedBook(asks: DepthSnapshotRow[], buys: DepthSnapshotRow[]): void {
  const market = useFuturesMarketStore()
  market.connectionState = 'open'
  market.handleMessage({ channel: 'market_e_btcusdt_depth_step0', tick: { asks, buys } })
}

async function mountPanel(): Promise<HTMLElement> {
  app = createApp(defineComponent({ setup: () => () => h(FuturesOrderPanel) }))
  app.use(pinia)
  app.use(i18n)
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  const account = useFuturesAccountStore()
  stopTrackingSubmits = account.$onAction(({ name, after, onError }) => {
    if (name !== 'placeOrder') return
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    pendingSubmits.add(pending)
    const settled = () => { pendingSubmits.delete(pending); finish() }
    after(settled)
    onError(settled)
  }, true)
  await account.refresh()
  await flush()
  return host
}

// Popover menus are teleported to <body> (TicketPopover, 2026-09-30): look up by test id in the whole document.
const q = <T extends Element>(_host: HTMLElement, id: string): T => document.body.querySelector(`[data-testid="${id}"]`) as T

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

describe('QA-163 direction-specific limit price messages', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps the shared field valid and labels only the restricted side in %s', async locale => {
    const previousLocale = i18n.global.locale.value
    i18n.global.locale.value = locale
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).includes('common/exchange_filters')
      ? respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.001', minNotional: '50', multiplierUp: '1.05', multiplierDown: '0.95' } } } } })
      : originalFetch(url, init))
    const market = useFuturesMarketStore()
    market.marketInfo = { ...market.marketInfo, tagPrice: '80000' }
    try {
      const host = await mountPanel()
      const priceInput = host.querySelector<HTMLInputElement>('.price-line input')!
      for (const [previousSide, price, validSide, refusedSide] of [
        ['SELL', '70000', 'BUY', 'SELL'],
        ['BUY', '86000', 'SELL', 'BUY'],
      ] as const) {
        await type(q(host, 'fut-volume'), '')
        q<HTMLButtonElement>(host, `fut-submit-${previousSide}`).click(); await flush()
        await type(priceInput, price)
        await type(q(host, 'fut-volume'), '150')
        priceInput.dispatchEvent(new Event('blur')); await flush()
        expect(priceInput.closest('.field-input')?.classList.contains('invalid')).toBe(false)
        expect(q(host, `fut-price-error-${validSide}`)).toBeNull()
        expect(q(host, `fut-price-error-${refusedSide}`).textContent).toContain(locale === 'en-US' ? refusedSide : refusedSide === 'BUY' ? '买单' : '卖单')
        expect(q(host, 'fut-submit-error').textContent?.trim()).toBe('')
        q<HTMLButtonElement>(host, `fut-submit-${refusedSide}`).click(); await flush()
        expect(orders).toHaveLength(validSide === 'BUY' ? 0 : 1)
        q<HTMLButtonElement>(host, `fut-submit-${validSide}`).click(); await flush()
        expect(orders.at(-1)).toMatchObject({ side: validSide, price })
      }
      await type(priceInput, '0')
      priceInput.dispatchEvent(new Event('blur')); await flush()
      expect(priceInput.closest('.field-input')?.classList.contains('invalid')).toBe(true)
    } finally { i18n.global.locale.value = previousLocale }
  })
})

describe('futures ticket: order types', () => {
  it('offers 限价单 / 只做Maker / 市价单 / 条件委托 with their descriptions', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-order-type').click()
    await flush()
    const text = document.body.querySelector('[role="listbox"]')?.textContent ?? ''
    expect(text).toContain('限价单')
    expect(text).toContain('以特定或更优价格买入或卖出')
    expect(text).toContain('以最佳市价买入或卖出')
    expect(text).toContain('达到目标价时下限价单或市价单')
    expect(text).toContain('只做Maker')
    expect(text).toContain('下市场挂单方订单，如与现有订单匹配则订单取消')
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(4)
  })

  it('只做Maker sends type 5 with a limit price (同向价1 from the book) and shows 只做Maker in 生效方式', async () => {
    const host = await mountPanel()
    feedBook([[83263.31, 10]], [[83257.98, 10]])
    await new Promise((resolve) => setTimeout(resolve, 250))
    q<HTMLButtonElement>(host, 'fut-order-type').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-order-type-postOnly').click()
    await flush()
    expect(q(host, 'fut-tif').textContent).toContain('只做Maker')
    q<HTMLButtonElement>(host, 'fut-bbo').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-bbo-option').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-bbo-option-same1').click()
    await flush()
    await type(q(host, 'fut-volume'), '100')
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '5', side: 'SELL', price: '83263.31', volume: '12' })
  })

  it('sends IOC / FOK as order type 3 / 4', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-tif').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-tif-IOC').click()
    await flush()
    const price = host.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    await type(price, '80000')
    await type(q(host, 'fut-volume'), '100')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '3', price: '80000', volume: '12' })
  })

  it('choosing 只做Maker in 生效方式 sends type 5', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-tif').click()
    await flush()
    expect(q(host, 'fut-tif-GTC')).toBeTruthy()
    expect(q(host, 'fut-tif-IOC')).toBeTruthy()
    expect(q(host, 'fut-tif-FOK')).toBeTruthy()
    q<HTMLButtonElement>(host, 'fut-tif-postOnly').click()
    await flush()
    const price = host.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    await type(price, '80000')
    await type(q(host, 'fut-volume'), '100')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '5', side: 'BUY', price: '80000', volume: '12' })
  })
})

describe('futures ticket: 最优价', () => {
  it('对手价1 buys at the live best ask and shows the resolved prices', async () => {
    const host = await mountPanel()
    feedBook([[83263.31, 10], [83264, 5]], [[83257.98, 10], [83257, 3]])
    await new Promise((resolve) => setTimeout(resolve, 250))
    q<HTMLButtonElement>(host, 'fut-bbo').click()
    await flush()
    expect(q<HTMLElement>(host, 'fut-bbo-resolved').textContent).toContain('买 83,263.31 · 卖 83,257.98')
    await type(q(host, 'fut-volume'), '100')
    // The book moves after the last 200 ms publish: the submit uses the book as it is now.
    feedBook([[83270.5, 10]], [[83260, 10]])
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '1', side: 'BUY', price: '83270.5', volume: '12' })
  })

  it.each([
    { scenario: 'fails clearly when the book has fewer than 5 levels', state: 'open', shallow: true, message: '买盘不足 5 档' },
    { scenario: 'reports an empty connected book', state: 'open', shallow: false, message: '暂无盘口行情' },
    { scenario: 'reports a disconnected book', state: 'closed', shallow: false, message: '盘口未连接' },
  ] as const)('同向价5 $scenario', async ({ state, shallow, message }) => {
    const host = await mountPanel()
    if (shallow) feedBook([['83263.31', '10']], [['83257.98', '10']])
    else feedBook([], [])
    useFuturesMarketStore().connectionState = state
    q<HTMLButtonElement>(host, 'fut-bbo').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-bbo-option').click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-bbo-option-same5').click()
    await flush()
    await type(q(host, 'fut-volume'), '100')
    expect(host.textContent).toContain(message)
    // Clickable: the click explains why (toast) and sends nothing — never a silent greyed button.
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(useToasts().value.some((toast) => toast.tone === 'error' && toast.message.includes(message))).toBe(true)
    expect(orders).toHaveLength(0)
  })

  it('uses the live empty book for the submit error before the next display update', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-bbo').click()
    await type(q(host, 'fut-volume'), '100')
    feedBook([['83263.31', '10']], [['83257.98', '10']])
    feedBook([], [])
    expect(useFuturesMarketStore().bookTop.asks).toEqual(['83263.31'])
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(useToasts().value.some(toast => toast.tone === 'error' && toast.message === '暂无盘口行情')).toBe(true)
    expect(orders).toHaveLength(0)
  })
})

describe('futures ticket: 货币单位', () => {
  it('lists the coin and USDT (订单金额 | 初始保证金), never 张', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-unit-sheet').click()
    await flush()
    const sheet = document.body.querySelector('[role="dialog"][data-popover]')?.textContent ?? ''
    expect(sheet).toContain('货币单位')
    expect(sheet).toContain('输入并显示以 BTC 表示的订单金额')
    expect(sheet).toContain('订单金额')
    expect(sheet).toContain('初始保证金')
    expect(sheet).not.toContain('张')
  })

  it('初始保证金: 100 USDT at 10x sends 1000 USDT of notional as floored contracts', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-unit-sheet').click()
    await flush()
    const margin = q<HTMLElement>(host, 'fut-quote-margin').querySelector('input') as HTMLInputElement
    margin.click()
    await flush()
    expect(localStorage.getItem('picat.futures.quoteMode')).toBe('margin')
    const price = host.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    await type(price, '83257.98')
    await type(q(host, 'fut-volume'), '100')
    expect(q<HTMLElement>(host, 'fut-size-hint').textContent).toBe('≈ 999.09 USDT 订单金额 · 0.012 BTC · 120 张') // value of the floored 120 张
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ volume: '120', price: '83257.98', leverageLevel: '10' })
  })

  it('最大 deducts the taker fee: 1000 USDT at 10x (per-button 可开 columns)', async () => {
    const host = await mountPanel()
    const tabs = host.querySelector('[data-testid="fut-order-type"]') as HTMLButtonElement
    tabs.click()
    await flush()
    ;(document.body.querySelector('[data-testid="fut-order-type-market"]') as HTMLButtonElement).click()
    await flush()
    expect(q<HTMLElement>(host, 'fut-max-BUY').textContent).toContain('9,925.55 USDT')
    expect(q<HTMLElement>(host, 'fut-max-SELL').textContent).toContain('9,925.55 USDT')
    useQuoteMode().value = 'margin'
    await flush()
    expect(q<HTMLElement>(host, 'fut-max-BUY').textContent).toContain('992.55 USDT')
    useSizeUnit().value = 'base'
    ;(host.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null)?.focus()
    await flush()
    expect(q<HTMLElement>(host, 'fut-max-BUY').textContent).toMatch(/BTC$/)
  })
})

describe('futures ticket: 可用 ➕', () => {
  it('opens the transfer dialog prefilled spot → futures USDT', async () => {
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-add-funds').click()
    await flush()
    const dialog = document.body.querySelector('[role="dialog"][aria-modal="true"]')
    expect(dialog?.getAttribute('aria-label')).toBe('资金划转')
    const route = [...(dialog?.querySelectorAll('.route-row b') ?? [])].map((node) => node.textContent)
    expect(route).toEqual(['币币账户', '合约账户'])
    expect(dialog?.querySelector('.coin')?.textContent).toContain('USDT')
  })
})

describe('futures ticket: tabs and close mode', () => {
  it('has the 开仓/平仓 tablist and the three type tabs; the market tab shows the market price box', async () => {
    const host = await mountPanel()
    const ocTabs = host.querySelector('.oc-tabs')
    expect(ocTabs?.getAttribute('role')).toBe('tablist')
    expect(ocTabs?.textContent).toContain('开仓')
    expect(ocTabs?.textContent).toContain('平仓')
    expect(q(host, 'fut-type-tab-limit')).toBeTruthy()
    expect(q(host, 'fut-type-tab-market')).toBeTruthy()
    expect(q(host, 'fut-type-tab-trigger')).toBeTruthy()
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    expect(q<HTMLElement>(host, 'fut-market-price').textContent).toContain('以当前最优价格成交')
  })

  it.each([1, 2])('QA-212 expresses the opening minimum in the selected input unit at %s quote decimals', async dp => {
    const market = useFuturesMarketStore()
    market.contracts = market.contracts.map(contract => ({ ...contract, pricePrecision: dp }))
    const host = await mountPanel()
    const priceInput = host.querySelector<HTMLInputElement>('.price-line input')!
    await type(priceInput, '83257.98')
    const placeholder = () => q<HTMLInputElement>(host, 'fut-volume').placeholder
    expect(placeholder()).toBe(dp === 1 ? '最小 83.3 USDT' : '最小 83.26 USDT') // Minimum rounds up to the existing entry precision.
    useSizeUnit().value = 'base'; await flush()
    expect(placeholder()).toBe('最小 0.001 BTC')
    useSizeUnit().value = 'quote'; useQuoteMode().value = 'margin'; await flush()
    expect(placeholder()).toBe(dp === 1 ? '最小 8.4 USDT' : '最小 8.33 USDT')
    const closeTab = [...host.querySelectorAll<HTMLButtonElement>('.oc-tab')].find(button => button.textContent === '平仓')!
    closeTab.click(); await flush()
    expect(placeholder()).toBe('')
    expect(orders).toHaveLength(0)
  })

  it.each([
    ['margin', '0.1', '0.4', '3.8'],
    ['notional', '0.1', '7.6', '76'],
  ] as const)('QA-212: both minimum checks lead to a valid %s entry', async (mode, tiny, oneContract, minimum) => {
    const host = await mountPanel()
    const account = useFuturesAccountStore()
    account.config = { ...account.config!, nowLevel: 20 }
    useQuoteMode().value = mode
    await type(host.querySelector<HTMLInputElement>('.price-line input')!, '76000')
    const input = q<HTMLInputElement>(host, 'fut-volume')
    expect(input.placeholder).toContain(`最小 ${minimum} USDT`)
    for (const value of [tiny, oneContract]) {
      await type(input, value)
      expect(host.querySelector('.field-error')?.textContent).toContain(`${minimum} USDT`)
    }
    await type(input, minimum)
    expect(host.querySelector('.field-error')).toBeNull()
    expect(q(host, 'fut-size-hint').textContent).toContain('10 张')
    expect(orders).toHaveLength(0)
  })

  it('QA-234 only repeats the order value when whole contracts change the amount', async () => {
    const host = await mountPanel()
    await type(host.querySelector<HTMLInputElement>('.price-line input')!, '75000')
    const input = q<HTMLInputElement>(host, 'fut-volume')
    await type(input, '150')
    expect(q(host, 'fut-size-hint').textContent).toBe('≈ 0.002 BTC · 20 张')
    await type(input, '151')
    expect(q(host, 'fut-size-hint').textContent).toContain('实际订单金额：150 USDT')
  })

  it('QA-212 keeps value-native market minimums independent of whole-contract rounding', async () => {
    const host = await mountPanel()
    const priceInput = host.querySelector<HTMLInputElement>('.price-line input')!
    await type(priceInput, '40000')
    // 0.001 BTC is 40 USDT, so the configured 50 USDT notional minimum determines a value-native open.
    useFuturesMarketStore().marketInfo = { ...useFuturesMarketStore().marketInfo, tagPrice: '40000' }
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click(); await flush()
    expect(q<HTMLInputElement>(host, 'fut-volume').placeholder).toBe('最小 50 USDT')
    expect(orders).toHaveLength(0)
  })

  it('QA-212 keeps a coin-sized market minimum valid after value-wire truncation', async () => {
    const market = useFuturesMarketStore()
    market.contracts = market.contracts.map(contract => ({ ...contract, minOrderMoney: '50.005' }))
    market.marketInfo = { ...market.marketInfo, tagPrice: '50005' }
    useSizeUnit().value = 'base'
    const host = await mountPanel()
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click(); await flush()
    const input = q<HTMLInputElement>(host, 'fut-volume')
    expect(input.placeholder).toBe('最小 0.0011 BTC')
    // 10 contracts are worth exactly 50.005 USDT, but only 50.00 fits the wire precision.
    await type(input, '0.001')
    expect(host.querySelector('.field-error')?.textContent).toBe('最小下单金额 0.0011 BTC')
    await type(input, '0.0011')
    expect(host.querySelector('.field-error')).toBeNull()
    expect(orders).toHaveLength(0)
  })

  it('close mode shows 平空 / 平多 buttons and 可平 lines', async () => {
    const host = await mountPanel()
    const closeTab = [...host.querySelectorAll<HTMLButtonElement>('.oc-tab')].find((button) => button.textContent === '平仓')
    expect(closeTab).toBeTruthy()
    closeTab!.click()
    await flush()
    expect(q<HTMLButtonElement>(host, 'fut-submit-BUY').textContent).toContain('平空')
    expect(q<HTMLButtonElement>(host, 'fut-submit-SELL').textContent).toContain('平多')
    expect(q(host, 'fut-max-BUY').textContent).toContain('-- USDT')
    expect(host.textContent).toContain('可平')
  })
})

describe('futures ticket: market open fills the requested contracts (2026-09-30)', () => {
  it('a market buy in BTC walks the asks and pads half a contract', async () => {
    useSizeUnit().value = 'base'
    const host = await mountPanel()
    feedBook([[83500, 12], [83502, 5], [83505, 100]], [[83498, 50]])
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83400, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    await new Promise((resolve) => setTimeout(resolve, 250))
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '0.002')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    // (12 x 83500 + 5 x 83502 + 3 x 83505 + 0.5 x 83505) x 0.0001 = 171.17 (20 contracts, not 20 x reference)
    expect(orders.at(-1)).toMatchObject({ type: '2', side: 'BUY', open: 'OPEN', volume: '171.17' })
  })

  it('a market buy typed in USDT is sent as typed (an order value, not a quantity)', async () => {
    const host = await mountPanel()
    feedBook([[83500, 12]], [[83498, 50]])
    await new Promise((resolve) => setTimeout(resolve, 250))
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '150')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '2', side: 'BUY', volume: '150' })
  })
})

describe('futures ticket: close by slider percent (2026-09-30 owner bug: 「请输入数值」 at 100%)', () => {
  const LONG = { id: 7, contractId: 1, contractName: 'E-BTC-USDT', orderSide: 'BUY', positionType: 1, leverageLevel: 10, positionVolume: '37', canCloseVolume: '37', openAvgPrice: '83000', indexPrice: '83400', holdAmount: '300', positionBalance: '308.58' }
  const SHORT = { ...LONG, id: 8, orderSide: 'SELL', positionVolume: '12', canCloseVolume: '12' }
  async function closeTab(host: HTMLElement): Promise<void> {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('.oc-tab')].find((button) => button.textContent?.includes('平仓'))!
    tab.click()
    await flush()
  }
  async function label(host: HTMLElement, pct: number): Promise<void> {
    ;[...host.querySelectorAll<HTMLButtonElement>('.fop .pct-label')].find((button) => button.textContent?.trim() === `${pct}%`)!.click()
    await flush()
  }
  async function slide(host: HTMLElement, key: 'End' | 'Home' | 'PageUp'): Promise<void> {
    host.querySelector<HTMLElement>('.fop [role="slider"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await flush()
  }
  function withPositions(): void {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('position/get_assets_list')) return respond({ code: '0', data: { positionList: [LONG, SHORT], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000', totalMargin: '1000' }] } })
      return base(url, init)
    })
  }

  it('平仓 tab with a long held and no size: 平多 stays clickable and the click says why (never a silent no-op)', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('position/get_assets_list')) return respond({ code: '0', data: { positionList: [LONG], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000', totalMargin: '1000' }] } })
      return base(url, init)
    })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    await closeTab(host)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    const button = q<HTMLButtonElement>(host, 'fut-submit-SELL')
    expect(button.disabled).toBe(false)
    button.click()
    await flush()
    // A rule the ticket checks itself: shown inline (reserved line under the buttons), not as a floating toast.
    expect(q<HTMLElement>(host, 'fut-submit-error').textContent).toContain('请输入数值')
    expect(useToasts().value.some((toast) => toast.tone === 'error')).toBe(false)
    expect(orders).toHaveLength(0)
  })

  it('QA-234 keeps the amount estimated for market closes', async () => {
    withPositions()
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    await closeTab(host)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '151')
    expect(q(host, 'fut-size-hint').textContent).toContain('估算名义价值 150.21 USDT')
    expect(q(host, 'fut-size-hint').textContent).not.toContain('实际订单金额')
    expect(orders).toHaveLength(0)
  })

  it('only a long held: 100% shows no false 「请输入数值」, 平多 closes it, 平空 says there is nothing to close', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('position/get_assets_list')) return respond({ code: '0', data: { positionList: [LONG], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000', totalMargin: '1000' }] } })
      return base(url, init)
    })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    await closeTab(host)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await label(host, 100)
    expect(q<HTMLInputElement>(host, 'fut-volume').placeholder).toBe('100%')
    expect(host.querySelector('.fop .field-error')?.textContent ?? '').not.toContain('请输入数值')
    // 平空 has nothing to close: not clickable (the ticket checks each side).
    expect(q<HTMLButtonElement>(host, 'fut-submit-BUY').disabled).toBe(true)
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ side: 'SELL', open: 'CLOSE', type: '2', volume: '37' })
  })

  for (const unitName of ['quote', 'base'] as const) {
    for (const type of ['market', 'limit'] as const) {
      it(`${type} close, unit ${unitName}: 100% closes the whole long, 25% a quarter; the short side likewise`, async () => {
        withPositions()
        useSizeUnit().value = unitName
        const host = await mountPanel()
        feedBook([[83500, 50]], [[83400, 50]])
        useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
        await new Promise((resolve) => setTimeout(resolve, 250))
        await closeTab(host)
        q<HTMLButtonElement>(host, `fut-type-tab-${type}`).click()
        await flush()
        if (type === 'limit') await type_(q(host, 'fut-price') ?? host.querySelector('.fop input[aria-label="委托价格"]')!, '83450')
        await label(host, 100)
        q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
        await flush()
        expect(orders.at(-1)).toMatchObject({ side: 'SELL', open: 'CLOSE', volume: '37' })
        await slide(host, 'Home')
        await slide(host, 'PageUp')
        await slide(host, 'PageUp')
        await slide(host, 'PageUp')
        await slide(host, 'PageUp')
        q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
        await flush()
        // 40% of the 12-contract short, floored: 4
        expect(orders.at(-1)).toMatchObject({ side: 'BUY', open: 'CLOSE', volume: '4' })
      })
    }
  }
})

async function type_(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

describe('leverage tier cap (10-01 owner bug: 开空 over the 125x cap looked like nothing happened)', () => {
  const LEVER = JSON.stringify([{ level: 1, maxHoldAmount: 99999999, maxLever: 5, minLever: 0 }, { level: 2, maxHoldAmount: 5000, maxLever: 125, minLever: 5 }])
  function withServer(opts: { tiers: boolean; createCode?: string }): void {
    resetLadderCache()
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url).replace(FUTURES_API_PREFIX, '').split('?')[0]
      if (path === 'common/get_ladder_info') return respond({ code: '0', data: opts.tiers ? { leverList: { leverConfig: LEVER }, ladderList: { ladderList: [] } } : {} })
      if (path === 'order/order_create' && opts.createCode !== undefined) {
        orders.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>)
        return respond({ code: opts.createCode, msg: 'Exceeded the maximum position amount in current leverage level' })
      }
      return base(url, init)
    })
  }

  it('caps 可开 by the tier and refuses above it before sending, with the numbers', async () => {
    withServer({ tiers: true })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    // 1000 USDT x 10x would allow ~9,925 USDT; the 10x tier allows 5,000 (tiers load async: wait for them under load).
    for (let i = 0; i < 40 && !(q<HTMLElement>(host, 'fut-max-SELL').textContent ?? '').includes('5,000'); i += 1) await flush()
    expect(q<HTMLElement>(host, 'fut-max-SELL').textContent).toContain('5,000')
    await type(q(host, 'fut-volume'), '8000')
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    await flush()
    expect(orders).toHaveLength(0)
    const message = '当前杠杆 10x 最大仓位价值 5,000 USDT，请降低杠杆或数量'
    // Checked by the ticket before sending: inline, no floating toast (10-01 owner feedback).
    expect(q<HTMLElement>(host, 'fut-submit-error').textContent?.trim()).toBe(message)
    expect(useToasts().value.some((toast) => toast.tone === 'error')).toBe(false)
  })

  it('a server refusal (10013) is shown as a toast AND under the buttons, never silently', async () => {
    withServer({ tiers: false, createCode: '10013' })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '8000')
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    const message = '超出当前杠杆的最大仓位价值，请降低杠杆或数量'
    // The refusal is written by an async submit; wait (bounded) for the toast tone+message AND the inline line, both exact.
    await vi.waitFor(() => {
      expect(useToasts().value).toEqual(expect.arrayContaining([expect.objectContaining({ tone: 'error', message })]))
      expect(q<HTMLElement>(host, 'fut-submit-error').textContent?.trim()).toBe(message)
    }, { timeout: 2000, interval: 20 })
    expect(orders).toHaveLength(1)
    // Editing the ticket clears the inline error.
    await type(q(host, 'fut-volume'), '100')
    expect(q<HTMLElement>(host, 'fut-submit-error').textContent?.trim()).toBe('')
  })
})

describe('min order and 可开 below the minimum (10-01 owner: 「订单金额太小」 toast floated truncated)', () => {
  it('says 最小下单金额 inline while typing, never sends, never toasts', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('common/exchange_filters')) return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.0001', minNotional: '50' } } } } })
      return base(url, init)
    })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '5.3')
    // Live, before any click: the field says the rule.
    expect(host.querySelector('.fop .field-error')?.textContent ?? '').toContain('最小下单金额 50 USDT')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders).toHaveLength(0)
    expect(useToasts().value.some((toast) => toast.tone === 'error')).toBe(false)
  })
})

describe('exactly the minimum quantity at market (10-01 live: 0.001 BTC refused as 83.915 < 83.92 USDT)', () => {
  it('compares LOT_SIZE on the quantity, not on two differently priced values', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('common/exchange_filters')) return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.001', minNotional: '50' } } } } })
      return base(url, init)
    })
    useSizeUnit().value = 'base'
    const host = await mountPanel()
    // ask above last: the minimum priced at the ask (83.92) is above the order priced at the last price (83.915)
    feedBook([[83920, 100]], [[83910, 100]])
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83915, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    await new Promise((resolve) => setTimeout(resolve, 250))
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    await type(q(host, 'fut-volume'), '0.001')
    expect(host.querySelector('.fop .field-error')?.textContent ?? '').toBe('')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ type: '2', side: 'BUY', open: 'OPEN' })
    // one contract below the minimum is still refused inline
    await type(q(host, 'fut-volume'), '0.0009')
    expect(host.querySelector('.fop .field-error')?.textContent ?? '').toContain('最小下单金额')
  })
})

describe('可开 below the minimum order says which limit binds (10-01 scenario S01 / S15)', () => {
  it('balance: 可用 too small for the minimum → 「可用余额不足以下最小单」 + 划转, not 「请输入数值」', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const text = String(url)
      if (text.includes('common/exchange_filters')) return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.0001', minNotional: '50' } } } } })
      if (text.includes('position/get_assets_list')) return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '0.4', totalAmount: '0.4' }] } })
      return base(url, init)
    })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    q<HTMLButtonElement>(host, 'fut-type-tab-market').click()
    await flush()
    // Slider label 100%.
    ;[...host.querySelectorAll<HTMLButtonElement>('.fop .pct-label')].find((b) => b.textContent?.trim() === '100%')?.click()
    await flush()
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    const text = q<HTMLElement>(host, 'fut-submit-error').textContent ?? ''
    expect(text).toContain('可用余额不足以下最小单（最少 50 USDT）')
    expect(text).not.toContain('请输入数值')
    expect(q(host, 'fut-msg-transfer')).not.toBeNull()
    expect(orders).toHaveLength(0)
  })
})

describe('min order on a LIMIT ticket too (live check 10-01: 5 USDT on ETH limit showed nothing)', () => {
  it('uses the same whole-contract minimum for the limit placeholder, rejection and accepted order', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('common/exchange_filters')) return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', minQty: '0.0001', minNotional: '50' } } } } })
      return base(url, init)
    })
    const host = await mountPanel()
    useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_ticker', tick: { close: 83450, open: 83000, high: 84000, low: 82000, vol: 1, amount: 1, rose: 0 } } as never)
    q<HTMLButtonElement>(host, 'fut-type-tab-limit').click()
    await flush()
    await type(host.querySelector<HTMLInputElement>('.fop input[aria-label="委托价格"]')!, '83450')
    const volume = q<HTMLInputElement>(host, 'fut-volume')
    expect(volume.placeholder).toBe('最小 50.07 USDT')
    // 50 USDT reaches the configured notional minimum but buys only five contracts.
    await type(volume, '50')
    expect(host.querySelector('.fop .field-error')?.textContent ?? '').toBe('最小下单金额 50.07 USDT')
    expect(q(host, 'fut-submit-error').textContent).toContain('最小下单金额 50.07 USDT')
    expect(orders).toHaveLength(0)
    await type(volume, '50.07')
    expect(host.querySelector('.fop .field-error')).toBeNull()
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ open: 'OPEN', volume: '6' })
  })
})

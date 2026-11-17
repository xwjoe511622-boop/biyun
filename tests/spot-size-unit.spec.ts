// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App, type VNode } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import {
  SPOT_UNIT_KEY, checkSpotFilters, defaultSpotUnit, effectiveStep, floorToStep, maxInUnit, percentToAmount, readSpotUnit,
  saveSpotUnit, toSpotWire, wireToPercent, type SpotEntryMarket,
} from '@/modules/trade/spot-size-unit'

const BTC_FILTER = { tickSize: '0.01', stepSize: '0.00001', minQty: '0.00001', maxQty: '9000', minNotional: '5', marketMaxQty: '100' }

vi.mock('@/modules/api/exchange-filters', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/api/exchange-filters')>()
  return { ...original, loadSpotFilters: () => Promise.resolve({ btcusdt: BTC_FILTER }) }
})

const m = (refPrice: string): SpotEntryMarket => ({ step: '0.00001', quotePrecision: 2, refPrice })

describe('spot size unit — conversions', () => {
  it('limit by USDT total: qty = floor(total / price, step), exact total', () => {
    expect(toSpotWire('1', 'BUY', 'quote', '6', m('60000'))).toEqual({ volume: '0.0001', baseQty: '0.0001', quoteTotal: '6', estimated: false, needsPrice: false })
    // 7 / 60000 = 0.000116666… → 0.00011 BTC, spending 6.6 USDT (never above what was typed)
    expect(toSpotWire('1', 'SELL', 'quote', '7', m('60000'))).toMatchObject({ volume: '0.00011', quoteTotal: '6.6' })
    expect(toSpotWire('1', 'BUY', 'quote', '6', m(''))).toMatchObject({ volume: '', needsPrice: true })
  })

  it('limit by coin: typed quantity goes out unchanged', () => {
    expect(toSpotWire('1', 'BUY', 'base', '0.00012', m('60000'))).toEqual({ volume: '0.00012', baseQty: '0.00012', quoteTotal: '7.2', estimated: false, needsPrice: false })
  })

  it('market BUY by USDT is native (volume = quote amount); by coin it spends qty × best ask', () => {
    expect(toSpotWire('2', 'BUY', 'quote', '6', m('60000'))).toMatchObject({ volume: '6', quoteTotal: '6', baseQty: '0.0001', estimated: true })
    expect(toSpotWire('2', 'BUY', 'quote', '6', m(''))).toMatchObject({ volume: '6', baseQty: '', needsPrice: false })
    expect(toSpotWire('2', 'BUY', 'base', '0.00015', m('60001.37'))).toMatchObject({ volume: '9', baseQty: '0.00015', estimated: true })
    expect(toSpotWire('2', 'BUY', 'base', '0.001', m(''))).toMatchObject({ volume: '', needsPrice: true })
  })

  it('market SELL by USDT converts at the best bid and floors to the step', () => {
    expect(toSpotWire('2', 'SELL', 'quote', '10', m('59999'))).toMatchObject({ volume: '0.00016', baseQty: '0.00016', estimated: true })
    expect(toSpotWire('2', 'SELL', 'base', '0.5', m('60000'))).toMatchObject({ volume: '0.5', quoteTotal: '30000', estimated: true })
  })

  it('rounds with decimals only (no binary float drift)', () => {
    expect(floorToStep('0.3', '0.1')).toBe('0.3')
    expect(floorToStep('1.23456789', '0.00001')).toBe('1.23456')
    expect(effectiveStep(undefined, 8)).toBe('0.00000001')
    expect(effectiveStep('0.0010', 8)).toBe('0.001')
  })

  it('percent works in both units and the max is shown in the selected unit', () => {
    expect(percentToAmount(50, 'BUY', 'quote', '1000.555', m('60000'))).toBe('500.27')
    expect(percentToAmount(100, 'BUY', 'base', '1000', m('60000'))).toBe('0.01666')
    expect(percentToAmount(100, 'SELL', 'base', '0.123456789', m('60000'))).toBe('0.12345')
    expect(percentToAmount(100, 'SELL', 'quote', '0.12345', m('60000'))).toBe('7407')
    expect(percentToAmount(25, 'BUY', 'base', '1000', m(''))).toBe('')
    expect(maxInUnit('BUY', 'base', '1000', m('60000'))).toBe('0.01666')
    expect(maxInUnit('SELL', 'quote', '0', m('60000'))).toBe('0')
    expect(wireToPercent('BUY', toSpotWire('1', 'BUY', 'quote', '250', m('60000')), '1000')).toBe(25)
  })
})

describe('spot size unit — filters', () => {
  const check = (type: '1' | '2', side: 'BUY' | 'SELL', unit: 'base' | 'quote', amount: string, price: string, ref: string) =>
    checkSpotFilters(type, side, unit, amount, price, toSpotWire(type, side, unit, amount, m(ref)), BTC_FILTER).map((entry) => entry.key)

  it('min notional 5 USDT for limit and market orders', () => {
    expect(check('1', 'BUY', 'quote', '4.99', '60000', '60000')).toEqual(['minNotional'])
    expect(check('1', 'BUY', 'base', '0.00008', '60000', '60000')).toEqual(['minNotional'])
    expect(check('2', 'BUY', 'quote', '4', '', '60000')).toEqual(['minNotional'])
    expect(check('1', 'BUY', 'quote', '6', '60000', '60000')).toEqual([])
  })

  it('step size, tick size, market max and zero after rounding', () => {
    expect(check('1', 'SELL', 'base', '0.000123', '60000', '60000')).toContain('step')
    expect(check('1', 'BUY', 'base', '0.001', '60000.005', '60000.005')).toContain('tick')
    expect(check('2', 'SELL', 'base', '101', '', '60000')).toContain('marketMaxQty')
    expect(check('1', 'BUY', 'quote', '0.5', '60000', '60000')).toEqual(['roundsToZero'])
    expect(check('1', 'BUY', 'quote', '6', '', '')).toEqual(['needsPrice'])
  })
})

describe('spot size unit — persistence', () => {
  beforeEach(() => localStorage.clear())

  it('defaults keep the old behaviour and the choice is remembered per type and side', () => {
    expect(defaultSpotUnit('2', 'BUY')).toBe('quote')
    expect(readSpotUnit('1', 'BUY')).toBe('base')
    saveSpotUnit('1', 'BUY', 'quote')
    expect(readSpotUnit('1', 'BUY')).toBe('quote')
    expect(readSpotUnit('1', 'SELL')).toBe('base')
    localStorage.setItem(SPOT_UNIT_KEY, 'not json')
    expect(readSpotUnit('2', 'BUY')).toBe('quote')
  })
})

/* ------------------------------------------------------------------ OrderForm payloads */

const RouterLinkStub = defineComponent({ name: 'RouterLink', props: { to: { type: String, required: true } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })

describe('OrderForm 货币单位 — payloads sent', () => {
  let pinia: Pinia
  let host: HTMLDivElement
  let apps: App[] = []

  beforeEach(async () => {
    localStorage.clear()
    const { session } = await import('@/core/session')
    session.clear()
    session.setToken('synthetic-spot-unit-session')
    pinia = createPinia()
    setActivePinia(pinia)
    host = document.createElement('div')
    document.body.appendChild(host)
    apps = []
    const { useMarketStore } = await import('@/stores/market')
    const { useAccountStore } = await import('@/stores/account')
    const market = useMarketStore()
    market.publicInfo = { market: { market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01' } } } } }
    market.selectedPair = 'BTC/USDT'
    market.ticker = { ...market.ticker, close: '60000' }
    market.asks = [{ price: '60010', amount: '1', total: '1', diff: 0 }, { price: '60001.37', amount: '1', total: '1', diff: 0 }]
    market.buys = [{ price: '59999', amount: '1', total: '1', diff: 0 }, { price: '59990', amount: '1', total: '1', diff: 0 }]
    useAccountStore().data = { totalBalance: '0', allCoinMap: { BTC: { normal_balance: '0.123456789', lock_balance: '0' }, USDT: { normal_balance: '1000', lock_balance: '0' } } }
  })

  afterEach(async () => {
    apps.forEach((app) => app.unmount())
    disposePinia(pinia)
    const { session } = await import('@/core/session')
    session.clear()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  async function mount(render: () => VNode): Promise<void> {
    const { default: enUS } = await import('@/i18n/locales/en-US')
    const app = createApp(defineComponent({ setup: () => render }))
    app.use(pinia)
    app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS } }))
    app.component('RouterLink', RouterLinkStub)
    app.mount(host)
    apps.push(app)
    await new Promise((resolve) => setTimeout(resolve, 0)) // filters promise
    await nextTick()
  }

  async function type(element: HTMLInputElement, value: string): Promise<void> {
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  async function chooseUnit(scope: HTMLElement, testid: string, value: 'base' | 'quote'): Promise<void> {
    scope.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click()
    await nextTick()
    // The option list is teleported to <body> (TicketPopover).
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testid}-${value}"]`)!.click()
    await nextTick()
  }

  async function setup(side: 'BUY' | 'SELL', orderType: '1' | '2') {
    const { default: OrderForm } = await import('@/components/trade/OrderForm.vue')
    const { useOrdersStore } = await import('@/stores/orders')
    const orders = useOrdersStore()
    const sent: unknown[] = []
    vi.spyOn(orders, 'submitOrder').mockImplementation(async (payload) => { sent.push(payload); return true })
    await mount(() => h(OrderForm, { side, orderType }))
    const scope = host.querySelector<HTMLElement>('section.order-form')!
    return { scope, sent, submit: async () => { scope.querySelector<HTMLButtonElement>('button.submit-button')!.click(); await nextTick(); await nextTick() } }
  }

  it('limit BUY by USDT total sends the floored BTC quantity', async () => {
    const { scope, sent, submit } = await setup('BUY', '1')
    await chooseUnit(scope, 'spot-unit-buy', 'quote')
    await type(scope.querySelector<HTMLInputElement>('input[aria-label="Price (USDT)"]')!, '60000')
    await type(scope.querySelector<HTMLInputElement>('input[aria-label="Amount (USDT)"]')!, '7')
    expect(scope.querySelector('[data-testid="spot-converted"]')?.textContent).toBe('0.00011')
    expect(scope.querySelector('[data-testid="spot-max-buy"]')?.textContent).toContain('1000 USDT')
    await submit()
    expect(sent).toEqual([{ side: 'BUY', type: '1', price: '60000', volume: '0.00011' }])
    expect(readSpotUnit('1', 'BUY')).toBe('quote')
  })

  it('建议-020: limit BUY by USDT shows the rounded order, why it is disabled and the minimum at this price', async () => {
    const { scope } = await setup('BUY', '1')
    await chooseUnit(scope, 'spot-unit-buy', 'quote')
    await type(scope.querySelector<HTMLInputElement>('input[aria-label="Price (USDT)"]')!, '60000')
    const amount = scope.querySelector<HTMLInputElement>('input[aria-label="Amount (USDT)"]')!
    // 5.4 USDT works at 60000 (0.00009 BTC); placeholder names it before typing
    expect(amount.placeholder).toBe('Min total 5.40 USDT')
    await type(amount, '4.99')
    const reason = scope.querySelector('[data-testid="spot-block-buy"]')?.textContent ?? ''
    expect(reason).toContain('Rounds to 0.00008 BTC ≈ 4.80 USDT')
    expect(reason).toContain('Total must be at least 5 USDT')
    expect(reason).toContain('the minimum is 5.40 USDT (0.00009 BTC)')
    expect(scope.querySelector<HTMLButtonElement>('button.submit-button')!.disabled).toBe(true)
    await type(amount, '5.4')
    expect(scope.querySelector('[data-testid="spot-block-buy"]')).toBeNull()
    expect(scope.querySelector('[data-testid="spot-rounded-buy"]')?.textContent).toContain('0.00009 BTC ≈ 5.40 USDT')
    expect(scope.querySelector<HTMLButtonElement>('button.submit-button')!.disabled).toBe(false)
  })

  it('market BUY by USDT sends the USDT amount; by BTC it sends qty × best ask', async () => {
    const { scope, sent, submit } = await setup('BUY', '2')
    await type(scope.querySelector<HTMLInputElement>('input[aria-label="Amount (USDT)"]')!, '6')
    await submit()
    await chooseUnit(scope, 'spot-unit-buy', 'base')
    await type(scope.querySelector<HTMLInputElement>('input[aria-label="Amount (BTC)"]')!, '0.00015')
    expect(scope.querySelector('[data-testid="spot-converted"]')?.textContent).toBe('≈ 9.00')
    await submit()
    expect(sent).toEqual([{ side: 'BUY', type: '2', price: '', volume: '6' }, { side: 'BUY', type: '2', price: '', volume: '9' }])
  })

  it('market SELL by USDT: 100 % sells the whole (step-floored) balance; below 5 USDT is refused in Chinese-keyed text', async () => {
    const { scope, sent, submit } = await setup('SELL', '2')
    await chooseUnit(scope, 'spot-unit-sell', 'quote')
    expect(scope.querySelector('[data-testid="spot-max-sell"]')?.textContent).toContain('7406.87 USDT')
    scope.querySelector<HTMLElement>('[role="slider"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    const amount = scope.querySelector<HTMLInputElement>('input[aria-label="Amount (USDT)"]')!
    expect(amount.value).toBe('7406.87')
    await submit()
    expect(sent).toEqual([{ side: 'SELL', type: '2', price: '', volume: '0.12345' }])
    await type(amount, '4')
    amount.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(scope.querySelector('.field-error')?.textContent).toBe('Total must be at least 5 USDT')
    expect(scope.querySelector<HTMLButtonElement>('button.submit-button')!.disabled).toBe(true)
  })
})

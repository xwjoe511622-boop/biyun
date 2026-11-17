// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type VNode } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import OrderForm from '@/components/trade/OrderForm.vue'
import { session } from '@/core/session'
import { SKIN } from '@/core/skin'
import enUS from '@/i18n/locales/en-US'
import type { OrderType } from '@/modules/finance/precision'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'

const LIMIT: OrderType = '1'
const MARKET: OrderType = '2'

const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
})

let pinia: Pinia
let host: HTMLDivElement
let mountedApps: App[] = []

beforeEach(() => {
  session.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  mountedApps = []
})

afterEach(() => {
  mountedApps.forEach((app) => app.unmount())
  disposePinia(pinia)
  session.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function prepareState(authenticated: boolean): void {
  if (authenticated) {
    session.setToken('synthetic-order-ticket-session')
  }

  const market = useMarketStore()
  market.publicInfo = {
    market: {
      market: {
        USDT: {
          'BTC/USDT': {
            symbol: 'btcusdt',
            name: 'BTC/USDT',
            price: 2,
            volume: 8,
            depth: '0.01',
          },
        },
      },
    },
  }
  market.selectedPair = 'BTC/USDT'

  const account = useAccountStore()
  account.data = {
    totalBalance: '1002',
    allCoinMap: {
      BTC: { normal_balance: '2', lock_balance: '0' },
      USDT: { normal_balance: '1000', lock_balance: '0' },
    },
  }
}

function mountTickets(render: () => VNode): void {
  const Root = defineComponent({
    setup() {
      return render
    },
  })
  const app = createApp(Root)
  app.use(pinia)
  app.use(createI18n({
    legacy: false,
    locale: 'en-US',
    fallbackLocale: 'en-US',
    messages: { 'en-US': enUS },
  }))
  app.component('RouterLink', RouterLinkStub)
  app.mount(host)
  mountedApps.push(app)
}

function ticket(label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)
  if (element === null) {
    throw new Error(`Missing order ticket: ${label}`)
  }
  return element
}

function input(scope: HTMLElement, label: string): HTMLInputElement {
  const element = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (element === null) {
    throw new Error(`Missing input: ${label}`)
  }
  return element
}

function suffix(element: HTMLInputElement): string {
  return element.closest('.field-input')?.querySelector('.field-suffix')?.textContent?.trim() ?? ''
}

async function setInput(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('side-by-side order ticket', () => {
  it('uses clicked depth prices only for idle limit tickets without changing their amounts', async () => {
    prepareState(true)
    const suggestion = ref<{ price: string; sequence: number }>()
    const kind = ref<OrderType>(LIMIT)
    mountTickets(() => h(OrderForm, { side: 'BUY', orderType: kind.value, priceSuggestion: suggestion.value }))
    await setInput(input(ticket('Buy BTC'), 'Amount (BTC)'), '0.01')
    suggestion.value = { price: '102.50', sequence: 1 }
    await nextTick()
    expect(input(ticket('Buy BTC'), 'Price (USDT)').value).toBe('102.5')
    expect(input(ticket('Buy BTC'), 'Amount (BTC)').value).toBe('0.01')
    useOrdersStore().submitting = true
    suggestion.value = { price: '103', sequence: 2 }
    await nextTick()
    expect(input(ticket('Buy BTC'), 'Price (USDT)').value).toBe('102.5')
    useOrdersStore().submitting = false
    kind.value = MARKET
    await nextTick()
    suggestion.value = { price: '104', sequence: 3 }
    await nextTick()
    expect(ticket('Buy BTC').querySelector('input[aria-label="Price (USDT)"]')).toBeNull()
  })
  it('keeps BUY and SELL draft inputs independent', async () => {
    prepareState(true)
    mountTickets(() => h('div', [
      h(OrderForm, { side: 'BUY', orderType: LIMIT }),
      h(OrderForm, { side: 'SELL', orderType: LIMIT }),
    ]))

    const buyVolume = input(ticket('Buy BTC'), 'Amount (BTC)')
    const sellVolume = input(ticket('Sell BTC'), 'Amount (BTC)')

    await setInput(buyVolume, '0.1')
    await setInput(sellVolume, '0.2')

    expect(buyVolume.value).toBe('0.1')
    expect(sellVolume.value).toBe('0.2')
  })

  it('uses a quote amount for market BUY and a base volume for market SELL', () => {
    prepareState(true)
    mountTickets(() => h('div', [
      h(OrderForm, { side: 'BUY', orderType: MARKET }),
      h(OrderForm, { side: 'SELL', orderType: MARKET }),
    ]))

    const buyVolume = input(ticket('Buy BTC'), 'Amount (USDT)')
    const sellVolume = input(ticket('Sell BTC'), 'Amount (BTC)')

    expect(buyVolume.getAttribute('aria-label')).toBe('Amount (USDT)')
    expect(suffix(buyVolume)).toBe('USDT')
    expect(sellVolume.getAttribute('aria-label')).toBe('Amount (BTC)')
    expect(suffix(sellVolume)).toBe('BTC')
  })

  it('clears the amount when the order type changes', async () => {
    prepareState(true)
    const orderType = ref<OrderType>(LIMIT)
    mountTickets(() => h(OrderForm, { side: 'BUY', orderType: orderType.value }))

    const buyTicket = ticket('Buy BTC')
    await setInput(input(buyTicket, 'Amount (BTC)'), '0.25')

    orderType.value = MARKET
    await nextTick()

    const marketBuyTicket = ticket('Buy BTC')
    expect(input(marketBuyTicket, 'Amount (USDT)').value).toBe('')
  })

  it('floors slider amounts to the server precision (market buy: price precision, sell: volume precision)', async () => {
    prepareState(true)
    const account = useAccountStore()
    account.data = {
      totalBalance: '0',
      allCoinMap: {
        BTC: { normal_balance: '1.123456789', lock_balance: '0' },
        USDT: { normal_balance: '159625.746447', lock_balance: '0' },
      },
    }
    mountTickets(() => h('div', [h(OrderForm, { side: 'BUY', orderType: MARKET }), h(OrderForm, { side: 'SELL', orderType: LIMIT })]))
    await nextTick()

    const buy = ticket('Buy BTC')
    buy.querySelector<HTMLElement>('[role="slider"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    expect(input(buy, 'Amount (USDT)').value).toBe('159625.74')

    const sell = ticket('Sell BTC')
    sell.querySelector<HTMLElement>('[role="slider"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    expect(input(sell, 'Amount (BTC)').value).toBe('1.12345678')
  })

  it('renders side-colored login actions and no submit control while logged out', () => {
    prepareState(false)
    mountTickets(() => h('div', [
      h(OrderForm, { side: 'BUY', orderType: LIMIT }),
      h(OrderForm, { side: 'SELL', orderType: LIMIT }),
    ]))

    const buyTicket = ticket('Buy BTC')
    const sellTicket = ticket('Sell BTC')
    const buyLink = buyTicket.querySelector<HTMLAnchorElement>('a.btn-buy[href="/login"]')
    const sellLink = sellTicket.querySelector<HTMLAnchorElement>('a.btn-sell[href="/login"]')

    expect(buyTicket.querySelector('button.btn-buy')).toBeNull()
    expect(sellTicket.querySelector('button.btn-sell')).toBeNull()
    expect(buyLink?.textContent?.trim()).toBe(SKIN === 'okx' ? 'Sign in/Sign up' : 'Buy')
    expect(sellLink?.textContent?.trim()).toBe(SKIN === 'okx' ? 'Sign in/Sign up' : 'Sell')
    expect(useOrdersStore().submitting).toBe(false)
  })

  it('disables both directions while the shared order store is submitting', async () => {
    prepareState(true)
    mountTickets(() => h('div', [
      h(OrderForm, { side: 'BUY', orderType: LIMIT }),
      h(OrderForm, { side: 'SELL', orderType: LIMIT }),
    ]))
    for (const name of ['Buy BTC', 'Sell BTC']) {
      await setInput(input(ticket(name), 'Price (USDT)'), '102')
      await setInput(input(ticket(name), 'Amount (BTC)'), '0.01')
    }
    const controls = [...host.querySelectorAll<HTMLButtonElement>('button.btn-buy,button.btn-sell')]
    expect(controls).toHaveLength(2)
    expect(controls.every(button => !button.disabled)).toBe(true)
    useOrdersStore().submitting = true
    await nextTick()
    expect(controls.every(button => button.disabled)).toBe(true)
    useOrdersStore().submitting = false
    await nextTick()
    expect(controls.every(button => !button.disabled)).toBe(true)
  })
})

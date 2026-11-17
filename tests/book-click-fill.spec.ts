// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import OrderBook from '@/components/trade/OrderBook.vue'
import OrderForm from '@/components/trade/OrderForm.vue'
import { session } from '@/core/session'
import enUS from '@/i18n/locales/en-US'
import { SPOT_UNIT_KEY } from '@/modules/trade/spot-size-unit'
import { bookSuggestion, type BookPick, type PriceSuggestion } from '@/modules/trade/book-fill'
import { useAccountStore } from '@/stores/account'
import { useMarketStore, type DepthLevel } from '@/stores/market'

/**
 * Spot order-book click-to-fill (Binance, 2026-09-30): both tickets take the clicked price; the ticket that takes the
 * level (ask → 买入, bid → 卖出) also takes the cumulative amount from the best level, floored to the step and capped by
 * the balance, in its unit.
 */
let pinia: Pinia
let host: HTMLDivElement
let apps: App[] = []

beforeEach(() => {
  session.clear()
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  apps = []
  session.setToken('synthetic-book-click')
  const market = useMarketStore()
  market.publicInfo = { market: { market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01' } } } } }
  market.selectedPair = 'BTC/USDT'
  useAccountStore().data = { totalBalance: '1002', allCoinMap: { BTC: { normal_balance: '2', lock_balance: '0' }, USDT: { normal_balance: '1000', lock_balance: '0' } } }
})

afterEach(() => {
  apps.forEach((app) => app.unmount())
  disposePinia(pinia)
  session.clear()
  localStorage.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function mount(render: () => ReturnType<typeof h>): void {
  const app = createApp(defineComponent({ setup: () => render }))
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, required: true } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.mount(host)
  apps.push(app)
}

function field(ticket: string, label: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`section[aria-label="${ticket}"] input[aria-label="${label}"]`)
  if (element === null) throw new Error(`missing ${ticket} / ${label}`)
  return element
}

function tickets(suggestion: ReturnType<typeof ref<PriceSuggestion>>): void {
  mount(() => h('div', [
    h(OrderForm, { side: 'BUY', orderType: '1', priceSuggestion: suggestion.value }),
    h(OrderForm, { side: 'SELL', orderType: '1', priceSuggestion: suggestion.value }),
  ]))
}

describe('spot ticket: order-book click fills price and cumulative amount', () => {
  it('an ask click fills the buy ticket amount; the sell ticket takes the price only', async () => {
    const suggestion = ref<PriceSuggestion>()
    tickets(suggestion)
    suggestion.value = { price: '100', sequence: 1, side: 'BUY', amount: '3.456789' }
    await nextTick()
    expect(field('Buy BTC', 'Price (USDT)').value).toBe('100')
    expect(field('Buy BTC', 'Amount (BTC)').value).toBe('3.456789')
    expect(field('Sell BTC', 'Price (USDT)').value).toBe('100')
    expect(field('Sell BTC', 'Amount (BTC)').value).toBe('')
  })

  it('caps the amount by the available balance (buy: USDT ÷ price, sell: coin)', async () => {
    const suggestion = ref<PriceSuggestion>()
    tickets(suggestion)
    suggestion.value = { price: '100', sequence: 1, side: 'BUY', amount: '50' }
    await nextTick()
    expect(field('Buy BTC', 'Amount (BTC)').value).toBe('10')
    suggestion.value = { price: '99', sequence: 2, side: 'SELL', amount: '5' }
    await nextTick()
    expect(field('Sell BTC', 'Amount (BTC)').value).toBe('2')
    expect(field('Buy BTC', 'Amount (BTC)').value).toBe('10')
  })

  it('respects the USDT unit (成交额 = quantity × price, rounded down)', async () => {
    localStorage.setItem(SPOT_UNIT_KEY, JSON.stringify({ 'limit:BUY': 'quote' }))
    const suggestion = ref<PriceSuggestion>()
    tickets(suggestion)
    suggestion.value = { price: '100.5', sequence: 1, side: 'BUY', amount: '3' }
    await nextTick()
    expect(field('Buy BTC', 'Amount (USDT)').value).toBe('301.5')
  })

  it('a price-only suggestion (last price click) keeps the typed amounts', async () => {
    const suggestion = ref<PriceSuggestion>()
    tickets(suggestion)
    const amount = field('Buy BTC', 'Amount (BTC)')
    amount.value = '0.5'
    amount.dispatchEvent(new Event('input'))
    await nextTick()
    suggestion.value = { price: '101', sequence: 1 }
    await nextTick()
    expect(field('Buy BTC', 'Price (USDT)').value).toBe('101')
    expect(field('Buy BTC', 'Amount (BTC)').value).toBe('0.5')
  })
})

describe('order book emits the clicked level', () => {
  it('rows emit price + { book, index }; the last price emits the price only', async () => {
    const market = useMarketStore()
    const level = (price: string, amount: string, total: string): DepthLevel => ({ price, amount, total, diff: 0 })
    market.asks = [level('101', '1', '1'), level('102', '2', '3')]
    market.buys = [level('99', '4', '4'), level('98', '5', '9')]
    market.ticker = { ...market.ticker, close: '100' }
    const picks: [string, BookPick | undefined][] = []
    mount(() => h(OrderBook, { onPrice: (price: string, pick?: BookPick) => picks.push([price, pick]) }))
    await nextTick()
    const asks = host.querySelectorAll<HTMLButtonElement>('.level.ask')
    // Both-sides view renders asks farthest first: the first button is 102 (index 1).
    asks[0].click()
    host.querySelectorAll<HTMLButtonElement>('.level.bid')[1].click()
    host.querySelector<HTMLButtonElement>('.mid-last')?.click()
    expect(picks).toEqual([['102', { book: 'ask', index: 1 }], ['98', { book: 'bid', index: 1 }], ['100', undefined]])
    const suggestion = bookSuggestion(undefined, '102', picks[0][1], { asks: market.asks, bids: market.buys })
    expect(suggestion).toEqual({ price: '102', sequence: 1, side: 'BUY', amount: '3' })
    expect(bookSuggestion(suggestion, '98', picks[1][1], { asks: market.asks, bids: market.buys })).toEqual({ price: '98', sequence: 2, side: 'SELL', amount: '9' })
  })
})

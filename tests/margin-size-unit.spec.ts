// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import MarginOrderForm from '@/components/margin/MarginOrderForm.vue'
import { session } from '@/core/session'
import enUS from '@/i18n/locales/en-US'
import type { PublicInfoV4 } from '@/modules/api/types'
import * as marginApi from '@/modules/margin/api'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import { SPOT_UNIT_KEY } from '@/modules/trade/spot-size-unit'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'

/** Margin ticket 货币单位 (2026-09-30): an amount typed in USDT is converted to the base quantity sent on the wire. */
vi.mock('@/modules/margin/api', () => ({
  fetchMarginOpenOrders: vi.fn(), fetchMarginHistoryOrders: vi.fn(), createMarginOrder: vi.fn(), cancelMarginOrder: vi.fn(), fetchMarginSymbolAccount: vi.fn(),
}))

let pinia: Pinia
let host: HTMLDivElement
let app: App | null = null
const account = { symbol: 'btcusdt', baseCoin: 'BTC', quoteCoin: 'USDT', baseNormalBalance: '1', baseLockBalance: '0', quoteNormalBalance: '500', quoteLockBalance: '0' } as MarginSymbolAccount

beforeEach(() => {
  session.clear()
  localStorage.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  const market = useMarketStore()
  market.publicInfo = {
    switch: { lever_open: '1' },
    market: { coinList: { BTC: { showPrecision: 8 }, USDT: { showPrecision: 2 } }, market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1 } } } },
  } as unknown as PublicInfoV4
  market.selectedPair = 'BTC/USDT'
  session.setToken('synthetic-margin-unit')
  vi.mocked(marginApi.fetchMarginOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
  vi.mocked(marginApi.fetchMarginSymbolAccount).mockResolvedValue(account)
  vi.mocked(marginApi.createMarginOrder).mockResolvedValue({ order_id: 'm9' } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function mountForm(side: 'BUY' | 'SELL' = 'BUY'): Promise<void> {
  await useMarginStore().loadAccount()
  app = createApp(defineComponent({ setup: () => () => h(MarginOrderForm, { side, orderType: '1' }) }))
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, required: true } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.mount(host)
  await nextTick()
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('margin ticket size unit', () => {
  it.each([
    ['BUY', '9007199254740993.1234567890123456', '9,007,199,254,740,993.12'],
    ['SELL', '0.0000000000000001', '0'],
  ] as const)('QA-166 truncates %s display at coin precision and retains the full balance', async (side, balance, shown) => {
    vi.mocked(marginApi.fetchMarginSymbolAccount).mockResolvedValue({ ...account, [side === 'BUY' ? 'quoteNormalBalance' : 'baseNormalBalance']: balance })
    await mountForm(side)
    const value = host.querySelector('.meta-row .num')
    expect(value?.textContent).toBe(shown)
    expect(value?.getAttribute('title')).toBe(balance)
    expect(vi.mocked(marginApi.createMarginOrder)).not.toHaveBeenCalled()
  })
  it('sends the base quantity for an amount typed in USDT (limit buy)', async () => {
    localStorage.setItem(SPOT_UNIT_KEY, JSON.stringify({ 'limit:BUY': 'quote' }))
    await mountForm()
    const inputs = host.querySelectorAll<HTMLInputElement>('input')
    type(inputs[0], '100')
    type(inputs[1], '250')
    await nextTick()
    expect(host.querySelector('[data-testid="margin-converted"]')?.textContent).toContain('2.5 BTC')
    host.querySelector<HTMLButtonElement>('button.submit-button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(vi.mocked(marginApi.createMarginOrder)).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(marginApi.createMarginOrder).mock.calls[0])).toContain('"volume":"2.5"')
  })

  it('keeps the coin quantity when the unit is the coin', async () => {
    await mountForm()
    const inputs = host.querySelectorAll<HTMLInputElement>('input')
    type(inputs[0], '100')
    type(inputs[1], '1.2')
    await nextTick()
    host.querySelector<HTMLButtonElement>('button.submit-button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.stringify(vi.mocked(marginApi.createMarginOrder).mock.calls[0])).toContain('"volume":"1.2"')
  })
})

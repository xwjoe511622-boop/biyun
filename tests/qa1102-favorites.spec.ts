// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import MarketTable from '@/components/market/MarketTable.vue'
import PairListPanel from '@/components/trade/PairListPanel.vue'
import SymbolPicker from '@/components/trade/SymbolPicker.vue'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'

let app: App | undefined
let pinia: Pinia | undefined
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear() })
async function flush(): Promise<void> { await nextTick(); await nextTick() }
function star(section: string, coin: string): HTMLButtonElement {
  const rows = [...document.querySelectorAll(`${section} tbody tr, ${section} .pl-row, ${section} .opl-row`)]
  const found = rows.find(row => row.textContent?.includes(coin))?.querySelector<HTMLButtonElement>('button.star, button.pl-star')
  if (!found) throw new Error(`Missing ${coin} favorite in ${section}`)
  return found
}

it('QA-164 shares favorites across real markets/terminal components without overwriting another component', async () => {
  localStorage.setItem('longbit.markets.favorites.v1', JSON.stringify(['ETH/USDT']))
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')))
  pinia = createPinia(); setActivePinia(pinia)
  const market = useMarketStore()
  market.publicInfo = { market: { coinList: {}, market: { USDT: {
    'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 8, depth: '0.01' },
    'ETH/USDT': { symbol: 'ethusdt', name: 'ETH/USDT', price: 2, volume: 8, depth: '0.01' },
  } } } }
  market.selectedPair = 'BTC/USDT'
  vi.spyOn(market, 'loadTrends').mockImplementation(() => undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/'); await router.isReady()
  app = createApp(defineComponent({ setup: () => () => h('div', [h(MarketTable), h('section', { id: 'terminal' }, [h(PairListPanel), h(SymbolPicker)])]) }))
    .use(pinia).use(router).use(createI18n({ legacy: false, locale: 'en-US', messages: { 'en-US': enUS } }))
  app.mount(document.body.appendChild(document.createElement('div'))); await flush()
  expect(star('.market-table', 'ETH').getAttribute('aria-pressed')).toBe('true')
  star('.market-table', 'BTC').click(); await flush()
  expect(star('#terminal', 'BTC').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.pair-star')?.getAttribute('aria-pressed') ?? 'true').toBe('true')
  star('#terminal', 'ETH').click(); await flush()
  expect(star('.market-table', 'ETH').getAttribute('aria-pressed')).toBe('false')
  expect(JSON.parse(localStorage.getItem('longbit.markets.favorites.v1') ?? '[]')).toEqual(['BTC/USDT'])
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  star('.market-table', 'BTC').click(); await flush()
  expect(star('#terminal', 'BTC').getAttribute('aria-pressed')).toBe('false')
  expect(fetch).not.toHaveBeenCalled()
})

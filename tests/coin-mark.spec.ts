// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CoinMark from '@/components/common/CoinMark.vue'
import { useMarketStore } from '@/stores/market'
import type { PublicInfoV4 } from '@/modules/api/types'

// New markets (2026-09-27): ETH, XAUT, NVDA, TSLA. Icons come from public_info coinList[COIN].icon even when the caller
// passes none; without an icon the coin gets its own glyph tile.
let app: App | null = null
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = '' })

function render(symbol: string, iconUrl = ''): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp({ render: () => h(CoinMark, { symbol, iconUrl }) })
  app.use(pinia)
  const store = useMarketStore()
  store.publicInfo = { market: { coinList: { NVDA: { icon: 'https://www.exchange.invalid/coins/nvda.png', showName: 'NVIDIA tokenized stock' } } } } as unknown as PublicInfoV4
  app.mount(host)
  return host
}

describe('CoinMark', () => {
  it('uses the public_info icon when the caller passes none', async () => {
    const el = render('NVDA')
    await nextTick()
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://www.exchange.invalid/coins/nvda.png')
  })

  it('renders known glyph tiles for the new markets', async () => {
    expect(render('XAUT').querySelector('.coin-mark-text')?.textContent).toBe('Au')
    app?.unmount()
    expect(render('TSLA').querySelector('.coin-mark-text')?.textContent).toBe('T')
    app?.unmount()
    expect(render('ETH').querySelector('.coin-mark-text')?.textContent).toBe('Ξ')
  })
})

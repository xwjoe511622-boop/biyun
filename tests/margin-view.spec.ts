// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import MarginTradeView from '@/views/margin/MarginTradeView.vue'
import { session } from '@/core/session'
import * as publicApi from '@/modules/api/public.api'
import type { PublicInfoV4 } from '@/modules/api/types'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only. The chart/book components are stubbed: this suite covers the margin shell.
vi.mock('@/modules/api/public.api', () => ({ fetchPublicInfo: vi.fn(), readCachedPublicInfo: vi.fn(() => null), PUBLIC_INFO_FRESH_MS: 60_000 }))
vi.mock('@/components/trade/ModernChart.vue', () => ({ default: { name: 'ModernChartStub', render: () => null } }))
vi.mock('@/components/trade/DepthChart.vue', () => ({ default: { name: 'DepthChartStub', render: () => null } }))
vi.mock('@/modules/margin/api', () => ({
  fetchMarginSymbolAccount: vi.fn().mockResolvedValue(null),
  fetchOpenBorrows: vi.fn().mockResolvedValue({ count: 0, list: [] }),
}))

function info(leverOpen: string, isOpenLever: number): PublicInfoV4 {
  return {
    switch: { lever_open: leverOpen },
    msg: {},
    market: {
      wsUrl: 'wss://127.0.0.1:9/never',
      coinList: {},
      market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: isOpenLever, multiple: 3 } } },
    },
  } as unknown as PublicInfoV4
}

let pinia: Pinia
let app: App | null = null
let host: HTMLDivElement

beforeEach(() => {
  session.clear()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  app = createApp(defineComponent({ setup: () => () => h(MarginTradeView) }))
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

describe('margin page shell', () => {
  it('shows a clear empty state when no pair has margin enabled (current live config)', async () => {
    vi.mocked(publicApi.fetchPublicInfo).mockResolvedValue(info('1', 0))
    await mount()
    const empty = host.querySelector('[data-testid="margin-empty"]')
    expect(empty?.textContent).toContain('No margin pairs yet')
    expect(empty?.querySelector('a[href="/trade"]')).not.toBeNull()
  })

  it('explains when the platform lever switch is off', async () => {
    vi.mocked(publicApi.fetchPublicInfo).mockResolvedValue(info('0', 1))
    await mount()
    expect(host.querySelector('[data-testid="margin-empty"]')?.textContent).toContain('Margin trading is not available')
  })
})

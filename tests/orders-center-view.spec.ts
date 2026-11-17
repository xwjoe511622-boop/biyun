// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import OrdersCenterView from '@/views/orders/OrdersCenterView.vue'
import * as csv from '@/components/orders/csv'
import { session } from '@/core/session'
import { BRAND_ID } from '@/core/brand'
import * as orderApi from '@/modules/api/order.api'
import * as exportApi from '@/modules/api/history-export.api'
import { useHistoryExport } from '@/components/history-export/state'
import type { OrderItem, PublicInfoV4, TradeItem } from '@/modules/api/types'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only: no request leaves the test.
vi.mock('@/modules/api/order.api', () => ({
  fetchOpenOrders: vi.fn(),
  fetchHistoryOrders: vi.fn(),
  fetchMyTrades: vi.fn(),
  cancelOrder: vi.fn(),
  fetchTradesByOrder: vi.fn(),
  createOrder: vi.fn(),
}))
vi.mock('@/modules/margin/api', () => ({
  fetchMarginOpenOrders: vi.fn(),
  fetchMarginHistoryOrders: vi.fn(),
  fetchOpenBorrows: vi.fn(),
  fetchBorrowHistory: vi.fn(),
  cancelMarginOrder: vi.fn(),
  fetchMarginTradesByOrder: vi.fn(),
}))
vi.mock('@/modules/api/history-export.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/api/history-export.api')>()
  return { ...actual, fetchExportInfo: vi.fn(), fetchExports: vi.fn(), createExport: vi.fn(), fetchDownloadLink: vi.fn() }
})
vi.mock('@/components/orders/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/orders/csv')>()
  return { ...actual, downloadCsv: vi.fn() }
})

const publicInfo = {
  switch: { lever_open: '1' },
  market: {
    coinList: {},
    market: {
      USDT: {
        'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01' },
        'ETH/USDT': { symbol: 'ethusdt', name: 'ETH/USDT', price: 2, volume: 4, depth: '0.01' },
      },
    },
  },
} as unknown as PublicInfoV4

const BASE = new Date('2026-09-20T12:00:00').getTime()

function order(id: string, minutesAgo: number, side = 'BUY'): OrderItem {
  return { id, side, status: 1, type: 1, price: '100', volume: '1', deal_volume: '0', deal_money: '0', avg_price: '0', time_long: BASE - minutesAgo * 60_000, created_at: `t-${id}` }
}

let pinia: Pinia
let app: App | null = null
let host: HTMLDivElement

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  session.setToken('synthetic-orders-session')
  useMarketStore().publicInfo = publicInfo
  useHistoryExport().reset()
  vi.mocked(exportApi.fetchExportInfo).mockResolvedValue({ hotFromMs: new Date('2026-09-10T00:00:00Z').getTime(), earliestMs: new Date('2026-09-01T00:00:00Z').getTime(), maxRangeDays: 366, per30Days: 10, used30Days: 0, waiting: 0, maxWaiting: 2, retentionDays: 7 })
  vi.mocked(exportApi.fetchExports).mockResolvedValue([])
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(): Promise<void> {
  const Root = defineComponent({ setup: () => () => h(OrdersCenterView) })
  app = createApp(Root)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
}

function q<T extends Element>(selector: string): T {
  const found = host.querySelector<T>(selector)
  if (found === null) throw new Error(`missing ${selector}: ${host.textContent ?? ''}`)
  return found
}

async function select(selector: string, value: string): Promise<void> {
  const element = q<HTMLSelectElement | HTMLInputElement>(selector)
  element.value = value
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  await flush()
}

function orderIds(): string[] {
  return [...host.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td')[9]?.textContent ?? '')
}

describe('orders centre', () => {
  it('reads every pair for "all pairs" and merges the rows by time', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockImplementation(async ({ symbol }) => (
      symbol === 'btcusdt'
        ? { count: 2, orderList: [order('b1', 1), order('b2', 30)] }
        : { count: 1, orderList: [order('e1', 10, 'SELL')] }
    ))
    await mount()
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'btcusdt', page: 1 }))
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ethusdt', page: 1 }))
    expect(orderIds()).toEqual(['b1', 'e1', 'b2'])
    expect(q('[data-testid="loaded-count"]').textContent).toContain('3 of 3')
  })

  it('narrows to one pair and passes the side filter to the server', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    await mount()
    vi.mocked(orderApi.fetchOpenOrders).mockClear()
    await select('[data-testid="filter-pair"]', 'ethusdt')
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledTimes(1)
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ethusdt' }))
    vi.mocked(orderApi.fetchOpenOrders).mockClear()
    await select('[data-testid="filter-side"]', 'SELL')
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ethusdt', side: 'SELL' }))
    expect(host.textContent).toContain('No records')
  })

  it('paginates the merged rows client-side', async () => {
    const list = Array.from({ length: 20 }, (_, index) => order(`o${index}`, index))
    vi.mocked(orderApi.fetchOpenOrders).mockImplementation(async ({ symbol }) => (symbol === 'btcusdt' ? { count: 20, orderList: list } : { count: 0, orderList: [] }))
    await mount()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(15)
    expect(q('[data-testid="page-info"]').textContent).toContain('Page 1 / 2')
    q<HTMLButtonElement>('[data-testid="page-next"]').click()
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(orderIds()[0]).toBe('o15')
  })

  it('exports the filtered rows as CSV with the build brand and on-screen columns in either skin', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockImplementation(async ({ symbol }) => (symbol === 'btcusdt' ? { count: 1, orderList: [order('b1', 1)] } : { count: 0, orderList: [] }))
    await mount()
    q<HTMLButtonElement>('[data-testid="export-csv"]').click()
    expect(csv.downloadCsv).toHaveBeenCalledTimes(1)
    const [filename, text] = vi.mocked(csv.downloadCsv).mock.calls[0]
    expect(filename).toMatch(new RegExp(`^${BRAND_ID}-spotOpen-\\d{12}\\.csv$`))
    expect(text.split('\r\n')[0]).toBe('Time,Pair,Side,Type,Price,Order quantity / amount,Filled,Avg. price,Value,Order ID')
    expect(text).toContain('t-b1,BTC/USDT,Buy,Limit,100.00,1 BTC,0,,0,b1')
  })

  it('filters fills by side on the client (trade/list has no side parameter)', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    const trades: TradeItem[] = [
      { id: 1, side: 'BUY', price: '100', volume: '1', deal_price: '100', fee: '0.1', feeCoin: 'usdt', time_long: BASE, ctime: 'x1' },
      { id: 2, side: 'SELL', price: '101', volume: '1', deal_price: '101', fee: '0.1', feeCoin: 'usdt', time_long: BASE - 1000, ctime: 'x2' },
    ]
    vi.mocked(orderApi.fetchMyTrades).mockImplementation(async ({ symbol }) => (symbol === 'btcusdt' ? { count: 2, trade_list: trades } : { count: 0, trade_list: [] }))
    await mount()
    q<HTMLButtonElement>('#wallet-tab-spotTrades').click()
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
    const calls = vi.mocked(orderApi.fetchMyTrades).mock.calls.length
    await select('[data-testid="filter-side"]', 'SELL')
    expect(vi.mocked(orderApi.fetchMyTrades).mock.calls.length).toBe(calls)
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(host.querySelector('tbody tr')?.textContent).toContain('x2')
  })

  it('links futures orders out instead of duplicating the futures API', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    await mount()
    q<HTMLButtonElement>('#wallet-tab-futures').click()
    await flush()
    expect(q('[data-testid="futures-link"]').querySelector('a[href="/futures"]')).not.toBeNull()
  })
  it('offers a statement instead of an empty table when the dates reach the archive', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    vi.mocked(orderApi.fetchHistoryOrders).mockResolvedValue({ count: 0, orderList: [] })
    await mount()
    q<HTMLButtonElement>('#wallet-tab-spotHistory').click()
    await flush()
    expect(host.querySelector('[data-testid="hx-archive-notice"]')).toBeNull()
    await select('[data-testid="filter-from"]', '2026-09-01')
    expect(q('[data-testid="hx-archive-notice"]').textContent).toContain('Older records are archived')
    expect(host.textContent).not.toContain('No records')
    q<HTMLButtonElement>('[data-testid="hx-open"]').click()
    await flush()
    const kind = document.body.querySelector<HTMLSelectElement>('[data-testid="hx-kind"]')
    expect(kind?.value).toBe('spot_orders')
    expect(document.body.querySelector<HTMLInputElement>('[data-testid="hx-from"]')?.value).toBe('2026-09-01')
    // a range inside the hot window keeps the normal empty state
    await select('[data-testid="filter-from"]', '2026-09-15')
    expect(host.querySelector('[data-testid="hx-archive-notice"]')).toBeNull()
    expect(host.textContent).toContain('No records')
  })

  it('lists statements on the export records tab without touching the order endpoints', async () => {
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    await mount()
    const calls = vi.mocked(orderApi.fetchOpenOrders).mock.calls.length
    q<HTMLButtonElement>('#wallet-tab-exports').click()
    await flush()
    expect(q('[data-testid="hx-records"]').textContent).toContain('No exports yet')
    expect(vi.mocked(orderApi.fetchOpenOrders).mock.calls.length).toBe(calls)
  })
})

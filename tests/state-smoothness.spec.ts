// @vitest-environment jsdom
/**
 * 2026-09-29 "下单后页面闪一下": state conventions for trading data (`@/core/swr`, `@/core/toast`).
 * - a refetch keeps the rendered rows (no StateBlock swap);
 * - optimistic pending row + balance on placement, rollback on refusal, row removal on a confirmed cancel;
 * - exactly one coalesced refresh per action;
 * - action results are toasts, never inline notices inside the ticket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import { commitAll, createBalanceOverlay, createCoalescedRefresh, listPhase, mergeById } from '@/core/swr'
import { clearToasts, useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { INITIAL_OPEN_STATE, openAccountReducer } from '@/modules/futures/open-account'
import * as orderApi from '@/modules/api/order.api'
import { fetchAccountBalance } from '@/modules/api/account.api'
import type { AccountBalanceData, OrderItem } from '@/modules/api/types'
import OrdersTabs from '@/components/trade/OrdersTabs.vue'
import OrderForm from '@/components/trade/OrderForm.vue'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'

vi.mock('@/modules/api/order.api', () => ({ fetchOpenOrders: vi.fn(), fetchHistoryOrders: vi.fn(), fetchMyTrades: vi.fn(), createOrder: vi.fn(), cancelOrder: vi.fn() }))
vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn() }))
vi.mock('@/modules/api/exchange-filters', async (original) => ({ ...(await original<typeof import('@/modules/api/exchange-filters')>()), loadSpotFilters: vi.fn(async () => ({})) }))

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await wait(0)
    await nextTick()
  }
}
/** Longer than the coalescing window (120 ms) plus the follow-up fetches. */
const settleRefresh = (): Promise<void> => wait(220).then(flush)

function order(id: string, price = '100', volume = '1', side = 'BUY'): OrderItem {
  return { id, side, type: 1, status: 1, price, volume, deal_volume: '0', created_at: '2026-09-29 10:00:00' }
}
function balance(usdt: string, btc = '1'): AccountBalanceData {
  return { totalBalance: '1', allCoinMap: { USDT: { normal_balance: usdt, lock_balance: '0' }, BTC: { normal_balance: btc, lock_balance: '0' } } } as AccountBalanceData
}

let pinia: Pinia
let app: App | null = null

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  clearToasts()
  pinia = createPinia()
  setActivePinia(pinia)
  const symbol = { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 4, depth: '0.01' }
  useMarketStore().publicInfo = { market: { market: { USDT: { 'BTC/USDT': symbol } } } }
  session.setToken('synthetic-test-session')
  vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 1, orderList: [order('o1')] })
  vi.mocked(orderApi.fetchHistoryOrders).mockResolvedValue({ count: 0, orderList: [] })
  vi.mocked(orderApi.fetchMyTrades).mockResolvedValue({ count: 0, trade_list: [] })
  vi.mocked(fetchAccountBalance).mockResolvedValue(balance('1000'))
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

function mount(component: object, props: Record<string, unknown> = {}): HTMLElement {
  app = createApp(defineComponent({ setup: () => () => h(component, props) }))
  app.use(pinia)
  app.use(i18n)
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return host
}

describe('swr helpers', () => {
  it('listPhase: rows win; loading only before the first answer; an error without rows is an error', () => {
    expect(listPhase({ rows: 0, loaded: false, error: null })).toBe('loading')
    expect(listPhase({ rows: 3, loaded: true, error: null })).toBe('ready')
    expect(listPhase({ rows: 3, loaded: true, error: 'offline' })).toBe('ready')
    expect(listPhase({ rows: 0, loaded: true, error: null })).toBe('empty')
    expect(listPhase({ rows: 0, loaded: false, error: 'offline' })).toBe('error')
  })

  it('mergeById keeps unchanged row objects and returns the same array when nothing changed', () => {
    const a = { id: '1', v: 1 }
    const b = { id: '2', v: 2 }
    const previous = [a, b]
    expect(mergeById(previous, [{ id: '1', v: 1 }, { id: '2', v: 2 }], (row) => row.id)).toBe(previous)
    const next = mergeById(previous, [{ id: '1', v: 1 }, { id: '2', v: 3 }], (row) => row.id)
    expect(next).not.toBe(previous)
    expect(next[0]).toBe(a)
    expect(next[1]).toEqual({ id: '2', v: 3 })
  })

  it('coalesces requests into one run with the union of parts, and one follow-up for requests made during a run', async () => {
    const runs: string[][] = []
    let release!: () => void
    const refresher = createCoalescedRefresh<string>(async (parts) => {
      runs.push([...parts].sort())
      if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
    }, 20)
    const first = refresher.request('open')
    void refresher.request('account')
    await wait(40)
    expect(runs).toEqual([['account', 'open']])
    void refresher.request('trades')
    void refresher.request('open')
    release()
    await first
    await wait(40)
    expect(runs).toEqual([['account', 'open'], ['open', 'trades']])
  })

  it('commitAll applies every commit in one synchronous block', () => {
    const order_: string[] = []
    commitAll([() => order_.push('a'), null, () => order_.push('b')])
    expect(order_).toEqual(['a', 'b'])
  })

  it('balance overlay: applied at once, rolled back on refusal, dropped by a snapshot requested after it settled', () => {
    const overlay = createBalanceOverlay()
    const kept = overlay.apply({ 'USDT:available': '-30' })
    expect(overlay.adjust('USDT:available', '100')).toBe('70')
    const refused = overlay.apply({ 'USDT:available': '-50' })
    refused.rollback()
    expect(overlay.adjust('USDT:available', '100')).toBe('70')
    const before = overlay.stamp()
    kept.settle()
    overlay.reconcile(before) // a snapshot requested before the order settled does not contain it: keep the delta
    expect(overlay.adjust('USDT:available', '100')).toBe('70')
    const after = overlay.stamp()
    overlay.reconcile(after)
    expect(overlay.adjust('USDT:available', '70')).toBe('70')
    expect(overlay.adjust('USDT:available', '')).toBe('')
  })

  it('a background re-check of an opened futures account does not flash "checking"', () => {
    const opened = openAccountReducer(INITIAL_OPEN_STATE, { type: 'config', openContract: true })
    expect(openAccountReducer(opened, { type: 'check' })).toBe(opened)
    expect(openAccountReducer(INITIAL_OPEN_STATE, { type: 'check' }).status).toBe('checking')
  })
})

describe('spot orders: stale-while-revalidate rendering', () => {
  it('keeps the rendered rows during a refetch (no loading StateBlock) and shows the loading block only on first load', async () => {
    let resolveFirst!: (value: { count: number; orderList: OrderItem[] }) => void
    vi.mocked(orderApi.fetchOpenOrders).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    const host = mount(OrdersTabs)
    await flush()
    expect(host.querySelector('.state.loading')).not.toBeNull()
    resolveFirst({ count: 1, orderList: [order('o1')] })
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    const row = host.querySelector('tbody tr')

    let resolveSecond!: (value: { count: number; orderList: OrderItem[] }) => void
    vi.mocked(orderApi.fetchOpenOrders).mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))
    const refetch = useOrdersStore().loadOpenOrders()
    await flush()
    expect(host.querySelector('.state')).toBeNull()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(host.querySelector('[data-testid="refresh-bar"]')?.classList.contains('active')).toBe(true)
    resolveSecond({ count: 1, orderList: [order('o1')] })
    await refetch
    await flush()
    // Same data → same row element (merge by id), no remount.
    expect(host.querySelector('tbody tr')).toBe(row)
  })

  it('a failed refresh keeps the rows and shows the reason next to them', async () => {
    const host = mount(OrdersTabs)
    await flush()
    vi.mocked(orderApi.fetchOpenOrders).mockRejectedValueOnce(new Error('offline'))
    await useOrdersStore().loadOpenOrders()
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(host.querySelector('.state')).toBeNull()
    expect(host.textContent).toContain('offline')
  })
})

describe('spot orders: optimistic actions and one refresh', () => {
  it('shows a pending row and moves the balance at once; one refresh after the server accepts', async () => {
    const orders = useOrdersStore()
    const account = useAccountStore()
    await Promise.all([orders.loadOpenOrders(), account.load()])
    vi.mocked(orderApi.fetchOpenOrders).mockClear()
    vi.mocked(fetchAccountBalance).mockClear()
    let accept!: (value: unknown) => void
    vi.mocked(orderApi.createOrder).mockReturnValueOnce(new Promise((resolve) => { accept = resolve }))

    const placing = orders.submitOrder({ side: 'BUY', type: '1', price: '50', volume: '2' })
    expect(orders.openOrders[0]).toMatchObject({ side: 'BUY', price: '50', volume: '2', pending: true })
    expect(orders.openCount).toBe(2)
    expect(account.quoteAvailable).toBe('900')

    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 2, orderList: [order('o2', '50', '2'), order('o1')] })
    vi.mocked(fetchAccountBalance).mockResolvedValue(balance('900'))
    accept({ order_id: 'o2' })
    expect(await placing).toBe(true)
    expect(orders.openOrders[0]).toMatchObject({ id: 'o2', pending: false })
    await settleRefresh()
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledTimes(1)
    expect(orderApi.fetchMyTrades).toHaveBeenCalledTimes(1)
    expect(fetchAccountBalance).toHaveBeenCalledTimes(1)
    expect(orders.openOrders.map((row) => row.id)).toEqual(['o2', 'o1'])
    expect(account.quoteAvailable).toBe('900')
  })

  it('rolls the pending row, the count and the balance back when the server refuses', async () => {
    const orders = useOrdersStore()
    const account = useAccountStore()
    await Promise.all([orders.loadOpenOrders(), account.load()])
    vi.mocked(orderApi.createOrder).mockRejectedValueOnce(new Error('余额不足'))
    expect(await orders.submitOrder({ side: 'BUY', type: '1', price: '50', volume: '2' })).toBe(false)
    expect(orders.openOrders.map((row) => row.id)).toEqual(['o1'])
    expect(orders.openCount).toBe(1)
    expect(account.quoteAvailable).toBe('1000')
    expect(orders.submitError).toBe('余额不足')
    await settleRefresh()
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledTimes(1)
  })

  it('a confirmed cancel removes the row and releases the balance at once; one refresh follows', async () => {
    const orders = useOrdersStore()
    const account = useAccountStore()
    await Promise.all([orders.loadOpenOrders(), account.load()])
    vi.mocked(orderApi.fetchOpenOrders).mockClear()
    vi.mocked(orderApi.fetchHistoryOrders).mockClear()
    vi.mocked(fetchAccountBalance).mockClear()
    let confirm!: (value: unknown) => void
    vi.mocked(orderApi.cancelOrder).mockReturnValueOnce(new Promise((resolve) => { confirm = resolve }))
    const canceling = orders.cancelOrder('o1')
    expect(orders.cancelingIds.has('o1')).toBe(true)
    expect(orders.openOrders).toHaveLength(1)
    vi.mocked(orderApi.fetchOpenOrders).mockResolvedValue({ count: 0, orderList: [] })
    confirm(null)
    expect(await canceling).toBe(true)
    expect(orders.openOrders).toHaveLength(0)
    expect(orders.openCount).toBe(0)
    expect(account.quoteAvailable).toBe('1100')
    await settleRefresh()
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledTimes(1)
    expect(orderApi.fetchHistoryOrders).toHaveBeenCalledTimes(1)
    expect(fetchAccountBalance).toHaveBeenCalledTimes(1)
  })

  it('two quick actions share one refresh run', async () => {
    const orders = useOrdersStore()
    await Promise.all([orders.loadOpenOrders(), useAccountStore().load()])
    vi.mocked(orderApi.fetchOpenOrders).mockClear()
    vi.mocked(fetchAccountBalance).mockClear()
    vi.mocked(orderApi.createOrder).mockResolvedValue({ order_id: 'o9' })
    vi.mocked(orderApi.cancelOrder).mockResolvedValue(null)
    await orders.submitOrder({ side: 'SELL', type: '1', price: '120', volume: '0.5' })
    await orders.cancelOrder('o1')
    await settleRefresh()
    expect(orderApi.fetchOpenOrders).toHaveBeenCalledTimes(1)
    expect(fetchAccountBalance).toHaveBeenCalledTimes(1)
  })
})

describe('spot ticket: results never enter the layout', () => {
  it('a placed order is a toast; the ticket gets no notice and the amount error does not appear after success', async () => {
    const account = useAccountStore()
    await account.load()
    useMarketStore().ticker.close = '100'
    vi.mocked(orderApi.createOrder).mockResolvedValue({ order_id: 'o5' })
    const host = mount(OrderForm, { side: 'BUY', orderType: '1' })
    await flush()
    const inputs = host.querySelectorAll('input')
    inputs[0].value = '100'
    inputs[0].dispatchEvent(new Event('input'))
    inputs[1].value = '1'
    inputs[1].dispatchEvent(new Event('input'))
    await flush()
    const before = host.querySelector('.order-form')?.children.length
    ;(host.querySelector('.submit-button') as HTMLButtonElement).click()
    await flush()
    expect(orderApi.createOrder).toHaveBeenCalledTimes(1)
    expect(useToasts().value.map((toast) => toast.tone)).toEqual(['success'])
    expect(host.querySelector('.notice')).toBeNull()
    expect(host.querySelector('.field-error')).toBeNull()
    expect(host.querySelector('.order-form')?.children.length).toBe(before)
  })

  it('a refusal is an error toast, not an inline notice', async () => {
    await useAccountStore().load()
    vi.mocked(orderApi.createOrder).mockRejectedValueOnce(new Error('价格超出限制'))
    const host = mount(OrderForm, { side: 'BUY', orderType: '1' })
    await flush()
    const inputs = host.querySelectorAll('input')
    inputs[0].value = '100'
    inputs[0].dispatchEvent(new Event('input'))
    inputs[1].value = '1'
    inputs[1].dispatchEvent(new Event('input'))
    await flush()
    ;(host.querySelector('.submit-button') as HTMLButtonElement).click()
    await flush()
    expect(useToasts().value).toMatchObject([{ tone: 'error', message: '价格超出限制' }])
    expect(host.querySelector('.notice')).toBeNull()
  })
})

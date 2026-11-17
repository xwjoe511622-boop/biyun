// @vitest-environment jsdom
/**
 * Futures side of the 2026-09-29 state conventions: a resting limit order shows up in 当前委托 at once (pending),
 * a refusal rolls the row and 可用 back, a confirmed cancel removes the row, and each action is ONE refresh that
 * commits the assets snapshot and the order list together. The orders table never swaps to a loading block on refetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import { clearToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import type { CreateOrderPayload } from '@/modules/futures/api'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import FuturesOrdersTabs from '@/components/futures/FuturesOrdersTabs.vue'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await wait(0)
    await nextTick()
  }
}

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

let pinia: Pinia
let app: App | null = null
let calls: string[] = []
let serverOrders: Record<string, unknown>[] = []
let canUse = '1000'
let createCode = '0'
let createGate: Gate | null = null
let cancelGate: Gate | null = null
let listGate: Gate | null = null

const resting = (id: string, price = '60000'): Record<string, unknown> => ({ id, contractId: 1, contractName: 'E-BTC-USDT', side: 'BUY', open: 'OPEN', type: 1, price, volume: '10', dealVolume: '0', status: 0, ctime: 1790000000000 })
const payload: CreateOrderPayload = { contractId: 1, positionType: 1, side: 'BUY', open: 'OPEN', type: 1, volume: '10', price: '60000', leverageLevel: 10, isConditionOrder: false }

beforeEach(() => {
  localStorage.clear()
  session.clear()
  clearToasts()
  calls = []
  serverOrders = [resting('1001')]
  canUse = '1000'
  createCode = '0'
  createGate = null
  cancelGate = null
  listGate = null
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
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    calls.push(path)
    if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 10, marginModel: 1 } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: canUse, totalAmount: '1000' }] } })
    if (path === 'order/current_order_list') {
      if (listGate !== null) await listGate.promise
      return respond({ code: '0', data: { count: serverOrders.length, orderList: serverOrders } })
    }
    if (path === 'order/order_create') {
      if (createGate !== null) await createGate.promise
      return createCode === '0' ? respond({ code: '0', data: { ids: ['1002'] } }) : respond({ code: createCode, msg: '保证金不足' })
    }
    if (path === 'order/order_cancel') {
      if (cancelGate !== null) await cancelGate.promise
      return respond({ code: '0', data: {} })
    }
    return respond({ code: '0', data: {} })
  }))
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  vi.unstubAllGlobals()
  session.clear()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function ready(): Promise<ReturnType<typeof useFuturesOrdersStore>> {
  const orders = useFuturesOrdersStore()
  await useFuturesAccountStore().refresh()
  await orders.load('current')
  calls = []
  return orders
}

describe('futures orders: optimistic placement and cancel', () => {
  it('a resting limit order is in 当前委托 at once; 可用 drops; one refresh (assets + list) after acceptance', async () => {
    const orders = await ready()
    const account = useFuturesAccountStore()
    createGate = gate()
    const placing = orders.placeOrder(payload, { reserve: '60' })
    await flush()
    expect(orders.lists.current.rows[0]).toMatchObject({ price: '60000', pending: true })
    expect(orders.lists.current.count).toBe(2)
    expect(account.available).toBe('940')
    serverOrders = [resting('1002'), resting('1001')]
    canUse = '940'
    createGate.open()
    expect(await placing).toBeNull()
    expect(orders.lists.current.rows[0]).toMatchObject({ id: '1002', pending: false })
    await wait(200)
    await flush()
    expect(calls.filter((path) => path === 'position/get_assets_list')).toHaveLength(1)
    expect(calls.filter((path) => path === 'order/current_order_list')).toHaveLength(1)
    expect(orders.lists.current.rows.map((row) => row.id)).toEqual(['1002', '1001'])
    expect(account.available).toBe('940')
  })

  it('refreshes already opened history after acceptance when no user stream is connected', async () => {
    const orders = await ready()
    await orders.load('history')
    calls = []
    expect(await orders.placeOrder({ ...payload, type: 5 })).toBeNull()
    await wait(1_100)
    await flush()
    expect(calls.filter(path => path === 'order/history_order_list')).toHaveLength(1)
  })

  it('a refusal removes the pending row and restores 可用', async () => {
    const orders = await ready()
    createCode = '101000'
    const result = await orders.placeOrder(payload, { reserve: '60' })
    // Localised by (futures, 101000) since 2026-10-01, not the server's own wording.
    expect(result).toContain('余额不足')
    expect(orders.lists.current.rows.map((row) => row.id)).toEqual(['1001'])
    expect(orders.lists.current.count).toBe(1)
    expect(useFuturesAccountStore().available).toBe('1000')
  })

  it('a confirmed cancel removes the row before the refresh arrives', async () => {
    const orders = await ready()
    cancelGate = gate()
    const canceling = orders.cancel({ id: '1001', contractId: 1 }, false)
    await flush()
    expect(orders.cancelingId).toBe('1001')
    expect(orders.lists.current.rows).toHaveLength(1)
    serverOrders = []
    cancelGate.open()
    expect(await canceling).toBeNull()
    expect(orders.lists.current.rows).toHaveLength(0)
    await wait(200)
    await flush()
    expect(calls.filter((path) => path === 'order/current_order_list')).toHaveLength(1)
    expect(calls.filter((path) => path === 'position/get_assets_list')).toHaveLength(1)
  })
})

describe('futures orders table: stale-while-revalidate', () => {
  it('keeps the rows (no StateBlock) while 当前委托 is refetched', async () => {
    const orders = await ready()
    app = createApp(defineComponent({ setup: () => () => h(FuturesOrdersTabs) }))
    app.use(pinia)
    app.use(i18n)
    app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    await flush()
    const tab = [...host.querySelectorAll<HTMLButtonElement>('.tab')].find((button) => button.textContent?.includes('当前委托'))
    tab?.click()
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    listGate = gate()
    const refetch = orders.load('current')
    await flush()
    expect(host.querySelector('.state')).toBeNull()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    listGate.open()
    await refetch
    await flush()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
  })
})

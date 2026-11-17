// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import PositionCloseDialog from '@/components/futures/PositionCloseDialog.vue'
import TpslDialog from '@/components/futures/TpslDialog.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { clearToasts, useToasts } from '@/core/toast'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { loadFuturesFilters, resetFuturesFiltersCache } from '@/modules/api/exchange-filters'
import { buildContract } from '@/modules/futures/contracts'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { normalizePublicInfo, type FuturesPosition } from '@/modules/futures/types'
import { useFuturesMarketStore } from '@/stores/futures-market'

/**
 * 09-30 owner bug (L640): on the ETH page, 最优价-closing the BTC position read the ETH book / precision and was refused
 * (「最多一位小数」, 「卖出平仓价不能低于 79491.8（标记价格 83675.5 的下限）」). Every per-position action must use the
 * position's own contract: book (depth snapshot on demand), mark, last, tick size and price band.
 */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null
let orderCreates: Record<string, string>[] = []
let depthRequests: string[] = []

const BTC_BOOK = { symbol: 'e_btcusdt', lastUpdateId: 1, E: 1, bids: [['83699.1', '10'], ['83680.6', '10']], asks: [['83711.3', '10'], ['83730.3', '10']] }

beforeEach(() => {
  localStorage.clear()
  session.clear()
  orderCreates = []
  depthRequests = []
  clearToasts()
  resetFuturesFiltersCache()
  pinia = createPinia()
  setActivePinia(pinia)
  const market = useFuturesMarketStore()
  const coin = (precision: number) => ({ symbolPricePrecision: precision, marginCoinPrecision: 6, minOrderVolume: 1, minOrderMoney: 1, maxLimitVolume: 99999999, maxMarketVolume: 99999999, maxMarketMoney: 99999999, fundsInStatus: 1, fundsOutStatus: 1, depth: ['1', '0'] })
  const info = normalizePublicInfo({
    contractList: [
      { id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 125, coinResultVo: coin(1) },
      { id: 2, contractName: 'E-ETH-USDT', multiplier: '0.001', multiplierCoin: 'ETH', marginCoin: 'USDT', marginRate: '1', base: 'ETH', quote: 'USDT', minLever: 1, maxLever: 100, coinResultVo: coin(2) },
    ],
  })
  market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
  // The page shows ETH.
  market.selectedName = 'E-ETH-USDT'
  market.ticker = { close: '2678.70', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
  market.handleMessage({ channel: 'market_e_ethusdt_depth_step0', tick: { asks: [[2679.22, 50]], buys: [[2678.7, 50]] } } as never)
  session.setToken('jwt')
  useSizeUnit().value = 'quote'
  // Per-contract ticker subscriptions stay synthetic in this dialog suite.
  // A real undici socket also crosses the jsdom Event realm on Node 24.
  vi.stubGlobal('WebSocket', class {
    static readonly OPEN = 1
    readyState = 0
    binaryType = 'blob'
    onopen: unknown = null
    onclose: unknown = null
    onmessage: unknown = null
    onerror: unknown = null
    send(): void {}
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/fmd/v1/depth')) {
      depthRequests.push(url)
      return respond(url.includes('symbol=e_btcusdt') ? BTC_BOOK : { symbol: 'e_ethusdt', bids: [], asks: [] })
    }
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
    if (path === 'common/exchange_filters') return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', multiplierUp: '1.05', multiplierDown: '0.95' }, '2': { multiplier: '0.001', multiplierUp: '1.05', multiplierDown: '0.95' } } } } })
    if (path === 'common/public_market_info') return respond({ code: '0', data: body.contractId === '1' ? { tagPrice: 83675.5, indexPrice: 83680 } : { tagPrice: 2678.7, indexPrice: 2678.9 } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
    if (path === 'order/order_create') {
      orderCreates.push(body)
      return respond({ code: '0', data: { ids: ['1'] } })
    }
    return respond({ code: '0', data: {} })
  }))
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
  app?.unmount()
  app = null
  disposePinia(pinia)
  vi.unstubAllGlobals()
  session.clear()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const BTC_LONG = {
  id: 7, contractId: 1, contractName: 'E-BTC-USDT', orderSide: 'BUY', positionType: 1, leverageLevel: 20,
  positionVolume: '20', canCloseVolume: '20', markPrice: '83600', openAvgPrice: '83500', reducePrice: '-1',
} as unknown as FuturesPosition

function mount(component: unknown, props: Record<string, unknown>): void {
  app = createApp(defineComponent({ setup: () => () => h(component as never, { ...props, onClose: () => {} }) }))
  app.use(pinia)
  app.use(i18n)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
}

const q = <T extends Element>(id: string): T => document.body.querySelector(`[data-testid="${id}"]`) as T

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

async function openClose(): Promise<void> {
  const btc = useFuturesMarketStore().contracts[0]
  mount(PositionCloseDialog, { position: BTC_LONG, contract: btc })
  await loadFuturesFilters()
  await flush()
}

async function chooseType(value: 'market' | 'limit' | 'bbo'): Promise<void> {
  q<HTMLButtonElement>('fut-pcd-type').click()
  await flush()
  q<HTMLButtonElement>(`fut-pcd-type-${value}`).click()
  await flush()
}

describe('per-position actions use the position contract, not the page contract', () => {
  it('最优价 close of a BTC long on the ETH page sells at the BTC best bid (BTC tick, BTC band)', async () => {
    await openClose()
    expect(depthRequests.some((url) => url.includes('symbol=e_btcusdt'))).toBe(true)
    await chooseType('bbo')
    q<HTMLButtonElement>('fut-pcd-confirm').click()
    await flush()
    expect(useToasts().value.map((toast) => toast.message).join(' ')).not.toMatch(/小数|下限/)
    expect(orderCreates.at(-1)).toMatchObject({ contractId: '1', side: 'SELL', open: 'CLOSE', type: '1', price: '83699.1' })
  })

  it('a limit close is checked against the BTC mark band and BTC tick size', async () => {
    await openClose()
    await chooseType('limit')
    await type(q<HTMLInputElement>('fut-pcd-price'), '2678.7')
    q<HTMLButtonElement>('fut-pcd-confirm').click()
    await flush()
    // 0.95 x 83675.5 (BTC mark) = 79491.725 -> 79491.8 at the BTC tick
    expect(useToasts().value.some((toast) => toast.message.includes('79491.8'))).toBe(true)
    expect(orderCreates).toHaveLength(0)
    await type(q<HTMLInputElement>('fut-pcd-price'), '83700.15')
    q<HTMLButtonElement>('fut-pcd-confirm').click()
    await flush()
    expect(orderCreates).toHaveLength(0)
    await type(q<HTMLInputElement>('fut-pcd-price'), '83700.1')
    q<HTMLButtonElement>('fut-pcd-confirm').click()
    await flush()
    expect(orderCreates.at(-1)).toMatchObject({ contractId: '1', price: '83700.1' })
  })

  it('the TP/SL dialog validates against the BTC price, not the ETH ticker', async () => {
    mount(TpslDialog, { position: BTC_LONG, pricePrecision: 1, quote: 'USDT' })
    await flush()
    // No BTC ticker frame yet: the BTC book mid (83705.2) stands in for the last price.
    expect(document.body.querySelector('.tpq-trigger')?.textContent).toContain('83,705.2')
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '3000')
    q<HTMLInputElement>('fut-tpsl-tp').dispatchEvent(new Event('blur'))
    await flush()
    expect(q<HTMLButtonElement>('fut-tpsl-submit').disabled).toBe(true)
  })
})

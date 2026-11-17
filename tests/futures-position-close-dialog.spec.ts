// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import PositionCloseDialog from '@/components/futures/PositionCloseDialog.vue'
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
 * Binance app 平仓 sheet (PositionCloseDialog, 2026-09-29). A single full-width sheet whose confirm
 * button is the confirmation: a whole-position market close uses `order/light_close`, a partial market
 * close and every limit / 最优价 close uses `order/order_create` (limit GTC type 1, market type 2 with
 * an empty price). The dialog is teleported to <body> via FuturesDialog.
 */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null
let orderCreates: Record<string, string>[] = []
let lightCloses: Record<string, unknown>[] = []
/** order_create answer code ('0' accepts). */
let createCode = '0'

beforeEach(() => {
  localStorage.clear()
  session.clear()
  orderCreates = []
  lightCloses = []
  createCode = '0'
  clearToasts()
  resetFuturesFiltersCache()
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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    if (path === 'common/exchange_filters') return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', multiplierUp: '1.05', multiplierDown: '0.95' } } } } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
    if (path === 'order/order_create') {
      orderCreates.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>)
      if (createCode !== '0') return respond({ code: createCode, msg: '预计成交价格低于强平价格，无法下单' })
      return respond({ code: '0', data: { ids: ['1'] } })
    }
    if (path === 'order/light_close') {
      lightCloses.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return respond({ code: '0', data: {} })
    }
    return respond({ code: '0', data: {} })
  }))
})

afterEach(async () => {
  // closeAtMarket awaits the coalesced refresh (~120 ms); let it finish so its toast cannot land in the next test.
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
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function feedBook(asks: [number, number][], buys: [number, number][]): void {
  useFuturesMarketStore().handleMessage({ channel: 'market_e_btcusdt_depth_step0', tick: { asks, buys } } as never)
}

const basePosition = {
  id: 7,
  contractId: 1,
  contractName: 'E-BTC-USDT',
  orderSide: 'BUY',
  positionType: 1,
  leverageLevel: 10,
  positionVolume: '40',
  canCloseVolume: '40',
  markPrice: '50000',
  openAvgPrice: '49000',
} as unknown as FuturesPosition

function makePosition(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return { ...basePosition, ...overrides } as FuturesPosition
}

async function mountDialog(position: FuturesPosition): Promise<void> {
  const market = useFuturesMarketStore()
  const contract = market.contracts[0]
  app = createApp(defineComponent({ setup: () => () => h(PositionCloseDialog, { position, contract, onClose: () => {} }) }))
  app.use(pinia)
  app.use(i18n)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await loadFuturesFilters()
  await flush()
}

const q = <T extends Element>(id: string): T => document.body.querySelector(`[data-testid="${id}"]`) as T

const confirmButton = (): HTMLButtonElement => q<HTMLButtonElement>('fut-pcd-confirm')

const sliderEl = (): HTMLElement => document.body.querySelector('[role="slider"]') as HTMLElement

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

async function chooseType(value: 'market' | 'limit' | 'bbo'): Promise<void> {
  q<HTMLButtonElement>('fut-pcd-type').click()
  await flush()
  q<HTMLButtonElement>(`fut-pcd-type-${value}`).click()
  await flush()
}

/** Home -> 0, then PageUp (+10) and ArrowRight (+1) to the target percentage. */
async function setPercent(slider: HTMLElement, pct: number): Promise<void> {
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
  await flush()
  let remaining = pct
  while (remaining >= 10) {
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
    await flush()
    remaining -= 10
  }
  while (remaining > 0) {
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await flush()
    remaining -= 1
  }
}

describe('position close dialog: market close', () => {
  it('closes the whole position at the default 100% with a real MARKET order, never light_close (10058 owner bug)', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    expect(q<HTMLInputElement>('fut-pcd-qty').value).toContain('100% (≈')
    confirmButton().click()
    await flush()
    // light_close is a LIMIT at the 10th level, refused 10058 past the liquidation price; MARKET orders skip that check.
    expect(lightCloses).toHaveLength(0)
    expect(orderCreates).toEqual([expect.objectContaining({ contractId: '1', side: 'SELL', open: 'CLOSE', type: '2', volume: '40', price: '', positionType: '1' })])
  })

  it('sends a CLOSE market order for 25% of the closable volume', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    const slider = sliderEl()
    await setPercent(slider, 25)
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(1)
    expect(orderCreates[0]).toMatchObject({ open: 'CLOSE', type: '2', volume: '10', price: '' })
    expect(lightCloses).toHaveLength(0)
  })

  it('a partial short with resting close orders sends a market order, not light_close', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition({ orderSide: 'SELL', positionType: 2, canCloseVolume: '25', positionVolume: '40' }))
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(1)
    expect(orderCreates[0]).toMatchObject({ side: 'BUY', open: 'CLOSE', type: '2', volume: '25', price: '', positionType: '2' })
    expect(lightCloses).toHaveLength(0)
  })
})

describe('position close dialog: limit close', () => {
  it('sends a SELL CLOSE limit order at 50%', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    await chooseType('limit')
    await type(q<HTMLInputElement>('fut-pcd-price'), '50100')
    await setPercent(sliderEl(), 50)
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(1)
    expect(orderCreates[0]).toMatchObject({ side: 'SELL', open: 'CLOSE', type: '1', price: '50100', volume: '20', positionType: '1', leverageLevel: '10' })
    expect(lightCloses).toHaveLength(0)
  })
})

describe('position close dialog: refused past the liquidation price', () => {
  it.each(['10058', '10059'])('a limit close refused with %s says to close at market', async (code) => {
    createCode = code
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    await chooseType('limit')
    await type(q<HTMLInputElement>('fut-pcd-price'), '50100')
    confirmButton().click()
    await flush()
    expect(useToasts().value.some((toast) => toast.tone === 'error' && toast.message === '价格已越过强平价，请使用市价平仓')).toBe(true)
  })
})

describe('position close dialog: 市价 close near the liquidation price (10058 owner bug, then 10-03)', () => {
  // 10-03: the server accepts a MARKET close past the guard edge (IOC closes skip the liquidation-price check; the core caps
  // the close at the bankruptcy price), so 市价 is always a MARKET order and is listed as 市价, not IOC
  it('closes a high-leverage long with a MARKET order', async () => {
    useSizeUnit().value = 'cont'
    // mark 50000, guard bound 5% → edge 47500; liquidation 49100 is inside it.
    await mountDialog(makePosition({ reducePrice: '49100.004', leverageLevel: 50, positionType: 2 }))
    await loadFuturesFilters()
    await flush()
    confirmButton().click()
    await flush()
    expect(lightCloses).toHaveLength(0)
    expect(orderCreates.at(-1)).toMatchObject({ side: 'SELL', open: 'CLOSE', type: '2', price: '', volume: '40' })
  })
})

describe('position close dialog: MARKET close refused past the liquidation price', () => {
  it('a whole-position market close refused with 10058 explains the protection price, not "use market"', async () => {
    createCode = '10058'
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    confirmButton().click()
    await flush()
    expect(orderCreates.at(-1)).toMatchObject({ type: '2', open: 'CLOSE' })
    const messages = useToasts().value.filter((toast) => toast.tone === 'error').map((toast) => toast.message)
    expect(messages.some((text) => text.startsWith('市价平仓被拒：成交保护价'))).toBe(true)
    expect(messages).not.toContain('价格已越过强平价，请使用市价平仓')
  })

  it('a partial market close refused with 10059 gets the same explanation', async () => {
    createCode = '10059'
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    await setPercent(sliderEl(), 50)
    confirmButton().click()
    await flush()
    expect(orderCreates.at(-1)).toMatchObject({ type: '2', open: 'CLOSE', volume: '20' })
    expect(useToasts().value.some((toast) => toast.tone === 'error' && toast.message.startsWith('市价平仓被拒：成交保护价'))).toBe(true)
  })
})

describe('position close dialog: 最优价 (BBO) close', () => {
  it('resolves 对手价1 on the ask side for a short and sends a BUY limit order', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition({ orderSide: 'SELL', positionType: 2 }))
    await chooseType('bbo')
    feedBook([[50010, 5]], [[49990, 5]])
    await flush()
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(1)
    expect(orderCreates[0]).toMatchObject({ side: 'BUY', open: 'CLOSE', type: '1', price: '50010', positionType: '2' })
    expect(lightCloses).toHaveLength(0)
  })
})

describe('position close dialog: quantity & unit', () => {
  it('a typed base-coin quantity drives the slider and the market order volume', async () => {
    useSizeUnit().value = 'base'
    await mountDialog(makePosition())
    await type(q<HTMLInputElement>('fut-pcd-qty'), '0.0015')
    expect(sliderEl().getAttribute('aria-valuenow')).toBe('37')
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(1)
    expect(orderCreates[0]).toMatchObject({ open: 'CLOSE', type: '2', volume: '15', price: '' })
  })

  it('toggles the size unit label USDT <-> BTC', async () => {
    useSizeUnit().value = 'quote'
    await mountDialog(makePosition())
    expect(q<HTMLButtonElement>('fut-pcd-unit').textContent).toBe('USDT')
    q<HTMLButtonElement>('fut-pcd-unit').click()
    await flush()
    expect(q<HTMLButtonElement>('fut-pcd-unit').textContent).toBe('BTC')
  })
})

describe('position close dialog: estimates & validation', () => {
  it('shows the estimated PnL of a limit close', async () => {
    useSizeUnit().value = 'base'
    await mountDialog(makePosition())
    await chooseType('limit')
    await type(q<HTMLInputElement>('fut-pcd-price'), '50100')
    expect(document.body.textContent).toContain('+4.40')
  })

  it('rejects a limit price below the sell-side band and shows the minimum', async () => {
    useSizeUnit().value = 'cont'
    await mountDialog(makePosition())
    await chooseType('limit')
    await type(q<HTMLInputElement>('fut-pcd-price'), '47000')
    confirmButton().click()
    await flush()
    expect(orderCreates).toHaveLength(0)
    expect(lightCloses).toHaveLength(0)
    expect(useToasts().value.some((t) => t.message.includes('47500'))).toBe(true)
  })
})

describe('positions table 平仓 column: 限价 opens the sheet on 限价委托 (2026-09-30)', () => {
  it('initialKind limit shows the price input', async () => {
    const market = useFuturesMarketStore()
    const contract = market.contracts[0]
    app = createApp(defineComponent({ setup: () => () => h(PositionCloseDialog, { position: makePosition(), contract, initialKind: 'limit', onClose: () => {} }) }))
    app.use(pinia)
    app.use(i18n)
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    await loadFuturesFilters()
    await flush()
    expect(q('fut-pcd-price')).not.toBeNull()
  })
})

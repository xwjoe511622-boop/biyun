// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import FuturesOrderPanel from '@/components/futures/FuturesOrderPanel.vue'
import FuturesPreferencesDialog from '@/components/futures/FuturesPreferencesDialog.vue'
import { i18n } from '@/i18n'
import { clearToasts, useToasts } from '@/core/toast'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { resetFuturesFiltersCache } from '@/modules/api/exchange-filters'
import { buildContract } from '@/modules/futures/contracts'
import { useQuoteMode } from '@/modules/futures/order-entry'
import { readPositionMode, savePositionMode } from '@/modules/futures/position-mode'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { normalizePublicInfo } from '@/modules/futures/types'
import type { PriceSuggestion } from '@/modules/trade/book-fill'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

/**
 * One-way position mode (单向持仓, 2026-09-30) on the hedge-only server, the 偏好设置 dialog, and order-book click-to-fill
 * on the futures ticket.
 */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

const UID = 424242
let pinia: Pinia
let app: App | null = null
let orders: Record<string, string>[] = []
let positions: Record<string, unknown>[] = []
let canSwitch = 1
let failSecondLeg = false

function position(id: number, side: 'BUY' | 'SELL', volume: number, canClose = volume): Record<string, unknown> {
  return { id, contractId: 1, contractName: 'E-BTC-USDT', orderSide: side, positionType: 1, positionVolume: volume, canCloseVolume: canClose, leverageLevel: 20, openAvgPrice: '83000' }
}

beforeEach(() => {
  localStorage.clear()
  session.clear()
  clearToasts()
  orders = []
  positions = []
  canSwitch = 1
  failSecondLeg = false
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
  session.setUser({ id: UID })
  useSizeUnit().value = 'cont'
  useQuoteMode().value = 'notional'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 10, marginModel: 1, positionModelCanSwitch: canSwitch } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: positions, accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
    if (path === 'common/getMakerAndTaker') return respond({ code: '0', data: [] })
    if (path === 'order/order_create') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
      orders.push(body)
      if (failSecondLeg && orders.length === 2) return respond({ code: '10015', msg: 'Exceeded the close available' })
      return respond({ code: '0', data: { ids: [String(orders.length)] } })
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

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const suggestion = ref<PriceSuggestion>()

async function mountPanel(): Promise<HTMLElement> {
  suggestion.value = undefined
  app = createApp(defineComponent({ setup: () => () => h(FuturesOrderPanel, { priceSuggestion: suggestion.value }) }))
  app.use(pinia)
  app.use(i18n)
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await useFuturesAccountStore().refresh()
  await flush()
  return host
}

const q = <T extends Element>(host: ParentNode, id: string): T => host.querySelector(`[data-testid="${id}"]`) as T

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

async function limit(host: HTMLElement, price: string, volume: string): Promise<void> {
  await type(host.querySelector('input[aria-label="委托价格"]') as HTMLInputElement, price)
  await type(q(host, 'fut-volume'), volume)
}

describe('position mode default and storage', () => {
  it('existing users stay in Hedge (双向持仓) until they choose One-way', async () => {
    expect(readPositionMode(UID)).toBe('hedge')
    const host = await mountPanel()
    expect(host.querySelector('.oc-tabs')).not.toBeNull()
    expect(q(host, 'fut-submit-BUY').textContent).toContain('开多')
    expect(q(host, 'fut-reduce-only')).toBeNull()
  })
})

describe('One-way ticket (单向持仓)', () => {
  beforeEach(() => savePositionMode(UID, 'oneWay'))

  it('shows 买入/做多 · 卖出/做空 + 只减仓 and no 开仓/平仓 tabs', async () => {
    const host = await mountPanel()
    expect(host.querySelector('.oc-tabs')).toBeNull()
    expect(q(host, 'fut-mode-row').textContent).toContain('单向持仓')
    expect(q(host, 'fut-net-position').textContent).toContain('无持仓')
    expect(q(host, 'fut-submit-BUY').textContent).toContain('买入/做多')
    expect(q(host, 'fut-submit-SELL').textContent).toContain('卖出/做空')
    expect(q(host, 'fut-reduce-only')).not.toBeNull()
    expect(host.textContent).toContain('最大')
  })

  it('flat: a buy opens a long (one OPEN order)', async () => {
    const host = await mountPanel()
    await limit(host, '83000', '10')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ side: 'BUY', open: 'OPEN', volume: '10', price: '83000', type: '1' })
  })

  it('short 40: buying 50 closes the short first, then opens 10 long (two sequential orders)', async () => {
    positions = [position(7, 'SELL', 40)]
    const host = await mountPanel()
    expect(q(host, 'fut-net-position').textContent).toContain('空 40')
    await limit(host, '83000', '50')
    expect(q(host, 'fut-size-hint').textContent).toContain('买入/做多：将先平空 40 张，再开多 10 张')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.map((o) => [o.side, o.open, o.volume, o.leverageLevel])).toEqual([['BUY', 'CLOSE', '40', '20'], ['BUY', 'OPEN', '10', '10']])
  })

  it('short 40: buying 30 only closes (CLOSE 30)', async () => {
    positions = [position(7, 'SELL', 40)]
    const host = await mountPanel()
    await limit(host, '83000', '30')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders.map((o) => [o.side, o.open, o.volume])).toEqual([['BUY', 'CLOSE', '30']])
  })

  it('a refused second leg says the close was placed', async () => {
    positions = [position(7, 'SELL', 40)]
    failSecondLeg = true
    const host = await mountPanel()
    await limit(host, '83000', '50')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders).toHaveLength(2)
    expect(useToasts().value.some((toast) => toast.message.includes('已提交平空 40 张，但反向开仓失败'))).toBe(true)
  })

  it('只减仓 closes at most the position and refuses the side that would grow it', async () => {
    positions = [position(7, 'BUY', 20)]
    const host = await mountPanel()
    q<HTMLInputElement>(host, 'fut-reduce-only').click()
    await flush()
    await limit(host, '83000', '35')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders).toHaveLength(0)
    expect(useToasts().value.some((toast) => toast.message.includes('只减仓：该方向会增加仓位'))).toBe(true)
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    await flush()
    expect(orders.map((o) => [o.side, o.open, o.volume])).toEqual([['SELL', 'CLOSE', '20']])
  })

  it('resting close orders block a reversal with a clear message', async () => {
    positions = [position(7, 'SELL', 40, 25)]
    const host = await mountPanel()
    await limit(host, '83000', '30')
    q<HTMLButtonElement>(host, 'fut-submit-BUY').click()
    await flush()
    expect(orders).toHaveLength(0)
    expect(useToasts().value.some((toast) => toast.message.includes('已有平仓委托占用 15 张'))).toBe(true)
  })

  it('legacy long + short on one contract falls back to the Hedge ticket with a notice', async () => {
    positions = [position(7, 'BUY', 5), position(8, 'SELL', 3)]
    const host = await mountPanel()
    expect(q(host, 'fut-mode-conflict').textContent).toContain('同时持有多仓和空仓')
    expect(q(host, 'fut-mode-conflict').getAttribute('title')).toContain('请先平掉其中一侧')
    expect(host.querySelector('.oc-tabs')).not.toBeNull()
    expect(q(host, 'fut-submit-BUY').textContent).toContain('开多')
  })

  it('book click: fills the price and the cumulative contracts, capped at 最大 for the taking side', async () => {
    positions = [position(7, 'SELL', 40)]
    const host = await mountPanel()
    suggestion.value = { price: '83000', sequence: 1, side: 'BUY', amount: '55.7' }
    await flush()
    expect((host.querySelector('input[aria-label="委托价格"]') as HTMLInputElement).value).toBe('83000')
    expect(q<HTMLInputElement>(host, 'fut-volume').value).toBe('55')
    q<HTMLInputElement>(host, 'fut-reduce-only').click()
    await flush()
    suggestion.value = { price: '83000', sequence: 2, side: 'BUY', amount: '55' }
    await flush()
    expect(q<HTMLInputElement>(host, 'fut-volume').value).toBe('40')
  })
})

describe('futures book click in Hedge mode and in coin units', () => {
  it('fills 开仓 size in BTC from contracts, capped at 可开', async () => {
    useSizeUnit().value = 'base'
    const host = await mountPanel()
    suggestion.value = { price: '80000', sequence: 1, side: 'SELL', amount: '120' }
    await flush()
    expect(q<HTMLInputElement>(host, 'fut-volume').value).toBe('0.012')
    // 可开 at 10x with 1000 USDT ≈ 1249 contracts at 80000: a huge cumulative is capped.
    suggestion.value = { price: '80000', sequence: 2, side: 'SELL', amount: '99999' }
    await flush()
    const max = Number(q<HTMLInputElement>(host, 'fut-volume').value)
    expect(max).toBeGreaterThan(0.1)
    expect(max).toBeLessThanOrEqual(0.125)
    q<HTMLButtonElement>(host, 'fut-submit-SELL').click()
    await flush()
    expect(orders.at(-1)).toMatchObject({ side: 'SELL', open: 'OPEN', volume: String(Math.round(max / 0.0001)) })
  })
})

describe('偏好设置 → 持仓模式', () => {
  async function mountDialog(): Promise<void> {
    app = createApp(defineComponent({ setup: () => () => h(FuturesPreferencesDialog) }))
    app.use(pinia)
    app.use(i18n)
    const host = document.createElement('div')
    document.body.appendChild(host)
    await useFuturesAccountStore().refresh()
    app.mount(host)
    await flush()
  }

  it('switches to One-way when there are no positions or orders', async () => {
    await mountDialog()
    q<HTMLButtonElement>(document.body, 'fut-pm-oneWay').click()
    await flush()
    q<HTMLButtonElement>(document.body, 'fut-pm-save').click()
    await flush()
    expect(readPositionMode(UID)).toBe('oneWay')
  })

  it('is blocked while positions or orders exist (server positionModelCanSwitch 0)', async () => {
    canSwitch = 0
    await mountDialog()
    q<HTMLButtonElement>(document.body, 'fut-pm-oneWay').click()
    await flush()
    expect(q(document.body, 'fut-pm-blocked').textContent).toContain('有持仓或委托')
    expect(q<HTMLButtonElement>(document.body, 'fut-pm-save').disabled).toBe(true)
    expect(readPositionMode(UID)).toBe('hedge')
  })

  it('is blocked by a loaded position even if the server flag says it may switch', async () => {
    positions = [position(7, 'BUY', 5)]
    await mountDialog()
    q<HTMLButtonElement>(document.body, 'fut-pm-oneWay').click()
    await flush()
    expect(q(document.body, 'fut-pm-blocked')).not.toBeNull()
    expect(readPositionMode(UID)).toBe('hedge')
  })
})

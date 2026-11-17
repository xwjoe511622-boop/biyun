// @vitest-environment jsdom
/**
 * 2026-09-30 owner bug: with a BTC long AND an ETH long, closing the ETH long "did nothing". Every positions-table row
 * action (市价 / 限价 / 反手) must act on ITS row's position and contract from either page, and a refused or skipped
 * action must say so (toast), never silently do nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import { clearToasts, useToasts } from '@/core/toast'
import { i18n } from '@/i18n'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { resetFuturesFiltersCache } from '@/modules/api/exchange-filters'
import { buildContract } from '@/modules/futures/contracts'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { normalizePublicInfo } from '@/modules/futures/types'
import FuturesOrdersTabs from '@/components/futures/FuturesOrdersTabs.vue'

// Short 反手 settle window (the real one polls 持仓 for up to 5 s after step 2).
vi.mock('@/modules/futures/reverse', () => ({ REVERSE_SETTLE_MS: 600, REVERSE_POLL_MS: 50 }))
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await wait(0)
    await nextTick()
  }
}

const BTC_LONG = { id: 7, contractId: 1, contractName: 'E-BTC-USDT', orderSide: 'BUY', positionType: 1, leverageLevel: 20, positionVolume: '20', canCloseVolume: '20', markPrice: '83600', indexPrice: '83600', openAvgPrice: '83500', reducePrice: '-1' }
const ETH_LONG = { id: 8, contractId: 2, contractName: 'E-ETH-USDT', orderSide: 'BUY', positionType: 1, leverageLevel: 20, positionVolume: '21', canCloseVolume: '21', markPrice: '2736', indexPrice: '2736', openAvgPrice: '2735', reducePrice: '-1' }

let pinia: Pinia
let app: App | null = null
let sent: { path: string; body: Record<string, unknown> }[] = []
/** Server positions: a CLOSE order fills at once and removes its position (as the matching engine would). */
let held: Record<string, unknown>[] = []
/** false = the close is accepted but fills nothing (empty book, 10-01 owner bug). */
let fills = true

function setup(page: 'E-BTC-USDT' | 'E-ETH-USDT'): void {
  const market = useFuturesMarketStore()
  const coin = (precision: number) => ({ symbolPricePrecision: precision, marginCoinPrecision: 6, minOrderVolume: 1, minOrderMoney: 1, maxLimitVolume: 99999999, maxMarketVolume: 99999999, maxMarketMoney: 99999999, fundsInStatus: 1, fundsOutStatus: 1, depth: ['1', '0'] })
  const info = normalizePublicInfo({
    contractList: [
      { id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 125, coinResultVo: coin(1) },
      { id: 2, contractName: 'E-ETH-USDT', multiplier: '0.001', multiplierCoin: 'ETH', marginCoin: 'USDT', marginRate: '1', base: 'ETH', quote: 'USDT', minLever: 1, maxLever: 100, coinResultVo: coin(2) },
    ],
  })
  market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
  market.selectedName = page
  // The page contract's live book / last come from the page socket (other contracts: depth snapshot on demand).
  const btc = page === 'E-BTC-USDT'
  market.ticker = { close: btc ? '83600.0' : '2736.00', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
  market.handleMessage({ channel: `market_${page.toLowerCase().replace(/-/g, '_').replace('_usdt', 'usdt')}_depth_step0`, tick: { asks: [[btc ? 83600.3 : 2736.1, 100]], buys: [[btc ? 83599.1 : 2735.5, 100]] } } as never)
}

beforeEach(() => {
  localStorage.clear()
  session.clear()
  clearToasts()
  resetFuturesFiltersCache()
  sent = []
  held = [BTC_LONG, ETH_LONG]
  fills = true
  pinia = createPinia()
  setActivePinia(pinia)
  session.setToken('jwt')
  useSizeUnit().value = 'quote'
  // No real socket from the test (per-contract ticker subscriptions): an inert stand-in that never connects.
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
      const btc = url.includes('symbol=e_btcusdt')
      return respond({ symbol: btc ? 'e_btcusdt' : 'e_ethusdt', lastUpdateId: 1, E: 1, bids: [[btc ? '83599.1' : '2735.5', '100']], asks: [[btc ? '83600.3' : '2736.1', '100']] })
    }
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (/order_create|light_close/.test(path)) sent.push({ path, body })
    if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1, positionModel: 2 } })
    if (path === 'common/exchange_filters') return respond({ code: '0', data: { filters: { enabled: true, contracts: { '1': { multiplier: '0.0001', multiplierUp: '1.05', multiplierDown: '0.95' }, '2': { multiplier: '0.001', multiplierUp: '1.05', multiplierDown: '0.95' } } } } })
    if (path === 'common/public_market_info') return respond({ code: '0', data: String(body.contractId) === '1' ? { tagPrice: 83600, indexPrice: 83600, currentFundRate: 0.01 } : { tagPrice: 2736, indexPrice: 2736, currentFundRate: -0.01 } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: held, accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
    if (path === 'order/order_create') {
      if (body.open === 'CLOSE' && body.type !== '1' && fills) held = held.filter((row) => String(row.contractId) !== String(body.contractId))
      return respond({ code: '0', data: { ids: ['9001'] } })
    }
    return respond({ code: '0', data: {} })
  }))
})

afterEach(async () => {
  await wait(200)
  app?.unmount()
  app = null
  disposePinia(pinia)
  vi.unstubAllGlobals()
  session.clear()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function mountTable(page: 'E-BTC-USDT' | 'E-ETH-USDT'): Promise<HTMLElement> {
  setup(page)
  await useFuturesAccountStore().refresh()
  app = createApp(defineComponent({ setup: () => () => h(FuturesOrdersTabs) }))
  app.use(pinia)
  app.use(i18n)
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
  return host
}

const q = <T extends Element>(selector: string): T => document.body.querySelector(selector) as T
const row = (id: number): HTMLElement => q(`[data-testid="fut-pos-row-${id}"]`)

describe.each(['E-BTC-USDT', 'E-ETH-USDT'] as const)('positions row actions with BTC + ETH longs, page %s', (page) => {
  it.each([[7, 1, '20'], [8, 2, '21']])('市价 on position %i closes that position (contract %i) with a MARKET order', async (id, contractId, volume) => {
    const host = await mountTable(page)
    expect(host.querySelector('th.w-mkt')?.textContent?.trim()).toBe('平仓')
    expect([...row(id).querySelectorAll('td.w-mkt button')].map((b) => b.textContent?.trim())).toEqual(['市价', '限价', '反手'])
    row(id).querySelector<HTMLButtonElement>('[data-testid="fut-pos-close"]')!.click()
    await flush()
    expect(q('.pcd')?.textContent).toContain(contractId === 1 ? 'BTC' : 'ETH')
    q<HTMLButtonElement>('[data-testid="fut-pcd-confirm"]').click()
    await flush()
    await wait(300)
    await flush()
    // A real MARKET close of the whole position (never light_close: a LIMIT refused 10058 past the liquidation price).
    expect(sent).toEqual([{ path: 'order/order_create', body: expect.objectContaining({ contractId: String(contractId), side: 'SELL', open: 'CLOSE', type: '2', volume, price: '' }) }])
    expect(useToasts().value.some((toast) => toast.tone === 'success')).toBe(true)
  })

  it.each([[7, 1, '83599.1'], [8, 2, '2735.5']])('限价 on position %i sends a limit close on contract %i', async (id, contractId, price) => {
    await mountTable(page)
    row(id).querySelector<HTMLButtonElement>(`[data-testid="fut-pos-limit-${id}"]`)!.click()
    await flush()
    const input = q<HTMLInputElement>('[data-testid="fut-pcd-price"]')
    input.value = price
    input.dispatchEvent(new Event('input'))
    await flush()
    q<HTMLButtonElement>('[data-testid="fut-pcd-confirm"]').click()
    await flush()
    expect(sent.at(-1)).toMatchObject({ path: 'order/order_create', body: { contractId: String(contractId), side: 'SELL', open: 'CLOSE', type: '1', price } })
  })

  it.each([[7, 1], [8, 2]])('反手 on position %i closes then opens the short on contract %i', async (id, contractId) => {
    await mountTable(page)
    row(id).querySelector<HTMLButtonElement>(`[data-testid="fut-pos-reverse-${id}"]`)!.click()
    await flush()
    q<HTMLButtonElement>('[data-testid="fut-reverse-go"]').click()
    await flush()
    await wait(300)
    await flush()
    expect(sent[0]).toMatchObject({ path: 'order/order_create', body: { contractId: String(contractId), side: 'SELL', open: 'CLOSE', type: '2' } })
    expect(sent[1]).toMatchObject({ path: 'order/order_create', body: { contractId: String(contractId), side: 'SELL', open: 'OPEN' } })
    // The new short has not shown yet (this server never shows it): 「2/2」 stays up during the settle window…
    expect(q('.rv-step')?.textContent).toContain('2/2')
    expect(q('[data-testid="fut-reverse-go"]')).not.toBeNull()
    await wait(700)
    await flush()
    // …then the sheet closes with a success toast that says the new position will show shortly — never silence.
    expect(q('[data-testid="fut-reverse-go"]')).toBeNull()
    expect(useToasts().value.some((toast) => toast.tone === 'success' && toast.message.includes('新仓位稍后显示'))).toBe(true)
  })
})

describe('per-row columns use the row\'s own contract (10-01 owner bug: BTC 预估资金费用 -- on the ETH page)', () => {
  it.each(['E-ETH-USDT', 'E-BTC-USDT'] as const)('page %s: both rows show their own estimated funding', async (page) => {
    await mountTable(page)
    await wait(400)
    await flush()
    const funding = (id: number): string => row(id).querySelector('[data-testid="fut-pos-funding"]')?.textContent?.trim() ?? ''
    // BTC long 20 × 0.0001 × 83,600 × 1% = 1.67 paid; ETH long 21 × 0.001 × 2,736 × −1% = 0.57 received.
    expect(funding(7)).toBe('-1.67')
    expect(funding(8)).toBe('+0.57')
  })
})

describe('no liquidation price (≤ 0, cross balance covers it): `--` with the reason (Binance)', () => {
  it('shows -- and an info tooltip 「当前全仓余额足以覆盖该仓位，暂无强平价」', async () => {
    await mountTable('E-ETH-USDT')
    const cell = row(7).querySelector<HTMLElement>('[data-testid="fut-pos-liq-none"]')!
    expect(cell.textContent?.trim()).toBe('--')
    expect(cell.title).toContain('当前全仓余额足以覆盖该仓位，暂无强平价')
    expect(cell.querySelector('svg')).not.toBeNull()
  })
})

describe('a 市价 close that fills nothing says so (10-01 owner bug: market making paused, empty book)', () => {
  it('shows 未成交 / 没有对手盘 instead of 「市价平仓已提交」 when the position does not shrink', async () => {
    await mountTable('E-ETH-USDT')
    fills = false
    row(8).querySelector<HTMLButtonElement>('[data-testid="fut-pos-close"]')!.click()
    await flush()
    q<HTMLButtonElement>('[data-testid="fut-pcd-confirm"]').click()
    await wait(3600)
    await flush()
    const toasts = useToasts().value
    expect(toasts.some((toast) => toast.tone === 'error' && toast.message.startsWith('市价平仓未成交：当前没有对手盘'))).toBe(true)
    expect(toasts.some((toast) => toast.tone === 'success')).toBe(false)
  }, 8000)
})

describe('never a silent no-op', () => {
  it('a close while another action runs says so (toast) and sends nothing', async () => {
    await mountTable('E-ETH-USDT')
    row(8).querySelector<HTMLButtonElement>('[data-testid="fut-pos-close"]')!.click()
    await flush()
    const account = useFuturesAccountStore()
    const result = await (async () => { account.busy = 'other'; return account.closeAtMarket(account.positions[1]) })()
    // Busy: nothing sent, and a message (never null = success) so the sheet never reports a close that did not happen.
    expect(result).toBe('另一操作进行中')
    expect(sent).toHaveLength(0)
    account.busy = null
  })
})

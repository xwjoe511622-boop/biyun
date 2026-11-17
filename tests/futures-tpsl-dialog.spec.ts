// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import TpslDialog from '@/components/futures/TpslDialog.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo, type FuturesPosition } from '@/modules/futures/types'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { useFuturesMarketStore } from '@/stores/futures-market'

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null
let bodies: Record<string, unknown>[] = []
let cancels: Record<string, unknown>[] = []
let existingTpsl: unknown = {}

function makePosition(): FuturesPosition {
  return {
    id: 7,
    contractId: 1,
    contractName: 'E-BTC-USDT',
    symbol: 'BTC-USDT',
    positionType: 1,
    orderSide: 'BUY',
    positionVolume: '40',
    canCloseVolume: '40',
    openAvgPrice: '49000',
    markPrice: '50000',
    reducePrice: '40000',
    holdAmount: '0.004',
    marginRate: '0.1',
    keepRate: '0.005',
    maxFeeRate: '0.00075',
    realizedAmount: '0',
    unRealizedAmount: '0',
    openRealizedAmount: '0',
    settleProfit: '0',
    returnRate: '0',
    leverageLevel: 10,
    positionBalance: '200',
    canSubMarginAmount: '0',
    capitalFee: '0',
    tradeFee: '0',
    takeProfitPrice: '',
    stopLossPrice: '',
  }
}

beforeEach(() => {
  localStorage.clear()
  session.clear()
  bodies = []
  cancels = []
  existingTpsl = {}
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
  market.ticker = { close: '50000', open: '', high: '', low: '', vol: '', amount: '', rose: '' }
  session.setToken('jwt')
  useSizeUnit().value = 'quote'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    if (path === 'order/order_tpsl_create') {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return respond({ code: '0', data: {} })
    }
    if (path === 'order/take_profit_stop_loss') return respond({ code: '0', data: existingTpsl })
    if (path === 'order/order_tpsl_cancel') {
      cancels.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return respond({ code: '0', data: {} })
    }
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [] } })
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
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mountDialog(): Promise<void> {
  const position = makePosition()
  app = createApp(defineComponent({ setup: () => () => h(TpslDialog, { position, pricePrecision: 2, quote: 'USDT', onClose: () => undefined }) }))
  app.use(pinia)
  app.use(i18n)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
}

const q = <T extends Element>(id: string): T => document.body.querySelector(`[data-testid="${id}"]`) as T

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

function fieldError(testid: string): string {
  const input = document.body.querySelector(`[data-testid="${testid}"]`)
  return input?.closest('.field')?.querySelector('.field-error')?.textContent ?? ''
}

describe('futures TP/SL dialog', () => {
  it('default 100% closes the whole position at market', async () => {
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '52000')
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await flush()
    expect(bodies.at(-1)).toMatchObject({
      side: 'SELL',
      orderList: [{ triggerType: 2, triggerPrice: '52000', type: 2, price: '0', volume: '40' }],
    })
  })

  it('slider to 25% closes a quarter of the position', async () => {
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '52000')
    const label25 = [...document.body.querySelectorAll('.pct-label')].find((b) => b.textContent?.trim() === '25%') as HTMLButtonElement
    label25.click()
    await flush()
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await flush()
    expect(bodies.at(-1)).toMatchObject({ orderList: [{ triggerPrice: '52000', volume: '10' }] })
  })

  it('base unit converts 0.0015 BTC to 15 contracts and shows the percentage', async () => {
    await mountDialog()
    q<HTMLButtonElement>('fut-tpsl-unit-base').click()
    await flush()
    await type(q<HTMLInputElement>('fut-tpsl-qty'), '0.0015')
    expect(q<HTMLElement>('fut-tpsl-hint').textContent).toBe('≈ 75 USDT · 37%')
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '52000')
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await flush()
    expect(bodies.at(-1)).toMatchObject({ orderList: [{ volume: '15' }] })
  })

  it('USDT unit converts 100 USDT to 20 contracts', async () => {
    await mountDialog()
    q<HTMLButtonElement>('fut-tpsl-unit-quote').click()
    await flush()
    await type(q<HTMLInputElement>('fut-tpsl-qty'), '100')
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '52000')
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await flush()
    expect(bodies.at(-1)).toMatchObject({ orderList: [{ volume: '20' }] })
  })

  it('rejects a stop-loss below the liquidation price without a request', async () => {
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-sl'), '39000')
    q<HTMLInputElement>('fut-tpsl-sl').dispatchEvent(new Event('blur'))
    await flush()
    expect(fieldError('fut-tpsl-sl')).toBe('做多止损价需高于强平价 40000')
    expect(q<HTMLButtonElement>('fut-tpsl-submit').disabled).toBe(true)
    expect(bodies).toHaveLength(0)
  })

  it('QA147 shows a contract-precision grouped reference without rounding the validation boundary', async () => {
    useFuturesMarketStore().ticker.close = '80700.40690860001'
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '80700.40')
    q<HTMLInputElement>('fut-tpsl-tp').dispatchEvent(new Event('blur')); await flush()
    expect(fieldError('fut-tpsl-tp')).toBe('做多止盈价需高于最新价 80,700.40')
    expect(bodies).toHaveLength(0)
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '80700.41')
    expect(fieldError('fut-tpsl-tp')).toBe('')
    expect(bodies).toHaveLength(0)
  })

  it('rejects a take-profit below the last price without a request', async () => {
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-tp'), '49000')
    q<HTMLInputElement>('fut-tpsl-tp').dispatchEvent(new Event('blur'))
    await flush()
    expect(fieldError('fut-tpsl-tp')).toBe('做多止盈价需高于最新价 50,000.00')
    expect(bodies).toHaveLength(0)
  })
})

describe('futures TP/SL dialog: one entire-position TP and SL (Binance, 2026-09-30)', () => {
  it('a new 100% stop-loss replaces the existing whole-position stop-loss, placed first then cancelled', async () => {
    existingTpsl = { stopLossList: [{ id: '31', triggerPrice: '45000', price: '0', volume: '40', status: 0 }], takeProfitList: [{ id: '32', triggerPrice: '60000', price: '0', volume: '10', status: 0 }] }
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-sl'), '46000')
    expect(q('fut-tpsl-replace').textContent).toContain('45,000.00')
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await flush()
    expect(bodies.at(-1)).toMatchObject({ orderList: [{ triggerType: 1, triggerPrice: '46000', volume: '40' }] })
    expect(cancels).toHaveLength(1)
    expect(JSON.stringify(cancels[0])).toContain('31')
    expect(JSON.stringify(cancels[0])).not.toContain('32')
  })

  it('a partial stop-loss stacks (nothing cancelled, no note)', async () => {
    existingTpsl = { stopLossList: [{ id: '31', triggerPrice: '45000', price: '0', volume: '40', status: 0 }] }
    await mountDialog()
    await type(q<HTMLInputElement>('fut-tpsl-sl'), '46000')
    await type(q<HTMLInputElement>('fut-tpsl-qty'), '100')
    expect(q('fut-tpsl-replace').classList.contains('hidden')).toBe(true)
    q<HTMLButtonElement>('fut-tpsl-submit').click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await flush()
    expect(bodies).toHaveLength(1)
    expect(cancels).toHaveLength(0)
  })
})

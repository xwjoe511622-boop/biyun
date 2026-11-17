// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, reactive, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import OrderBook from '@/components/trade/OrderBook.vue'
import TradesPanel from '@/components/trade/TradesPanel.vue'
import SizeUnitSelect from '@/components/futures/SizeUnitSelect.vue'
import { MARKET_SOURCE, type MarketSource } from '@/components/trade/market-source'
import { i18n } from '@/i18n'
import { depthPoints } from '@/modules/market/trade-value'
import { createSizedMarketSource } from '@/modules/futures/sized-market-source'
import {
  SIZE_UNIT_KEY,
  contractsAmount,
  displayDp,
  sizeInputToContracts,
  sizeUnitLabel,
  useSizeUnit,
  valueAmount,
  type SizeContract,
} from '@/modules/futures/size-unit'
import { useSizeFormat } from '@/modules/futures/use-size-format'

const BTC: SizeContract = { multiplier: '0.0001', multiplierCoin: 'BTC', base: 'BTC', quote: 'USDT', marginCoin: 'USDT' }
const ETH: SizeContract = { multiplier: '0.01', multiplierCoin: 'ETH', base: 'ETH', quote: 'USDT', marginCoin: 'USDT' }
const XAUT: SizeContract = { multiplier: '0.001', multiplierCoin: 'XAUT', base: 'XAUT', quote: 'USDT', marginCoin: 'USDT' }
const NVDA: SizeContract = { multiplier: '1', multiplierCoin: 'NVDA', base: 'NVDA', quote: 'USDT', marginCoin: 'USDT' }

const unit = useSizeUnit()
globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} } as unknown as typeof ResizeObserver
beforeEach(() => { unit.value = 'quote' })
afterEach(() => { localStorage.clear(); document.body.innerHTML = '' })

describe('shared size formatter', () => {
  it('uses per-unit display precision from any contract', () => {
    expect(displayDp('quote', '0.0001')).toBe(2)
    expect(displayDp('base', '0.0001')).toBe(4)
    expect(displayDp('base', '0.01')).toBe(2)
    expect(displayDp('base', '1')).toBe(0)
    expect(displayDp('cont', '0.0001')).toBe(0)
  })

  it('labels the unit from the contract', () => {
    expect(sizeUnitLabel('quote', BTC, '张')).toBe('USDT')
    expect(sizeUnitLabel('base', ETH, '张')).toBe('ETH')
    expect(sizeUnitLabel('base', XAUT, '张')).toBe('XAUT')
    expect(sizeUnitLabel('cont', BTC, '张')).toBe('张')
    expect(sizeUnitLabel('base', undefined, '张')).toBe('张')
  })

  it('converts contracts: BTC = n × multiplier, USDT = n × multiplier × price (floored)', () => {
    expect(contractsAmount('396', 'base', BTC)).toEqual({ amount: '0.0396', unit: 'base', dp: 4 })
    expect(contractsAmount('396', 'quote', BTC, '84738.14')).toEqual({ amount: '3355.63', unit: 'quote', dp: 2 })
    expect(contractsAmount('3', 'quote', ETH, '3210.555')).toEqual({ amount: '96.31', unit: 'quote', dp: 2 })
    expect(contractsAmount('7', 'base', NVDA)).toEqual({ amount: '7', unit: 'base', dp: 0 })
    expect(contractsAmount('12', 'cont', BTC, '1')).toEqual({ amount: '12', unit: 'cont', dp: 0 })
  })

  it('falls back to contracts when USDT has no price or the contract is unknown', () => {
    expect(contractsAmount('5', 'quote', BTC, '')).toEqual({ amount: '5', unit: 'cont', dp: 0 })
    expect(contractsAmount('5', 'base', undefined)).toEqual({ amount: '5', unit: 'cont', dp: 0 })
    expect(contractsAmount('abc', 'base', BTC).amount).toBe('')
  })

  it('converts a market-open USDT value into the unit', () => {
    expect(valueAmount('25.5', 'quote', BTC, '85000')).toEqual({ amount: '25.5', unit: 'quote', dp: 2 })
    expect(valueAmount('42.5', 'base', BTC, '85000')).toEqual({ amount: '0.0005', unit: 'base', dp: 4 })
    expect(valueAmount('42.5', 'cont', BTC, '85000')).toEqual({ amount: '5', unit: 'cont', dp: 0 })
    expect(valueAmount('42.5', 'base', BTC, '')).toEqual({ amount: '42.5', unit: 'quote', dp: 2 })
  })

  it('formats table cells, adding the unit only when a row differs from the header', () => {
    const sizes = useSizeFormat()
    unit.value = 'base'
    expect(sizes.header('Size', BTC)).toBe('Size (BTC)')
    expect(sizes.sizeCell('396', BTC, '', BTC)).toBe('0.0396')
    expect(sizes.sizeCell('3', ETH, '', BTC)).toBe('0.03 ETH')
    unit.value = 'quote'
    expect(sizes.sizeCell('396', BTC, '84738.14', BTC)).toBe('3,355.63')
    expect(sizes.sizeCell('396', BTC, '', BTC)).toBe('396 张')
    expect(sizes.valueCell('25.5', BTC, '85000', BTC)).toBe('25.50')
    expect(sizes.sizeWithUnit('1', BTC, '84738.14')).toBe('8.47 USDT')
  })

  it('parses a TP/SL or close size typed in the unit into whole contracts', () => {
    const market = { multiplier: '0.0001', price: '84738.14', coinDp: 2 }
    const labels = { unit: 'BTC', contracts: '张' }
    expect(sizeInputToContracts('0.0396', 'base', market, { min: '1', max: '396' }, labels)).toEqual({ contracts: '396', error: null })
    expect(sizeInputToContracts('0.0397', 'base', market, { min: '1', max: '396' }, labels).error?.key).toBe('aboveCanCloseUnit')
    expect(sizeInputToContracts('0.00001', 'base', market, { min: '1', max: '396' }, labels).error?.key).toBe('precision')
    expect(sizeInputToContracts('5', 'quote', market, { min: '1', max: '396' }, { unit: 'USDT', contracts: '张' }).error).toEqual({ field: 'volume', key: 'belowMinUnit', params: { amount: '8.48', unit: 'USDT', ref: '1 张' } })
    expect(sizeInputToContracts('100', 'quote', market, { min: '1', max: '396' }, { unit: 'USDT', contracts: '张' }).contracts).toBe('11')
  })

  it('computes depth notionals from values when volumes are already USDT', () => {
    const rows = [{ price: '100', amount: '5', total: '5' }, { price: '99', amount: '10', total: '15' }]
    expect(depthPoints(rows, '1', true).map((p) => p.notional)).toEqual([5, 15])
    expect(depthPoints(rows, '0.01').map((p) => p.notional)).toEqual([5, 14.9])
  })
})

function fakeSource(): MarketSource {
  return reactive({
    currentSymbol: { symbol: 'e_btcusdt', pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 0, rules: { depthSteps: ['0.01'] }, volumeUnit: '张', valueMultiplier: '0.0001' },
    currentSymbolName: 'e_btcusdt',
    ticker: { close: '85000', open: '', high: '', low: '', vol: '', amount: '', rose: '' },
    asks: [{ price: '85001', amount: '10', total: '10', diff: 0 }, { price: '85002', amount: '30', total: '40', diff: 0 }],
    buys: [{ price: '84999', amount: '20', total: '20', diff: 0 }],
    trades: [{ price: '85000', vol: '15', side: 'BUY', ts: 1 }],
    depthStepIndex: 0,
    connectionState: 'open',
    klineScale: '15min',
    klineScales: ['15min'],
    setDepthStepIndex() {},
  }) as unknown as MarketSource
}

describe('sized market source (order book / depth / trades)', () => {
  it('restates levels at their own price and re-sums totals in the unit', () => {
    const source = createSizedMarketSource(fakeSource(), unit, () => BTC, () => '张')
    unit.value = 'quote'
    // 30 × 0.0001 × 85002 = 255.006 → floored to 255.00.
    expect(source.asks.map((row) => [row.amount, row.total])).toEqual([['85', '85'], ['255', '340']])
    expect(source.currentSymbol?.volumeUnit).toBe('USDT')
    expect(source.currentSymbol?.volumeIsValue).toBe(true)
    expect(source.currentSymbol?.volumePrecision).toBe(0)
    unit.value = 'base'
    expect(source.asks.map((row) => [row.amount, row.total])).toEqual([['0.001', '0.001'], ['0.003', '0.004']])
    expect(source.trades[0].vol).toBe('0.0015')
    expect(source.currentSymbol?.volumeDisplayPrecision).toBe(4)
    unit.value = 'cont'
    expect(source.asks[1].total).toBe('40')
    expect(source.currentSymbol?.volumeUnit).toBe('张')
  })
})

describe('components follow the shared unit', () => {
  let app: App | null = null
  afterEach(() => { app?.unmount(); app = null })

  function mount(render: () => ReturnType<typeof h>): HTMLElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    setActivePinia(createPinia())
    app = createApp(defineComponent({ setup: () => render }))
    app.use(i18n)
    app.mount(host)
    return host
  }

  it('the unit switch writes the shared preference', async () => {
    const host = mount(() => h(SizeUnitSelect, { contract: ETH }))
    // TicketSelect (bottom sheet on phones) instead of a native <select> since 2026-09-29.
    ;(host.querySelector('[data-testid="fut-size-unit"]') as HTMLButtonElement).click()
    await nextTick()
    const items = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid^="fut-size-unit-"]')]
    expect(items.map((item) => item.querySelector('b')?.textContent)).toEqual(['ETH', 'USDT'])
    items[0].click()
    await nextTick()
    expect(unit.value).toBe('base')
    expect(localStorage.getItem(SIZE_UNIT_KEY)).toBe('base')
  })

  it('the order book and trades render sizes in the chosen unit and switch live', async () => {
    const source = createSizedMarketSource(fakeSource(), unit, () => BTC, () => '张')
    unit.value = 'base'
    const host = mount(() => h(defineComponent({
      setup() {
        provide(MARKET_SOURCE, source)
        return () => h('div', [h(OrderBook), h(TradesPanel)])
      },
    })))
    await nextTick()
    const text = host.textContent ?? ''
    expect(text).toContain('(BTC)')
    expect(text).toContain('0.003')
    expect(text).toContain('0.0015')
    unit.value = 'quote'
    await nextTick()
    const after = host.textContent ?? ''
    expect(after).toContain('(USDT)')
    expect(after).toContain('340')
    expect(after).toContain('127.5')
  })
})

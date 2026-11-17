// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import {
  btcUsdtPrice,
  coinUsdValue,
  coinBtcValue,
  convertValue,
  formatCoinAmount,
  formatValuation,
  readAmountsHidden,
  readValuationUnit,
  totalUsdValue,
  usdLine,
  valuationIn,
  writeValuationUnit,
} from '@/modules/wallet/valuation'

// Synthetic only: the market store is replaced by a fixed ticker map.
const fakeMarket = reactive({ tickers: { btcusdt: { close: '110000.5' } } as Record<string, { close: string }>, start: vi.fn(() => () => undefined) })
vi.mock('@/stores/market', () => ({ useMarketStore: () => fakeMarket }))

const AssetValuation = (await import('@/components/wallet/AssetValuation.vue')).default

describe('valuation formatting (live-shaped numbers, 2026-10-01 test account)', () => {
  const TOTAL_BTC = '21.4096186770930466'

  it('BTC keeps at most 8 decimals, USDT/USD 2 decimals with separators, rounded down', () => {
    expect(formatValuation(TOTAL_BTC, 'BTC')).toBe('21.40961867')
    expect(formatValuation('0.10000000', 'BTC')).toBe('0.1')
    const usdt = convertValue(TOTAL_BTC, 'BTC', 'USDT', '110000.5')
    expect(formatValuation(usdt, 'USDT')).toBe('2,355,068.75')
    expect(formatValuation(convertValue(TOTAL_BTC, 'BTC', 'USD', '110000.5'), 'USD')).toBe('2,355,068.75')
    expect(formatValuation('', 'USDT')).toBe('--')
  })

  it('converts USDT totals to BTC and never invents a price', () => {
    expect(convertValue('110000.5', 'USDT', 'BTC', '110000.5')).toBe('1.000000000000')
    expect(convertValue(TOTAL_BTC, 'BTC', 'USDT', '')).toBe('')
    expect(convertValue('5', 'USDT', 'USD', '')).toBe('5')
    expect(btcUsdtPrice({ btcusdt: { close: '0' } })).toBe('')
    expect(btcUsdtPrice({})).toBe('')
    expect(btcUsdtPrice({ btcusdt: { close: '110000.50' } })).toBe('110000.5')
  })

  it('coin amounts use the display precision (max 8, trailing zeros trimmed) with a 2-decimal USD value', () => {
    expect(formatCoinAmount('0.0001267954400000', 8)).toBe('0.00012679')
    expect(formatCoinAmount('0.0003366179000000', 6)).toBe('0.000336')
    expect(formatCoinAmount('1795807.03', 8)).toBe('1,795,807.03')
    expect(formatCoinAmount('0.5', 12)).toBe('0.5')
    expect(formatCoinAmount('', 8)).toBe('--')
    const tickers = { btcusdt: { close: '110000.5' }, tslausdt: { close: '352.35' } }
    // BTC: own pair price; TSLA: own pair; USDT: 1:1; XAUT (no ticker here): BTC valuation × BTC price.
    expect(usdLine(coinUsdValue('BTC', '0.0001267954400000', '0.00012679544', tickers))).toBe('≈ $13.94')
    expect(usdLine(coinUsdValue('TSLA', '0.0005972785600000', '0.0000025', tickers))).toBe('≈ $0.21')
    expect(usdLine(coinUsdValue('USDT', '1795807.03', '21.41', tickers))).toBe('≈ $1,795,807.03')
    expect(usdLine(coinUsdValue('XAUT', '0.000036', '0.0000017895982519', tickers))).toBe('≈ $0.19')
    expect(coinUsdValue('XAUT', '0.000036', '0.0000017895982519', {})).toBe('')
    expect(usdLine('')).toBe('')
  })

  it('remembers the unit and the hidden flag per user', () => {
    localStorage.clear()
    expect(readValuationUnit('10001')).toBe('BTC')
    writeValuationUnit('10001', 'USDT')
    expect(readValuationUnit('10001')).toBe('USDT')
    expect(readValuationUnit('10002')).toBe('BTC')
    expect(readAmountsHidden('10001')).toBe(false)
  })
})

describe('QA-213 current balance BTC valuation', () => {
  it('uses the current exact holding and current quotes, with no legacy BTC snapshot', () => {
    const tickers = { btcusdt: { close: '3' }, ethusdt: { close: '0.2' } }
    expect(coinBtcValue('USDT', '0.3', tickers)).toBe('0.100000000000')
    expect(coinBtcValue('ETH', '0.1', tickers)).toBe('0.006666666666')
    expect(coinBtcValue('BTC', '0.1234567890123456', {})).toBe('0.1234567890123456')
    expect(coinBtcValue('USDT', '9007199254740993.1234567890123456', { btcusdt: { close: '1' } })).toBe('9007199254740993.123456789012')
    expect(coinBtcValue('USDT', '0.0000000000000001', tickers)).toBe('0.000000000000')
  })
  it('keeps missing/zero/invalid quotes unknown without dividing by zero or inventing a price', () => {
    for (const tickers of [{}, { btcusdt: { close: '0' } }, { btcusdt: { close: '-1' } }, { btcusdt: { close: 'bad' } }]) {
      expect(coinBtcValue('USDT', '1', tickers)).toBe('')
    }
    expect(coinBtcValue('SOL', '1', { btcusdt: { close: '1' } })).toBe('')
    expect(coinBtcValue('SOL', '0', {})).toBe('0')
    expect(coinBtcValue('USDT', '', { btcusdt: { close: '1' } })).toBe('')
  })
})

describe('QA-001: USDT is valued 1:1, not re-priced through a BTC snapshot', () => {
  // 1,998,949.83 USDT snapshot at BTC 81,766.97, shown while the live price is 81,788.41.
  const rows = [
    { coin: 'USDT', total: '1998949.83', btcValuation: '24.4469' },
    { coin: 'BTC', total: '0.00000976', btcValuation: '0.00000976' },
    { coin: 'ETH', total: '0', btcValuation: '0' },
  ]
  const tickers = { btcusdt: { close: '81788.41' }, ethusdt: { close: '3900' } }

  it('sums holdings at their own price, USDT 1:1, whatever BTC does', () => {
    expect(totalUsdValue(rows, tickers)).toBe('1998950.6282548816')
    expect(totalUsdValue(rows, { ...tickers, btcusdt: { close: '90000' } })).toBe('1998950.7084')
  })

  it('returns "" when a held coin has no price, and skips zero holdings', () => {
    expect(totalUsdValue([{ coin: 'NVDA', total: '1', btcValuation: '' }], {})).toBe('')
    expect(totalUsdValue([{ coin: 'NVDA', total: '0', btcValuation: '' }], {})).toBe('0')
  })

  it('USDT/USD use the sum, BTC keeps the server snapshot', () => {
    expect(valuationIn('USDT', '24.44690976', 'BTC', '1998950.62', '81788.41')).toBe('1998950.62')
    expect(valuationIn('BTC', '24.44690976', 'BTC', '1998950.62', '81788.41')).toBe('24.44690976')
    expect(valuationIn('USD', '1', 'BTC', '', '100')).toBe('100')
  })
})

describe('AssetValuation card', () => {
  let host: HTMLDivElement
  let app: App | null = null
  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    setActivePinia(createPinia())
  })
  afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = '' })

  async function mount(): Promise<void> {
    const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: {} })
    app = createApp(AssetValuation, { label: '总资产估值', total: '21.4096186770930466', symbol: 'BTC' })
    app.use(i18n).use(createPinia()).mount(host)
    await nextTick()
  }
  const q = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

  it('shows the total with a unit selector and a ≈ $ line, switches unit and hides amounts', async () => {
    await mount()
    expect(q('valuation-total').textContent).toBe('21.40961867')
    expect((q('valuation-unit') as HTMLSelectElement).value).toBe('BTC')
    expect(q('valuation-usd').textContent).toBe('≈ $2,355,068.75')
    const select = q('valuation-unit') as HTMLSelectElement
    select.value = 'USDT'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(q('valuation-total').textContent).toBe('2,355,068.75')
    expect(readValuationUnit('')).toBe('USDT')
    host.querySelector<HTMLButtonElement>('.val-eye')!.click()
    await nextTick()
    expect(q('valuation-total').textContent).toBe('******')
    expect(host.textContent).not.toContain('2,355,068')
    expect(readAmountsHidden('')).toBe(true)
    host.querySelector<HTMLButtonElement>('.val-eye')!.click()
    await nextTick()
  })

  it('shows -- for USDT when there is no BTC price yet (no invented number)', async () => {
    fakeMarket.tickers = {}
    writeValuationUnit('', 'USDT')
    await mount()
    // The shared prefs were read for this user before; re-select to apply the stored unit.
    const select = q('valuation-unit') as HTMLSelectElement
    select.value = 'USDT'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(q('valuation-total').textContent).toBe('--')
    expect(host.querySelector('[data-testid="valuation-usd"]')).toBeNull()
    fakeMarket.tickers = { btcusdt: { close: '110000.5' } }
  })
})

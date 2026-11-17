import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/errors'
import { minOpenOrder } from '@/modules/api/exchange-filters'
import { describeSpotV3Error } from '@/modules/spot/spot-errors'
import {
  checkFuturesMaxQty, checkFuturesPrice, checkSpotPrice, spotMinOrder, spotPriceBand, spotPriceRange,
} from '@/modules/trade/order-rules'
import { toSpotWire } from '@/modules/trade/spot-size-unit'

// QA 10-26 建议-020 / 建议-028 (XAUT): price 4000, step 0.0001, min notional 5, max price 1000000, band 0.95–1.05.
const XAUT = { tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000', stepSize: '0.0001', minQty: '0.0001', minNotional: '5', bidMultiplierUp: '1.05', bidMultiplierDown: '0.95', askMultiplierUp: '1.05', askMultiplierDown: '0.95' }

describe('spot minimum at the current price (建议-020)', () => {
  it('XAUT 4000, step 0.0001, min 5 USDT -> 0.0013 XAUT = 5.2 USDT', () => {
    expect(spotMinOrder('4000', '0.0001', '0.0001', '5')).toEqual({ qty: '0.0013', total: '5.2' })
  })
  it('4.99 USDT rounds down to 0.0012 XAUT = 4.8 USDT (below the minimum)', () => {
    const wire = toSpotWire('1', 'BUY', 'quote', '4.99', { step: '0.0001', quotePrecision: 2, refPrice: '4000' })
    expect(wire.baseQty).toBe('0.0012')
    expect(wire.quoteTotal).toBe('4.8')
  })
  it('an exact multiple is not bumped: min 4.8 at 4000 -> 0.0012', () => {
    expect(spotMinOrder('4000', '0.0001', undefined, '4.8')).toEqual({ qty: '0.0012', total: '4.8' })
  })
  it('minQty dominates, decimals stay exact (0.1 + 0.2 style)', () => {
    expect(spotMinOrder('0.3', '0.1', '0.2', '0.01')).toEqual({ qty: '0.2', total: '0.06' })
  })
  it('unknown price / step / limits -> null', () => {
    expect(spotMinOrder('', '0.0001', '0.0001', '5')).toBeNull()
    expect(spotMinOrder('0', '0.0001', '0.0001', '5')).toBeNull()
    expect(spotMinOrder('4000', '0', '0.0001', '5')).toBeNull()
    expect(spotMinOrder('4000', '0.0001', undefined, undefined)).toBeNull()
  })
})

describe('spot price rules (建议-028)', () => {
  it('1000000.01 breaks PRICE_FILTER max with the range named', () => {
    expect(checkSpotPrice('BUY', '1000000.01', '1000000', { ...XAUT, bidMultiplierUp: undefined, bidMultiplierDown: undefined })).toEqual({ key: 'priceRange', params: { min: '0.01', max: '1000000' } })
  })
  it('off-tick price', () => {
    expect(checkSpotPrice('BUY', '4000.005', '4000', XAUT)?.key).toBe('priceTick')
  })
  it('BUY band around the last price, bounds rounded to the tick like the guard', () => {
    expect(spotPriceBand('BUY', '4020.97', XAUT)).toEqual({ min: '3819.93', max: '4222.01', up: '105', down: '95' })
    expect(checkSpotPrice('BUY', '4222.01', '4020.97', XAUT)).toBeNull()
    const over = checkSpotPrice('BUY', '4222.02', '4020.97', XAUT)
    expect(over).toEqual({ key: 'priceBand', params: { min: '3819.93', max: '4222.01', ref: '4020.97', down: '95%', up: '105%' } })
    expect(checkSpotPrice('SELL', '3819.92', '4020.97', XAUT)?.key).toBe('priceBand')
  })
  it('no last price: only PRICE_FILTER applies (the guard skips the band too)', () => {
    expect(checkSpotPrice('BUY', '9000', '', XAUT)).toBeNull()
  })
  it('allowed range = PRICE_FILTER ∩ band', () => {
    expect(spotPriceRange('BUY', '4000', XAUT)).toEqual({ min: '3800', max: '4200' })
    expect(spotPriceRange('BUY', '', XAUT)).toEqual({ min: '0.01', max: '1000000' })
    expect(spotPriceRange('BUY', '4000', undefined)).toEqual({ min: '', max: '' })
  })
  it('filter fields as JSON numbers stay exact', () => {
    expect(spotPriceBand('SELL', '0.3', { askMultiplierUp: 1.1 as unknown as string, askMultiplierDown: 0.9 as unknown as string, tickSize: '0.01' })).toEqual({ min: '0.27', max: '0.33', up: '110', down: '90' })
  })
})

describe('futures rules (建议-020 / 建议-028)', () => {
  const XAUT_F = { multiplier: '0.001', minQty: '0.001', maxQty: '10', minNotional: '5', tickSize: '0.01', minPrice: '1', maxPrice: '100000', multiplierUp: '1.05', multiplierDown: '0.95' }
  it('5 or 7.99 USDT at 4000 is 1 contract (4 USDT); the effective minimum is 2 contracts = 8 USDT', () => {
    expect(minOpenOrder(XAUT_F, '4000')).toEqual({ contracts: 2, coin: '0.002', usdt: '8' })
  })
  it('fixed max price', () => {
    expect(checkFuturesPrice('BUY', '100000.01', '4020.97', XAUT_F)).toEqual({ key: 'priceRange', params: { min: '1', max: '100000' } })
  })
  it('BUY above mark × up -> the guard bound (round down to tick)', () => {
    expect(checkFuturesPrice('BUY', '4500', '4020.97', XAUT_F)).toEqual({ key: 'priceBandMax', params: { max: '4222.01', mark: '4020.97', pct: '105%' } })
    expect(checkFuturesPrice('BUY', '3000', '4020.97', XAUT_F)).toBeNull() // a low BUY is allowed by the futures guard
    expect(checkFuturesPrice('SELL', '3000', '4020.97', XAUT_F)).toEqual({ key: 'priceBandMin', params: { min: '3819.93', mark: '4020.97', pct: '95%' } })
  })
  it('mark rounded to the tick scale half away from zero before the band', () => {
    expect(checkFuturesPrice('BUY', '4222.01', '4020.965', XAUT_F)).toBeNull() // mark -> 4020.97, bound 4222.0185
  })
  it('max quantity on an opening order', () => {
    expect(checkFuturesMaxQty('10000', '0.001', '10')).toBeNull()
    expect(checkFuturesMaxQty('10001', '0.001', '10')).toEqual({ key: 'qtyMax', params: { max: '10', contracts: '10000' } })
    expect(checkFuturesMaxQty('5', '0.001', undefined)).toBeNull()
  })
})

describe('server filter refusals in Chinese (建议-028)', () => {
  const v3 = (code: string, message: string, data?: unknown): ApiError => new ApiError({ kind: 'api', code, message, data, path: 'api/v3/order', product: 'spot' })
  it('PERCENT_PRICE_BY_SIDE with bounds: range, reference and percentages', () => {
    const text = describeSpotV3Error(v3('-1013', 'Filter failure: PERCENT_PRICE_BY_SIDE', { filter: 'PERCENT_PRICE_BY_SIDE', minPrice: '3819.93', maxPrice: '4222.01', referencePrice: '4020.97', multiplierDown: '0.95', multiplierUp: '1.05', reason: 'PRICE_OUT_OF_BAND' }), 'zh-CN')
    expect(text).toBe('不符合下单规则：价格超出允许范围：须在 3819.93 – 4222.01 之间（最新成交价 4020.97 的 95% – 105%），请调整价格')
  })
  it('PRICE_FILTER too high names the maximum', () => {
    const text = describeSpotV3Error(v3('-1013', 'Filter failure: PRICE_FILTER', { filter: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000', price: '1000000.01', reason: 'PRICE_TOO_HIGH' }), 'zh-CN')
    expect(text).toBe('不符合下单规则：价格太高：最高 1000000')
  })
  it('LOT_SIZE / NOTIONAL with bounds', () => {
    expect(describeSpotV3Error(v3('-1013', 'Filter failure: LOT_SIZE', { filter: 'LOT_SIZE', stepSize: '0.0001', quantity: '0.00125', reason: 'STEP_SIZE' }), 'zh-CN')).toBe('不符合下单规则：数量须为 0.0001 的整数倍')
    expect(describeSpotV3Error(v3('-1013', 'Filter failure: NOTIONAL', { filter: 'NOTIONAL', minNotional: '5', notional: '4.8', reason: 'NOTIONAL_TOO_SMALL' }), 'zh-CN')).toBe('不符合下单规则：订单金额太小：至少 5 USDT（当前约 4.8 USDT）')
  })
  it('a bare filter name is never shown as the only text', () => {
    for (const filter of ['PERCENT_PRICE_BY_SIDE', 'PRICE_FILTER', 'LOT_SIZE', 'MIN_NOTIONAL', 'MARKET_LOT_SIZE', 'NOTIONAL', 'MAX_NUM_ORDERS']) {
      const text = describeSpotV3Error(v3('-1013', `Filter failure: ${filter}`), 'zh-CN') ?? ''
      expect(text.startsWith('不符合下单规则：'), filter).toBe(true)
      expect(text.includes(filter), filter).toBe(false)
    }
  })
  it('MAX_NUM_ORDERS (-2010) is a rule refusal, not self-trade', () => {
    expect(describeSpotV3Error(v3('-2010', 'Filter failure: MAX_NUM_ORDERS', { filter: 'MAX_NUM_ORDERS', maxNumOrders: 200, reason: 'TOO_MANY_OPEN_ORDERS' }), 'zh-CN')).toBe('不符合下单规则：该交易对的未成交挂单已达上限 200 笔，请先撤掉部分挂单')
  })
  it('core business refusals keep their own text', () => {
    expect(describeSpotV3Error(v3('-2010', 'Order rejected: INSUFFICIENT_BALANCE'), 'zh-CN')).toBe('余额不足，无法冻结这笔委托')
  })
})

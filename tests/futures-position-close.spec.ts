import { describe, expect, it } from 'vitest'
import {
  bestOppositePrice,
  closeOrderPayload,
  closePriceBand,
  contractsToEntry,
  defaultClosePrice,
  marketCloseRoute,
  marketCloseWire,
  percentContracts,
  roundToTick,
  validateClose,
  type CloseValidationInput,
} from '@/modules/futures/position-close'
import { orderCreateBody } from '@/modules/futures/api'

function input(patch: Partial<CloseValidationInput> = {}): CloseValidationInput {
  return {
    kind: 'market',
    side: 'SELL',
    rawPrice: '',
    rawQty: '',
    unit: 'cont',
    multiplier: '0.0001',
    pricePrecision: 2,
    coinDp: 2,
    canClose: '10',
    positionVolume: '10',
    mark: '',
    last: '',
    ...patch,
  }
}

describe('closeOrderPayload', () => {
  it('builds a SELL CLOSE limit order for a long cross position', () => {
    const payload = closeOrderPayload({
      position: { contractId: 2, orderSide: 'BUY', positionType: 1, leverageLevel: 20 },
      kind: 'limit',
      price: '2500.5',
      contracts: '5',
    })
    expect(payload).toEqual({
      contractId: 2,
      positionType: 1,
      side: 'SELL',
      open: 'CLOSE',
      type: 1,
      volume: '5',
      price: '2500.5',
      leverageLevel: 20,
      isConditionOrder: false,
    })
    expect(orderCreateBody(payload)).toEqual({
      contractId: '2',
      positionType: '1',
      side: 'SELL',
      open: 'CLOSE',
      type: '1',
      volume: '5',
      price: '2500.5',
      leverageLevel: '20',
      isConditionOrder: 'false',
    })
  })

  it('builds a BUY market close for a short isolated position', () => {
    const payload = closeOrderPayload({
      position: { contractId: 3, orderSide: 'SELL', positionType: 2, leverageLevel: 10 },
      kind: 'market',
      price: 'ignored',
      contracts: '7',
    })
    expect(payload.side).toBe('BUY')
    expect(payload.type).toBe(2)
    expect(payload.price).toBe('')
    expect(payload.positionType).toBe(2)
    expect(payload.volume).toBe('7')
  })

  it('throws when the position side is unknown', () => {
    expect(() => closeOrderPayload({
      position: { contractId: 1, orderSide: '', positionType: null, leverageLevel: null },
      kind: 'market',
      price: '',
      contracts: '1',
    })).toThrow()
  })
})

describe('marketCloseRoute', () => {
  it('routes a whole-position market close to a whole MARKET close, partial to an order', () => {
    expect(marketCloseRoute({ full: true })).toBe('closeWhole')
    expect(marketCloseRoute({ full: false })).toBe('order')
  })

  it('chooses the whole close only when the whole position is closable and chosen', () => {
    expect(marketCloseRoute(validateClose(input({ unit: 'cont', rawQty: '7', canClose: '10', positionVolume: '10' })))).toBe('order')
    expect(marketCloseRoute(validateClose(input({ unit: 'cont', rawQty: '10', canClose: '10', positionVolume: '10' })))).toBe('closeWhole')
    expect(marketCloseRoute(validateClose(input({ unit: 'cont', rawQty: '7', canClose: '7', positionVolume: '10' })))).toBe('order')
  })
})

describe('quick-pick sizes', () => {
  it('computes whole-contract percentages', () => {
    expect(percentContracts('33', 25)).toBe('8')
    expect(percentContracts('33', 50)).toBe('16')
    expect(percentContracts('33', 75)).toBe('24')
    expect(percentContracts('33', 100)).toBe('33')
    expect(percentContracts('0', 25)).toBe('0')
    expect(percentContracts('', 50)).toBe('0')
  })

  it('expresses contracts in the entry unit', () => {
    const market = { multiplier: '0.0001', price: '', coinDp: 2 }
    expect(contractsToEntry('33', 'base', market)).toBe('0.0033')
    expect(contractsToEntry('33', 'cont', market)).toBe('33')
  })
})

describe('price helpers', () => {
  it('rounds to the tick and strips trailing zeros', () => {
    expect(roundToTick('2000.005', 2, 'half')).toBe('2000.01')
    expect(roundToTick('2000.004', 2, 'half')).toBe('2000')
    expect(roundToTick('2000.001', 2, 'down')).toBe('2000')
    expect(roundToTick('2000.001', 2, 'up')).toBe('2000.01')
    expect(roundToTick('', 2, 'half')).toBe('')
    expect(roundToTick('0', 2, 'half')).toBe('')
  })

  it('computes the per-side PERCENT_PRICE band from the rounded mark', () => {
    expect(closePriceBand({ mark: '2000', dp: 2, side: 'BUY', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } }))
      .toEqual({ min: '', max: '2100', mark: '2000' })
    expect(closePriceBand({ mark: '2000', dp: 2, side: 'SELL', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } }))
      .toEqual({ min: '1900', max: '', mark: '2000' })
    expect(closePriceBand({ mark: '2000.005', dp: 2, side: 'BUY', filter: { multiplierUp: '1.05' } }).mark).toBe('2000.01')
    expect(closePriceBand({ mark: '', dp: 2, side: 'BUY' })).toEqual({ min: '', max: '', mark: '' })
    expect(closePriceBand({ mark: '2000', dp: 2, side: 'BUY' })).toEqual({ min: '', max: '', mark: '2000' })
  })

  it('picks the best opposite price from the book', () => {
    expect(bestOppositePrice('BUY', { asks: ['10', '9'], bids: ['8', '7'] })).toBe('10')
    expect(bestOppositePrice('SELL', { asks: ['10', '9'], bids: ['8', '7'] })).toBe('8')
    expect(bestOppositePrice('BUY', { asks: ['0', '10'], bids: [] })).toBe('10')
    expect(bestOppositePrice('BUY', { asks: [], bids: [] })).toBe('')
  })

  it('defaults the close price to last then mark', () => {
    expect(defaultClosePrice('', '2000.5', 2)).toBe('2000.50')
    expect(defaultClosePrice('2000.51', '2000.5', 2)).toBe('2000.51')
    expect(defaultClosePrice('', '', 2)).toBe('')
  })
})

describe('validateClose conversions', () => {
  it('converts a base-coin amount to whole contracts', () => {
    const result = validateClose(input({ unit: 'base', rawQty: '0.0015', canClose: '20', positionVolume: '20' }))
    expect(result.contracts).toBe('15')
    expect(result.errors).toEqual([])
  })

  it('rejects a base amount finer than the face value', () => {
    const result = validateClose(input({ unit: 'base', rawQty: '0.00159', canClose: '20', positionVolume: '20' }))
    expect(result.errors).toContainEqual({ field: 'qty', key: 'qtyPrecision', params: { dp: 4 } })
  })

  it('converts a USDT amount at the limit price', () => {
    const result = validateClose(input({ kind: 'limit', side: 'SELL', unit: 'quote', rawPrice: '50000', rawQty: '100', canClose: '20', positionVolume: '20' }))
    expect(result.contracts).toBe('20')
    expect(result.errors).toEqual([])
  })

  it('uses the mark price to size a market close in USDT', () => {
    const result = validateClose(input({ unit: 'quote', rawQty: '100', mark: '50000', canClose: '20', positionVolume: '20' }))
    expect(result.contracts).toBe('20')
  })

  it('keeps whole contracts as-is', () => {
    expect(validateClose(input({ unit: 'cont', rawQty: '7', canClose: '7' })).contracts).toBe('7')
  })

  it('lets a preset contract count bypass the typed amount', () => {
    const result = validateClose(input({ unit: 'quote', rawQty: 'garbage', presetContracts: '33', canClose: '33', positionVolume: '33' }))
    expect(result.contracts).toBe('33')
    expect(result.errors).toEqual([])
  })
})

describe('validateClose price', () => {
  it('requires a price for a limit close', () => {
    expect(validateClose(input({ kind: 'limit', side: 'SELL', rawPrice: '' })).errors)
      .toContainEqual({ field: 'price', key: 'priceRequired' })
  })

  it('rejects a price finer than the tick', () => {
    expect(validateClose(input({ kind: 'limit', side: 'SELL', rawPrice: '2500.555' })).errors)
      .toContainEqual({ field: 'price', key: 'pricePrecision', params: { dp: 2 } })
  })

  it('enforces the buy-side upper band', () => {
    const over = validateClose(input({ kind: 'limit', side: 'BUY', rawPrice: '2100.01', mark: '2000', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } }))
    expect(over.errors).toContainEqual({ field: 'price', key: 'bandMax', params: { max: '2100', mark: '2000' } })
    expect(validateClose(input({ kind: 'limit', side: 'BUY', rawPrice: '2100', mark: '2000', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } })).price).toBe('2100')
  })

  it('enforces the sell-side lower band', () => {
    const under = validateClose(input({ kind: 'limit', side: 'SELL', rawPrice: '1899.99', mark: '2000', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } }))
    expect(under.errors).toContainEqual({ field: 'price', key: 'bandMin', params: { min: '1900', mark: '2000' } })
  })
})

describe('validateClose quantity', () => {
  it('blocks a size above the closable contracts', () => {
    expect(validateClose(input({ unit: 'cont', rawQty: '15', canClose: '10', positionVolume: '10' })).errors)
      .toContainEqual({ field: 'qty', key: 'aboveCanClose', params: { amount: '10', contracts: '10' } })
  })

  it('reports nothing to close when the closable volume is zero', () => {
    expect(validateClose(input({ unit: 'cont', rawQty: '5', canClose: '0', positionVolume: '10' })).errors)
      .toContainEqual({ field: 'qty', key: 'nothingToClose', params: { held: '10' } })
  })

  it('blocks a size that floors below one contract', () => {
    expect(validateClose(input({ unit: 'quote', rawQty: '1', mark: '50000', canClose: '10', positionVolume: '10' })).errors)
      .toContainEqual({ field: 'qty', key: 'belowOneContract', params: { amount: '5' } })
  })

  it('applies the market and limit max volumes per order', () => {
    expect(validateClose(input({ unit: 'cont', rawQty: '10', canClose: '10', maxMarketVolume: '5' })).errors)
      .toContainEqual({ field: 'qty', key: 'aboveMaxVolume', params: { max: '5' } })
    expect(validateClose(input({ kind: 'limit', unit: 'cont', rawPrice: '50000', rawQty: '10', canClose: '10', maxLimitVolume: '5', maxMarketVolume: '100' })).errors)
      .toContainEqual({ field: 'qty', key: 'aboveMaxVolume', params: { max: '5' } })
  })

  it('marks full only when the whole position is closable and chosen', () => {
    expect(validateClose(input({ unit: 'cont', rawQty: '10', canClose: '10', positionVolume: '10' })).full).toBe(true)
    expect(validateClose(input({ unit: 'cont', rawQty: '7', canClose: '7', positionVolume: '10' })).full).toBe(false)
    expect(validateClose(input({ unit: 'cont', rawQty: '10', canClose: '10', positionVolume: '10' })).ok).toBe(true)
  })
})

describe('matches the live server (ETH, 2026-09-29 21:05)', () => {
  it('BUY close band = floor(mark × 1.05) like -1013 PERCENT_PRICE maxPrice 2873.64 at mark 2736.8', () => {
    expect(closePriceBand({ mark: '2736.8', dp: 2, side: 'BUY', filter: { multiplierUp: '1.05', multiplierDown: '0.95' } }))
      .toEqual({ min: '', max: '2873.64', mark: '2736.8' })
  })
})

describe('marketCloseWire (10-03: always MARKET; the server caps the close at the bankruptcy price)', () => {
  const base = { mark: '2680', takeBound: '0.05', pricePrecision: 2 }
  it('a high-leverage long whose liquidation price is inside mark x 0.95 still closes with a MARKET order', () => {
    // live 09-30: 50x isolated ETH long, liq 2642.2750113, guard edge 2680 x 0.95 = 2546 < liq (was a client IOC at 2642.29)
    expect(marketCloseWire({ ...base, positionSide: 'BUY', liquidationPrice: '2642.2750113036927' })).toEqual({ type: 2, price: '' })
    expect(marketCloseWire({ ...base, positionSide: 'SELL', liquidationPrice: '2717.9' })).toEqual({ type: 2, price: '' })
  })
  it('and every other case too', () => {
    expect(marketCloseWire({ ...base, positionSide: 'BUY', liquidationPrice: '2400' })).toEqual({ type: 2, price: '' })
    expect(marketCloseWire({ ...base, positionSide: 'BUY', liquidationPrice: '' })).toEqual({ type: 2, price: '' })
  })
})

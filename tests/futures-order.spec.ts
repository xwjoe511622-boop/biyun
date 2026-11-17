import { describe, expect, it } from 'vitest'
import { orderCreateBody, tpslBody } from '@/modules/futures/api'
import {
  contractsValue,
  isValueVolume,
  maxOpenContracts,
  maxOpenValue,
  openCost,
  percentOf,
  validateFuturesOrder,
  validateLeverage,
  valueToContracts,
  type FuturesDraft,
  type FuturesValidationContext,
} from '@/modules/futures/math'

const contract: FuturesValidationContext['contract'] = {
  pricePrecision: 1,
  marginCoinPrecision: 4,
  minLever: 1,
  maxLever: 100,
  minOrderVolume: '1',
  maxLimitVolume: '1000',
  maxMarketVolume: '500',
  maxMarketMoney: '1000000',
  minOrderMoney: '5',
  multiplier: '0.001',
}

function draft(patch: Partial<FuturesDraft> = {}): FuturesDraft {
  return { mode: 'limit', open: 'OPEN', side: 'BUY', price: '65000.5', triggerPrice: '', triggerAtMarket: false, volume: '10', leverage: 20, tpTrigger: '', slTrigger: '', ...patch }
}

function keys(patch: Partial<FuturesDraft>, context: Partial<FuturesValidationContext> = {}): string[] {
  return validateFuturesOrder(draft(patch), { contract, canClose: '', referencePrice: '65000', ...context }).errors.map((e) => `${e.field}:${e.key}`)
}

describe('futures order validation', () => {
  it('accepts a valid limit open and returns canonical strings', () => {
    const result = validateFuturesOrder(draft({ price: '65000.50', volume: '010' }), { contract, canClose: '', referencePrice: '65000' })
    expect(result.ok).toBe(true)
    expect(result.price).toBe('65000.5')
  })

  it('enforces price precision and positivity', () => {
    expect(keys({ price: '65000.55' })).toContain('price:precision')
    expect(keys({ price: '0' })).toContain('price:mustBePositive')
    expect(keys({ price: '' })).toContain('price:required')
    expect(keys({ price: '1e5' })).toContain('price:invalidNumber')
  })

  it('requires whole contracts within min/max bounds', () => {
    expect(keys({ volume: '1.5' })).toContain('volume:wholeContracts')
    expect(keys({ volume: '0' })).toContain('volume:mustBePositive')
    expect(keys({ volume: '1001' })).toContain('volume:aboveMaxVolume')
    expect(keys({ mode: 'market', open: 'CLOSE', volume: '501' })).toContain('volume:aboveMaxVolume')
  })

  it('sizes a market open by value in the margin coin', () => {
    expect(isValueVolume({ mode: 'market', open: 'OPEN', triggerAtMarket: false })).toBe(true)
    expect(isValueVolume({ mode: 'trigger', open: 'OPEN', triggerAtMarket: true })).toBe(true)
    expect(isValueVolume({ mode: 'market', open: 'CLOSE', triggerAtMarket: false })).toBe(false)
    expect(keys({ mode: 'market', volume: '100.12345' })).toContain('volume:precision')
    expect(keys({ mode: 'market', volume: '4' })).toContain('volume:belowMinValue')
    expect(keys({ mode: 'market', volume: '100.5' })).toEqual([])
  })

  it('bounds leverage to the contract range for opening orders', () => {
    expect(validateLeverage(0, 1, 100)?.key).toBe('leverageRange')
    expect(validateLeverage(101, 1, 100)?.key).toBe('leverageRange')
    expect(validateLeverage(2.5, 1, 100)?.key).toBe('leverageInteger')
    expect(validateLeverage(100, 1, 100)).toBeNull()
    expect(keys({ leverage: 125 })).toContain('leverage:leverageRange')
    expect(keys({ open: 'CLOSE', leverage: 125 }, { canClose: '50' })).not.toContain('leverage:leverageRange')
  })

  it('never closes more than the position allows', () => {
    expect(keys({ open: 'CLOSE', volume: '51' }, { canClose: '50' })).toContain('volume:aboveCanClose')
    expect(keys({ open: 'CLOSE', volume: '50' }, { canClose: '50' })).toEqual([])
  })

  it('requires trigger price for conditional orders and a limit price unless at market', () => {
    expect(keys({ mode: 'trigger', triggerPrice: '' })).toContain('triggerPrice:required')
    expect(keys({ mode: 'trigger', triggerPrice: '64000', triggerAtMarket: true, price: '', volume: '100' })).toEqual([])
  })

  it('checks OTO take-profit / stop-loss direction per side', () => {
    expect(keys({ tpTrigger: '64000' })).toContain('tp:tpAboveEntry')
    expect(keys({ slTrigger: '66000' })).toContain('sl:slBelowEntry')
    expect(keys({ side: 'SELL', tpTrigger: '66000' })).toContain('tp:tpBelowEntry')
    expect(keys({ side: 'SELL', slTrigger: '64000' })).toContain('sl:slAboveEntry')
    expect(keys({ tpTrigger: '70000', slTrigger: '60000.5' })).toEqual([])
  })
})

describe('futures estimates', () => {
  it('computes value, cost and max open with decimal strings', () => {
    expect(contractsValue('10', '0.001', '65000')).toBe('650')
    expect(openCost({ contracts: '10', price: '65000', multiplier: '0.001', leverage: 20, marginRate: '1' })).toBe('32.5')
    expect(openCost({ value: '1000', multiplier: '0.001', leverage: 10, marginRate: '1' })).toBe('100')
    expect(maxOpenContracts({ available: '100', leverage: 20, price: '65000', multiplier: '0.001', marginRate: '1' })).toBe('30')
    expect(maxOpenValue({ available: '100.123456', leverage: 20, marginRate: '1', dp: 4 })).toBe('2002.4691')
    expect(valueToContracts('650', '0.001', '65000')).toBe('10')
    expect(percentOf('30', 25, 0)).toBe('7')
    expect(openCost({ contracts: '10', price: '', multiplier: '0.001', leverage: 20, marginRate: '1' })).toBe('')
  })
})

describe('futures request bodies', () => {
  it('serialises order_create as strings (Map<String,String>)', () => {
    const body = orderCreateBody({
      contractId: 1, positionType: 2, side: 'SELL', open: 'OPEN', type: 1, volume: '10', price: '65000.5', leverageLevel: 20,
      isConditionOrder: false, tpsl: { takerProfitTrigger: '60000', stopLossTrigger: '' },
    })
    expect(body).toEqual({
      contractId: '1', positionType: '2', side: 'SELL', open: 'OPEN', type: '1', volume: '10', price: '65000.5', leverageLevel: '20',
      isConditionOrder: 'false', isOto: 'true', takerProfitTrigger: '60000', takerProfitPrice: '0', takerProfitType: '2',
    })
    const conditional = orderCreateBody({ contractId: 1, positionType: 1, side: 'BUY', open: 'OPEN', type: 2, volume: '100', price: '', leverageLevel: 5, isConditionOrder: true, triggerPrice: '64000' })
    expect(conditional.triggerPrice).toBe('64000')
    expect(conditional.isConditionOrder).toBe('true')
  })

  it('builds the tpsl body with the closing side', () => {
    const body = tpslBody({ contractId: 1, positionId: 9, positionType: 1, leverageLevel: 20, closeSide: 'SELL', legs: [{ triggerType: 2, triggerPrice: '70000', price: '0', type: 2, volume: '5' }] })
    expect(body).toMatchObject({ side: 'SELL', positionId: 9, orderList: [{ triggerType: 2, triggerPrice: '70000', type: 2, volume: '5' }] })
  })
})

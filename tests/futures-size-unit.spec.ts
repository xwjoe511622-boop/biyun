import { afterEach, describe, expect, it } from 'vitest'
import { Decimal } from '@/modules/finance/decimal'
import { maxOpenContracts, maxOpenValue, percentOf, valueWireDp, type FuturesDraft, type FuturesValidationContext } from '@/modules/futures/math'
import {
  DEFAULT_SIZE_UNIT,
  SIZE_UNITS,
  SIZE_UNIT_KEY,
  baseDp,
  contractsToUnit,
  needsReferencePrice,
  readSizeUnit,
  saveSizeUnit,
  unitDp,
  unitToContracts,
  unitToValue,
  validateSizedOrder,
  valueToUnit,
  type SizeMarket,
  type SizeUnit,
} from '@/modules/futures/size-unit'

// BTC perpetual as served by the live futures public_info: 1 张 = 0.0001 BTC, symbolPricePrecision 2,
// marginCoinPrecision 6 (the server validates value volumes against the PRICE precision).
const contract: FuturesValidationContext['contract'] = {
  pricePrecision: 2,
  marginCoinPrecision: 6,
  minLever: 1,
  maxLever: 100,
  minOrderVolume: '1',
  maxLimitVolume: '1000',
  maxMarketVolume: '500',
  maxMarketMoney: '99999999',
  minOrderMoney: '5',
  multiplier: '0.0001',
}
const market: SizeMarket = { multiplier: '0.0001', price: '100000', coinDp: 2 }

function draft(patch: Partial<FuturesDraft> = {}): FuturesDraft {
  return { mode: 'limit', open: 'OPEN', side: 'BUY', price: '100000', triggerPrice: '', triggerAtMarket: false, volume: '', leverage: 20, tpTrigger: '', slTrigger: '', ...patch }
}

function sized(
  unit: SizeUnit,
  patch: Partial<FuturesDraft>,
  options: { canClose?: string; referencePrice?: string; presetWire?: string; contract?: FuturesValidationContext['contract'] } = {},
) {
  const labels: Record<SizeUnit, string> = { quote: 'USDT', base: 'BTC', cont: '张' }
  return validateSizedOrder({
    draft: draft(patch),
    context: { contract: options.contract ?? contract, canClose: options.canClose ?? '', referencePrice: options.referencePrice ?? '100000' },
    unit,
    presetWire: options.presetWire,
    unitLabel: labels[unit],
    coin: 'USDT',
    contractsLabel: '张',
  })
}

function volumeError(result: ReturnType<typeof sized>) {
  return result.errors.find((entry) => entry.field === 'volume')
}

describe('size unit preference', () => {
  afterEach(() => localStorage.clear())

  it('defaults to USDT and remembers the choice', () => {
    localStorage.removeItem(SIZE_UNIT_KEY)
    expect(readSizeUnit()).toBe('quote')
    expect(DEFAULT_SIZE_UNIT).toBe('quote')
    saveSizeUnit('base')
    expect(localStorage.getItem(SIZE_UNIT_KEY)).toBe('base')
    expect(readSizeUnit()).toBe('base')
  })

  it('migrates the retired 张 choice to the base coin (张 is no longer offered)', () => {
    localStorage.setItem(SIZE_UNIT_KEY, 'cont')
    expect(readSizeUnit()).toBe('base')
    expect(SIZE_UNITS).toEqual(['base', 'quote'])
  })

  it('ignores junk values', () => {
    localStorage.setItem(SIZE_UNIT_KEY, 'lots')
    expect(readSizeUnit()).toBe('quote')
  })
})

describe('size unit conversions', () => {
  it('derives input precision per unit', () => {
    expect(baseDp('0.0001')).toBe(4)
    expect(baseDp('1')).toBe(0)
    expect(unitDp('quote', market)).toBe(2)
    expect(unitDp('base', market)).toBe(4)
    expect(unitDp('cont', market)).toBe(0)
    expect(needsReferencePrice('quote', false)).toBe(true)
    expect(needsReferencePrice('base', false)).toBe(false)
    expect(needsReferencePrice('quote', true)).toBe(false)
    expect(needsReferencePrice('base', true)).toBe(true)
  })

  it('floors USDT and BTC to whole contracts, never rounding up', () => {
    // 1 张 = 0.0001 BTC = 10 USDT at 100000.
    expect(unitToContracts('10', 'quote', market)).toBe('1')
    expect(unitToContracts('19.9999', 'quote', market)).toBe('1')
    expect(unitToContracts('9.9999', 'quote', market)).toBe('0')
    expect(unitToContracts('0.0015', 'base', market)).toBe('15')
    expect(unitToContracts('0.00019', 'base', market)).toBe('1')
    expect(unitToContracts('7', 'cont', market)).toBe('7')
    expect(unitToContracts('10', 'quote', { ...market, price: '' })).toBe('')
    expect(unitToContracts('10', 'quote', { ...market, multiplier: '0' })).toBe('')
  })

  it('converts to a market-open value floored to the coin precision', () => {
    expect(unitToValue('12.345678', 'quote', market)).toBe('12.34')
    expect(unitToValue('0.0001', 'base', market)).toBe('10.00')
    expect(unitToValue('0.0001', 'base', { ...market, price: '65432.12345' })).toBe('6.54')
    expect(unitToValue('3', 'cont', market)).toBe('30.00')
    expect(unitToValue('0.0001', 'base', { ...market, price: '' })).toBe('')
  })

  it('expresses contracts and values in the chosen unit', () => {
    expect(contractsToUnit('15', 'base', market)).toBe('0.0015')
    expect(contractsToUnit('15', 'quote', market)).toBe('150')
    expect(contractsToUnit('15', 'cont', market)).toBe('15')
    expect(contractsToUnit('1', 'quote', { ...market, price: '65432.12345' }, 'down')).toBe('6.54')
    expect(contractsToUnit('1', 'quote', { ...market, price: '65432.12345' }, 'up')).toBe('6.55')
    expect(valueToUnit('25', 'base', market)).toBe('0.0002')
    expect(valueToUnit('25', 'base', market, 'up')).toBe('0.0003')
    expect(valueToUnit('25', 'cont', market)).toBe('2')
    expect(valueToUnit('25.123456', 'quote', market)).toBe('25.12')
  })
})

describe('validateSizedOrder', () => {
  it('sends contracts for a limit order typed in USDT', () => {
    const result = sized('quote', { volume: '15' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('1')
    expect(result.contracts).toBe('1')
    expect(result.value).toBe('10')
  })

  it('uses the limit price, not the last price, as reference', () => {
    // 10 USDT at a 50000 limit price = 2 张 (0.0002 BTC).
    const result = sized('quote', { price: '50000', volume: '10' }, { referencePrice: '50000' })
    expect(result.volume).toBe('2')
  })

  it('sends contracts for a limit order typed in BTC', () => {
    const result = sized('base', { volume: '0.0015' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('15')
  })

  it('blocks a size that floors to zero with the minimum in the chosen unit', () => {
    const usdt = sized('quote', { volume: '9.99' })
    expect(usdt.ok).toBe(false)
    expect(usdt.volume).toBe('')
    expect(volumeError(usdt)).toEqual({ field: 'volume', key: 'belowMinUnit', params: { amount: '10', unit: 'USDT', ref: '1 张' } })
    expect(volumeError(sized('base', { volume: '0.00001' }))?.key).toBe('precision')
  })

  it('restates the contract minimum in BTC', () => {
    const strict = { ...contract, minOrderVolume: '5' }
    const result = validateSizedOrder({
      draft: draft({ volume: '0.0003' }),
      context: { contract: strict, canClose: '', referencePrice: '100000' },
      unit: 'base',
      unitLabel: 'BTC',
      coin: 'USDT',
      contractsLabel: '张',
    })
    expect(result.errors).toContainEqual({ field: 'volume', key: 'belowMinUnit', params: { amount: '0.0005', unit: 'BTC', ref: '5 张' } })
  })

  it('restates the max limit volume in the chosen unit', () => {
    // 1000 张 max = 0.1 BTC = 10000 USDT.
    expect(volumeError(sized('base', { volume: '0.1001' }))).toEqual({ field: 'volume', key: 'aboveMaxUnit', params: { amount: '0.1', unit: 'BTC', ref: '1000 张' } })
    expect(volumeError(sized('quote', { volume: '10010' }))?.params).toEqual({ amount: '10000', unit: 'USDT', ref: '1000 张' })
    expect(sized('base', { volume: '0.1' }).ok).toBe(true)
  })

  it('rejects a close above the closable size, in the chosen unit', () => {
    const over = sized('base', { open: 'CLOSE', volume: '0.0006' }, { canClose: '5' })
    expect(volumeError(over)).toEqual({ field: 'volume', key: 'aboveCanCloseUnit', params: { amount: '0.0005', unit: 'BTC', ref: '5 张' } })
    const ok = sized('quote', { open: 'CLOSE', volume: '50' }, { canClose: '5' })
    expect(ok.ok).toBe(true)
    expect(ok.volume).toBe('5')
  })

  it('checks precision in the chosen unit', () => {
    expect(volumeError(sized('quote', { volume: '10.001' }))).toEqual({ field: 'volume', key: 'precision', params: { dp: 2 } })
    expect(volumeError(sized('cont', { volume: '1.5' }))?.key).toBe('wholeContracts')
    expect(volumeError(sized('base', { volume: '' }))?.key).toBe('required')
    expect(volumeError(sized('base', { volume: 'abc' }))?.key).toBe('invalidNumber')
    expect(volumeError(sized('base', { volume: '0' }))?.key).toBe('mustBePositive')
  })

  it('keeps contracts input and its messages as before', () => {
    const result = sized('cont', { volume: '1001' })
    expect(volumeError(result)).toEqual({ field: 'volume', key: 'aboveMaxVolume', params: { max: '1000' } })
    expect(sized('cont', { volume: '12' }).volume).toBe('12')
  })

  it('sends a market open in USDT as the value unchanged', () => {
    const result = sized('quote', { mode: 'market', price: '', volume: '25.5' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('25.5')
    expect(result.contracts).toBe('2')
  })

  it('converts a market open in BTC to value at the reference price', () => {
    const result = sized('base', { mode: 'market', price: '', volume: '0.0003' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('30')
    expect(result.value).toBe('30')
  })

  it('QA-038: a market open in the base coin reports the exact contracts the server fills', () => {
    // XAUT: 1 张 = 0.001 XAUT, reference 4020.97. Value wire floors to 8.04 / 4.02 USDT; the contracts must not be
    // estimated back from it (1.9995 → 1, 0.9997 → 0).
    const xaut = { ...contract, multiplier: '0.001', minOrderMoney: '0' }
    const two = sized('base', { mode: 'market', price: '', volume: '0.002' }, { referencePrice: '4020.97', contract: xaut })
    expect(two.volume).toBe('8.04')
    expect(two.contracts).toBe('2')
    const one = sized('base', { mode: 'market', price: '', volume: '0.001' }, { referencePrice: '4020.97', contract: xaut })
    expect(one.volume).toBe('4.02')
    expect(one.contracts).toBe('1')
    expect(sized('base', { mode: 'market', price: '', volume: '0.003' }, { referencePrice: '4020.97', contract: xaut }).contracts).toBe('3')
  })

  it('converts a market open in contracts to value', () => {
    expect(sized('cont', { mode: 'market', price: '', volume: '2' }).volume).toBe('20')
  })

  it('needs a price to convert a market open in BTC', () => {
    expect(volumeError(sized('base', { mode: 'market', price: '', volume: '0.0003' }, { referencePrice: '' }))?.key).toBe('needPrice')
  })

  it('restates the market min value in BTC', () => {
    // minOrderMoney 5 USDT -> 0.0001 BTC rounded up; 0.0001 BTC = 10 USDT passes, so use a low price.
    const low = sized('base', { mode: 'market', price: '', volume: '0.0001' }, { referencePrice: '40000' })
    expect(low.volume).toBe('4')
    expect(volumeError(low)).toEqual({ field: 'volume', key: 'belowMinUnit', params: { amount: '0.0002', unit: 'BTC', ref: '5 USDT' } })
  })

  it('treats a trigger-at-market open like a market open', () => {
    const result = sized('base', { mode: 'trigger', price: '', triggerPrice: '90000', triggerAtMarket: true, volume: '0.001' }, { referencePrice: '90000' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('90')
  })

  it('sends contracts for a market close typed in USDT', () => {
    const result = sized('quote', { mode: 'market', open: 'CLOSE', price: '', volume: '35' }, { canClose: '10' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('3')
  })

  it('uses the slider size as the wire volume', () => {
    const result = sized('quote', { volume: '' }, { presetWire: '7' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('7')
    expect(volumeError(sized('base', { volume: '' }, { presetWire: '0' }))?.key).toBe('mustBePositive')
  })
})

describe('wire precision regressions (「数量精度错误」, server checks volume against pricePrecision)', () => {
  it('floors the market-open value to the price precision, not the 6-dp margin coin precision', () => {
    expect(valueWireDp({ pricePrecision: 2, marginCoinPrecision: 6 })).toBe(2)
    expect(valueWireDp({ pricePrecision: 4, marginCoinPrecision: 2 })).toBe(2)
    // Slider 100% of the max open value the owner hit.
    expect(percentOf('159625.746447', 100, valueWireDp(contract))).toBe('159625.74')
    expect(maxOpenValue({ available: '7981.28732235', leverage: 20, marginRate: '1', dp: valueWireDp(contract) })).toBe('159625.74')
  })

  it('converts BTC to a 2-dp market-open value', () => {
    const result = sized('base', { mode: 'market', price: '', volume: '1.8999' }, { referencePrice: '84017.33' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('159624.52')
    expect(sized('cont', { mode: 'market', price: '', volume: '3' }, { referencePrice: '84017.33' }).volume).toBe('25.2')
  })

  it('rejects a wire value with too many decimals even when it comes from the slider', () => {
    const result = sized('quote', { mode: 'market', price: '', volume: '' }, { presetWire: '159625.746447' })
    expect(volumeError(result)).toEqual({ field: 'volume', key: 'precision', params: { dp: 2 } })
    expect(sized('quote', { mode: 'market', price: '', volume: '' }, { presetWire: '159625.74' }).ok).toBe(true)
  })

  it('converts BTC to whole contracts with exact decimal maths', () => {
    expect(sized('base', { volume: '0.3' }).volume).toBe('3000')
    expect(unitToContracts('0.3', 'base', market)).toBe('3000')
    expect(unitToContracts('0.0003', 'base', market)).toBe('3')
    expect(unitToContracts('1.2345', 'base', market)).toBe('12345')
    // 0.1 + 0.2 as a JS float is not a 4-dp BTC amount.
    expect(volumeError(sized('base', { volume: String(0.1 + 0.2) }))?.key).toBe('precision')
    expect(volumeError(sized('base', { volume: '1.23456' }))).toEqual({ field: 'volume', key: 'precision', params: { dp: 4 } })
    expect(sized('base', { volume: '1.2345', price: '100000' }).volume).toBe('12345')
  })

  it('slider sizes in BTC mode are whole contracts shown as exact BTC', () => {
    const max = maxOpenContracts({ available: '1000', leverage: 20, price: '84017.33', multiplier: '0.0001', marginRate: '1' })
    expect(max).toBe('2380')
    for (const pct of [1, 25, 33, 50, 100]) {
      const wire = percentOf(max, pct, 0)
      expect(wire).toMatch(/^\d+$/)
      expect(contractsToUnit(wire, 'base', market)).toBe(new Decimal(wire).times('0.0001').toFixed())
      expect(sized('base', { volume: '' }, { presetWire: wire, referencePrice: '84017.33' }).volume).toBe(wire)
    }
  })

  it('always sends integer contracts for limit, trigger and close orders', () => {
    const cases: Array<[SizeUnit, Partial<FuturesDraft>]> = [
      ['quote', { volume: '123.45' }],
      ['base', { volume: '0.0123' }],
      ['quote', { mode: 'trigger', triggerPrice: '90000', price: '90000', volume: '99.99' }],
      ['base', { open: 'CLOSE', mode: 'market', price: '', volume: '0.0007' }],
    ]
    for (const [unit, patch] of cases) expect(sized(unit, patch, { canClose: '100' }).volume).toMatch(/^\d+$/)
  })
})

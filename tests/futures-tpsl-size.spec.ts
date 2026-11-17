import { describe, expect, it } from 'vitest'
import { tpslBody } from '@/modules/futures/api'
import { contractsToPercent, percentToContracts, tpslLegs, tpslSizeCheck, tpslTriggerCheck } from '@/modules/futures/tpsl-size'

describe('percentToContracts / contractsToPercent', () => {
  it('floors to whole contracts and returns canClose exactly at 100%', () => {
    expect(percentToContracts('33', 25)).toBe('8')
    expect(percentToContracts('33', 50)).toBe('16')
    expect(percentToContracts('33', 100)).toBe('33')
    expect(percentToContracts('33', 0)).toBe('0')
    expect(percentToContracts('33', -5)).toBe('0')
    expect(percentToContracts('33', 150)).toBe('33')
    expect(percentToContracts('', 50)).toBe('0')
    expect(percentToContracts('abc', 50)).toBe('0')
  })

  it('contractsToPercent floors and only reaches 100 at/above canClose', () => {
    expect(contractsToPercent('8', '33')).toBe(24)
    expect(contractsToPercent('33', '33')).toBe(100)
    expect(contractsToPercent('40', '33')).toBe(100)
    expect(contractsToPercent('0', '33')).toBe(0)
    expect(contractsToPercent('abc', '33')).toBe(0)
    expect(contractsToPercent('10', '')).toBe(0)
  })
})

describe('tpslSizeCheck', () => {
  const labels = { unit: 'USDT', contracts: '张' }

  it('converts a base amount to contracts', () => {
    const result = tpslSizeCheck({ raw: '0.0015', unit: 'base', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels: { unit: 'BTC', contracts: '张' } })
    expect(result.contracts).toBe('15')
    expect(result.error).toBeNull()
  })

  it('converts a quote amount to contracts (100 USDT at 50000 -> 20)', () => {
    const result = tpslSizeCheck({ raw: '100', unit: 'quote', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels })
    expect(result.contracts).toBe('20')
    expect(result.error).toBeNull()
  })

  it('reports aboveCanCloseUnit when exceeding canClose', () => {
    const result = tpslSizeCheck({ raw: '0.005', unit: 'base', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels: { unit: 'BTC', contracts: '张' } })
    expect(result.contracts).toBe('50')
    expect(result.error?.key).toBe('aboveCanCloseUnit')
  })

  it('0% (preset 0 contracts) reports belowMinUnit', () => {
    const result = tpslSizeCheck({ raw: '', unit: 'base', presetContracts: '0', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels: { unit: 'BTC', contracts: '张' } })
    expect(result.contracts).toBe('0')
    expect(result.error?.key).toBe('belowMinUnit')
  })

  it('preset bypasses parsing but still checks limits', () => {
    const ok = tpslSizeCheck({ raw: '', unit: 'quote', presetContracts: '40', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels })
    expect(ok.contracts).toBe('40')
    expect(ok.error).toBeNull()

    const over = tpslSizeCheck({ raw: '', unit: 'quote', presetContracts: '50', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels })
    expect(over.error?.key).toBe('aboveCanCloseUnit')

    const zero = tpslSizeCheck({ raw: '', unit: 'quote', presetContracts: '0', multiplier: '0.0001', price: '50000', coinDp: 2, canClose: '40', minContracts: '1', labels })
    expect(zero.contracts).toBe('0')
    expect(zero.error?.key).toBe('belowMinUnit')
  })
})

describe('tpslTriggerCheck', () => {
  it('omits empty legs and rejects invalid numbers', () => {
    expect(tpslTriggerCheck({ raw: '', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 })).toEqual({ price: '', error: null })
    expect(tpslTriggerCheck({ raw: 'abc', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('invalidNumber')
    expect(tpslTriggerCheck({ raw: '0', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('mustBePositive')
    expect(tpslTriggerCheck({ raw: '50000.123', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('precision')
  })

  it('validates long TP/SL against the last price', () => {
    expect(tpslTriggerCheck({ raw: '52000', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '49000', kind: 'tp', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('tpAboveLast')
    expect(tpslTriggerCheck({ raw: '49000', kind: 'sl', long: true, last: '50000', liq: '40000', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '51000', kind: 'sl', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('slBelowLast')
  })

  it('validates short TP/SL against the last price (mirrored)', () => {
    expect(tpslTriggerCheck({ raw: '49000', kind: 'tp', long: false, last: '50000', liq: '', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '52000', kind: 'tp', long: false, last: '50000', liq: '', dp: 2 }).error?.key).toBe('tpBelowLast')
    expect(tpslTriggerCheck({ raw: '51000', kind: 'sl', long: false, last: '50000', liq: '', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '49000', kind: 'sl', long: false, last: '50000', liq: '', dp: 2 }).error?.key).toBe('slAboveLast')
  })

  it('validates SL against the liquidation price', () => {
    expect(tpslTriggerCheck({ raw: '41000', kind: 'sl', long: true, last: '50000', liq: '40000', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '39000', kind: 'sl', long: true, last: '50000', liq: '40000', dp: 2 }).error?.key).toBe('slAboveLiq')
    expect(tpslTriggerCheck({ raw: '39000', kind: 'sl', long: false, last: '', liq: '40000', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '41000', kind: 'sl', long: false, last: '', liq: '40000', dp: 2 }).error?.key).toBe('slBelowLiq')
  })

  it('QA147 formats reference prices for display while retaining exact trigger comparisons', () => {
    const common = { last: '80700.40690860001', liq: '', dp: 2 }
    expect(tpslTriggerCheck({ ...common, raw: '80700.40', kind: 'tp', long: true }).error?.params?.last).toBe('80,700.40')
    expect(tpslTriggerCheck({ ...common, raw: '80700.41', kind: 'sl', long: true }).error?.params?.last).toBe('80,700.40')
    expect(tpslTriggerCheck({ ...common, raw: '80700.41', kind: 'tp', long: true }).error).toBeNull()
    expect(tpslTriggerCheck({ ...common, raw: '80700.40', kind: 'sl', long: true }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '0.00000001', last: '0.00000001000000001', kind: 'tp', long: true, liq: '', dp: 8 }).error?.params?.last).toBe('0.00000001')
    expect(tpslTriggerCheck({ raw: '999999999999999999.12', last: '999999999999999999.12345678', kind: 'tp', long: true, liq: '', dp: 2 }).error?.params?.last).toBe('999,999,999,999,999,999.12')
  })

  it('skips direction checks when last / liq are unknown', () => {
    expect(tpslTriggerCheck({ raw: '52000', kind: 'tp', long: true, last: '', liq: '40000', dp: 2 }).error).toBeNull()
    expect(tpslTriggerCheck({ raw: '39000', kind: 'sl', long: true, last: '50000', liq: '', dp: 2 }).error).toBeNull()
  })
})

describe('tpslLegs / tpslBody', () => {
  it('builds market legs (TP first) and the wire object for a long close', () => {
    const legs = tpslLegs({ tp: '52000', sl: '39000', contracts: '40' })
    expect(legs).toEqual([
      { triggerType: 2, triggerPrice: '52000', price: '0', type: 2, volume: '40' },
      { triggerType: 1, triggerPrice: '39000', price: '0', type: 2, volume: '40' },
    ])

    const body = tpslBody({ contractId: 1, positionId: 7, positionType: 1, leverageLevel: 10, closeSide: 'SELL', legs })
    expect(body).toEqual({
      contractId: 1,
      positionId: 7,
      positionType: 1,
      leverageLevel: 10,
      side: 'SELL',
      orderList: [
        { triggerType: 2, triggerPrice: '52000', price: '0', type: 2, volume: '40' },
        { triggerType: 1, triggerPrice: '39000', price: '0', type: 2, volume: '40' },
      ],
    })
  })

  it('omits legs whose price is empty', () => {
    expect(tpslLegs({ tp: '52000', sl: '', contracts: '40' })).toEqual([{ triggerType: 2, triggerPrice: '52000', price: '0', type: 2, volume: '40' }])
    expect(tpslLegs({ tp: '', sl: '39000', contracts: '40' })[0].triggerType).toBe(1)
    expect(tpslLegs({ tp: '', sl: '', contracts: '40' })).toEqual([])
  })
})

describe('liquidation price in the message', () => {
  it('is rounded to the tick, towards the allowed side', () => {
    const long = tpslTriggerCheck({ raw: '40000', kind: 'sl', long: true, last: '50000', liq: '40000.123456', dp: 2 })
    expect(long.error).toMatchObject({ key: 'slAboveLiq', ns: 'tpq', params: { liq: '40000.13' } })
    const short = tpslTriggerCheck({ raw: '60000', kind: 'sl', long: false, last: '50000', liq: '59999.987654', dp: 2 })
    expect(short.error).toMatchObject({ key: 'slBelowLiq', ns: 'tpq', params: { liq: '59999.98' } })
  })
})

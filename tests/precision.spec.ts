import { describe, expect, it } from 'vitest'
import { buildSymbolRules, depthLevelFromStep, validateOrderDraft, type SymbolRules } from '@/modules/finance/precision'

const rules: SymbolRules = {
  pricePrecision: 2,
  volumePrecision: 8,
  limitPriceMin: '0.01',
  limitVolumeMin: '0.00001',
  marketBuyMin: '10',
  marketSellMin: '0.0001',
  depthSteps: ['0.00000001', '0.000001', '0.0001'],
}

const balances = { baseAvailable: '1.5', quoteAvailable: '1000' }

function keys(input: Parameters<typeof validateOrderDraft>[0], extra: Partial<typeof balances> = {}): string[] {
  return validateOrderDraft(input, { rules, ...balances, ...extra }).errors.map((error) => error.key)
}

describe('order draft validation', () => {
  it('accepts a limit order exactly at the configured precision', () => {
    const result = validateOrderDraft(
      { side: 'BUY', type: '1', price: '65000.01', volume: '0.01000000' },
      { rules, ...balances },
    )
    expect(result.ok).toBe(true)
    expect(result.price).toBe('65000.01')
    expect(result.volume).toBe('0.01')
    expect(result.total).toBe('650.0001')
  })

  it('rejects one digit beyond the price precision', () => {
    expect(keys({ side: 'BUY', type: '1', price: '65000.011', volume: '0.01' })).toContain('error.precision')
  })

  it('rejects one digit beyond the amount precision for a limit sell', () => {
    expect(keys({ side: 'SELL', type: '1', price: '65000', volume: '0.000000001' })).toContain('error.precision')
  })

  it('enforces minimum price and amount', () => {
    expect(keys({ side: 'BUY', type: '1', price: '0.001', volume: '0.01' })).toContain('error.belowPriceMin')
    expect(keys({ side: 'BUY', type: '1', price: '10', volume: '0.000001' })).toContain('error.belowVolumeMin')
  })

  it('rejects a limit buy whose total exceeds the available quote balance', () => {
    const errors = keys({ side: 'BUY', type: '1', price: '1000', volume: '1.5' })
    expect(errors).toContain('error.insufficientQuote')
  })

  it('rejects a limit sell that exceeds the available base balance', () => {
    expect(keys({ side: 'SELL', type: '1', price: '100', volume: '2' })).toContain('error.insufficientBase')
  })

  it('treats a market buy amount as a quote (USDT) amount with quote precision', () => {
    const accepted = validateOrderDraft({ side: 'BUY', type: '2', price: '', volume: '25.50' }, { rules, ...balances })
    expect(accepted.ok).toBe(true)
    expect(accepted.total).toBe('25.5')
    expect(keys({ side: 'BUY', type: '2', price: '', volume: '25.505' })).toContain('error.precision')
    expect(keys({ side: 'BUY', type: '2', price: '', volume: '9' })).toContain('error.belowVolumeMin')
  })

  it('keeps market sell amounts in the base coin', () => {
    expect(validateOrderDraft({ side: 'SELL', type: '2', price: '', volume: '0.5' }, { rules, ...balances }).ok).toBe(true)
    expect(keys({ side: 'SELL', type: '2', price: '', volume: '0.00001' })).toContain('error.belowVolumeMin')
    expect(keys({ side: 'SELL', type: '2', price: '', volume: '2' })).toContain('error.insufficientBase')
  })

  it('requires both fields for a limit order and rejects junk input', () => {
    expect(keys({ side: 'BUY', type: '1', price: '', volume: '' })).toEqual(
      expect.arrayContaining(['error.required']),
    )
    expect(keys({ side: 'BUY', type: '1', price: '65000.00', volume: '1e-8' })).toContain('error.invalidDecimal')
    expect(keys({ side: 'BUY', type: '1', price: '0', volume: '0' })).toEqual(
      expect.arrayContaining(['error.mustBePositive']),
    )
  })

  it('names the minimum for a zero amount (10-24) and falls back to "above 0" without one', () => {
    const volumeError = (input: Parameters<typeof validateOrderDraft>[0], ruleSet: SymbolRules = rules) =>
      validateOrderDraft(input, { rules: ruleSet, ...balances }).errors.find((error) => error.field === 'volume')
    expect(volumeError({ side: 'SELL', type: '1', price: '100', volume: '0.0' })).toEqual({ field: 'volume', key: 'error.belowVolumeMin', params: { min: '0.00001' } })
    expect(volumeError({ side: 'SELL', type: '2', price: '', volume: '0' })?.params).toEqual({ min: '0.0001' })
    expect(volumeError({ side: 'BUY', type: '2', price: '', volume: '0' })?.params).toEqual({ min: '10' })
    expect(volumeError({ side: 'BUY', type: '1', price: '100', volume: '0' }, { ...rules, limitVolumeMin: '0' })?.key).toBe('error.mustBePositive')
  })

  it('skips balance checks when balances are not loaded', () => {
    const result = validateOrderDraft(
      { side: 'BUY', type: '1', price: '65000', volume: '1' },
      { rules, baseAvailable: '', quoteAvailable: '' },
    )
    expect(result.ok).toBe(true)
  })
})

describe('rules from public info', () => {
  it('reads precision, minimums and depth steps', () => {
    const built = buildSymbolRules({
      symbol: 'btcusdt',
      price: 2,
      volume: 8,
      name: 'BTC/USDT',
      depth: '0.00000001,0.000001,0.0001',
      limitPriceMin: 0.01,
      limitVolumeMin: 0.00001,
      marketBuyMin: 10,
      marketSellMin: 0.0001,
    })
    expect(built.pricePrecision).toBe(2)
    expect(built.volumePrecision).toBe(8)
    expect(built.limitPriceMin).toBe('0.01')
    expect(built.marketBuyMin).toBe('10')
    expect(built.depthSteps).toEqual(['0.00000001', '0.000001', '0.0001'])
  })

  it('maps a depth step to the WebSocket depth level', () => {
    expect(depthLevelFromStep('0.00000001')).toBe(8)
    expect(depthLevelFromStep('0.0001')).toBe(4)
    expect(depthLevelFromStep('1')).toBe(0)
  })

  it('falls back to safe defaults when public info lacks a pair', () => {
    const built = buildSymbolRules(null)
    expect(built.pricePrecision).toBe(2)
    expect(built.volumePrecision).toBe(8)
    expect(built.depthSteps).toEqual([])
  })
})

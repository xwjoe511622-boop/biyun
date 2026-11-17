import { describe, expect, it } from 'vitest'
import { fullPositionReplacements, nearestTpsl } from '@/modules/futures/tpsl-summary'
import type { TpslRow } from '@/modules/futures/types'

const row = (triggerPrice: string): TpslRow => ({ id: triggerPrice, triggerPrice, price: '0', volume: '1', status: 0 })

describe('nearestTpsl', () => {
  it('long: lowest TP, highest SL', () => {
    expect(nearestTpsl({ takeProfit: [row('90000'), row('88000')], stopLoss: [row('80000'), row('81000')] }, 'BUY')).toEqual({ tp: '88000', sl: '81000' })
  })
  it('short: highest TP, lowest SL', () => {
    expect(nearestTpsl({ takeProfit: [row('75221'), row('76000')], stopLoss: [row('86086.3'), row('87000')] }, 'SELL')).toEqual({ tp: '76000', sl: '86086.3' })
  })
  it('empty when no orders', () => {
    expect(nearestTpsl({ takeProfit: [], stopLoss: [row('')] }, 'BUY')).toEqual({ tp: '', sl: '' })
  })
})

describe('fullPositionReplacements (Binance: one entire-position TP and SL)', () => {
  const rows = (triggerPrice: string, volume: string): TpslRow => ({ id: `${triggerPrice}-${volume}`, triggerPrice, price: '0', volume, status: 0 })
  const existing = { takeProfit: [rows('75000', '38'), rows('76000', '10')], stopLoss: [rows('86000', '38')] }
  it('a new whole-position SL replaces the whole-position SL only', () => {
    expect(fullPositionReplacements(existing, { tp: false, sl: true, contracts: '38' }, '38')).toEqual({ takeProfit: [], stopLoss: [existing.stopLoss[0]] })
  })
  it('a new whole-position TP replaces the whole-position TP but keeps the partial one', () => {
    expect(fullPositionReplacements(existing, { tp: true, sl: false, contracts: '38' }, '38').takeProfit).toEqual([existing.takeProfit[0]])
  })
  it('a partial TP/SL replaces nothing (partial legs stack, as on Binance)', () => {
    expect(fullPositionReplacements(existing, { tp: true, sl: true, contracts: '10' }, '38')).toEqual({ takeProfit: [], stopLoss: [] })
  })
  it('nothing loaded, nothing replaced', () => {
    expect(fullPositionReplacements(null, { tp: true, sl: true, contracts: '38' }, '38')).toEqual({ takeProfit: [], stopLoss: [] })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { holdingsOf, isHedgeConflict, oneWayMaxContracts, oneWayPlan, readPositionMode, savePositionMode, usePositionMode, type SideHolding } from '@/modules/futures/position-mode'

const h = (volume: string, canClose = volume): SideHolding => ({ volume, canClose })

describe('One-way → backend orders (position state × action)', () => {
  const cases: [string, Parameters<typeof oneWayPlan>[0], ReturnType<typeof oneWayPlan>][] = [
    ['flat, buy 10 → OPEN long', { side: 'BUY', reduceOnly: false, contracts: '10', long: null, short: null }, { ok: true, legs: [{ open: 'OPEN', side: 'BUY', contracts: '10' }] }],
    ['flat, sell 10 → OPEN short', { side: 'SELL', reduceOnly: false, contracts: '10', long: null, short: null }, { ok: true, legs: [{ open: 'OPEN', side: 'SELL', contracts: '10' }] }],
    ['long 20, buy 5 → OPEN more long', { side: 'BUY', reduceOnly: false, contracts: '5', long: h('20'), short: null }, { ok: true, legs: [{ open: 'OPEN', side: 'BUY', contracts: '5' }] }],
    ['long 20, sell 5 → CLOSE long 5', { side: 'SELL', reduceOnly: false, contracts: '5', long: h('20'), short: null }, { ok: true, legs: [{ open: 'CLOSE', side: 'SELL', contracts: '5' }] }],
    ['long 20, sell 20 → CLOSE long 20', { side: 'SELL', reduceOnly: false, contracts: '20', long: h('20'), short: null }, { ok: true, legs: [{ open: 'CLOSE', side: 'SELL', contracts: '20' }] }],
    ['long 20, sell 35 → CLOSE 20 then OPEN short 15', { side: 'SELL', reduceOnly: false, contracts: '35', long: h('20'), short: null }, { ok: true, legs: [{ open: 'CLOSE', side: 'SELL', contracts: '20' }, { open: 'OPEN', side: 'SELL', contracts: '15' }] }],
    ['short 40, buy 50 → CLOSE 40 then OPEN long 10', { side: 'BUY', reduceOnly: false, contracts: '50', long: null, short: h('40') }, { ok: true, legs: [{ open: 'CLOSE', side: 'BUY', contracts: '40' }, { open: 'OPEN', side: 'BUY', contracts: '10' }] }],
    ['short 40 (25 closable), buy 10 → CLOSE 10', { side: 'BUY', reduceOnly: false, contracts: '10', long: null, short: h('40', '25') }, { ok: true, legs: [{ open: 'CLOSE', side: 'BUY', contracts: '10' }] }],
    ['short 40 (25 closable), buy 30 → refused (close orders hold 15)', { side: 'BUY', reduceOnly: false, contracts: '30', long: null, short: h('40', '25') }, { ok: false, key: 'heldByCloseOrders', params: { held: '15' } }],
    ['reduce-only, long 20, sell 35 → CLOSE capped at 20', { side: 'SELL', reduceOnly: true, contracts: '35', long: h('20'), short: null }, { ok: true, legs: [{ open: 'CLOSE', side: 'SELL', contracts: '20' }] }],
    ['reduce-only, long 20, buy → refused (same side)', { side: 'BUY', reduceOnly: true, contracts: '5', long: h('20'), short: null }, { ok: false, key: 'reduceOnlySameSide' }],
    ['reduce-only, flat → refused', { side: 'SELL', reduceOnly: true, contracts: '5', long: null, short: null }, { ok: false, key: 'noPositionToReduce' }],
    ['reduce-only, all held by close orders → refused', { side: 'SELL', reduceOnly: true, contracts: '5', long: h('20', '0'), short: null }, { ok: false, key: 'heldByCloseOrders', params: { held: '20' } }],
    ['long AND short (legacy) → refused', { side: 'BUY', reduceOnly: false, contracts: '5', long: h('10'), short: h('7') }, { ok: false, key: 'hedgeConflict' }],
    ['zero-size holdings count as flat', { side: 'BUY', reduceOnly: false, contracts: '5', long: h('0'), short: h('0') }, { ok: true, legs: [{ open: 'OPEN', side: 'BUY', contracts: '5' }] }],
    ['fractional size → refused', { side: 'BUY', reduceOnly: false, contracts: '1.5', long: null, short: null }, { ok: false, key: 'invalidSize' }],
    ['zero size → refused', { side: 'BUY', reduceOnly: false, contracts: '0', long: null, short: null }, { ok: false, key: 'invalidSize' }],
  ]
  it.each(cases)('%s', (_name, input, expected) => {
    expect(oneWayPlan(input)).toEqual(expected)
  })

  it('detects legacy long+short on one contract', () => {
    expect(isHedgeConflict(h('1'), h('1'))).toBe(true)
    expect(isHedgeConflict(h('1'), null)).toBe(false)
    expect(isHedgeConflict(h('0'), h('3'))).toBe(false)
  })
})

describe('One-way 最大', () => {
  it('adds the closable opposite position to the openable size', () => {
    expect(oneWayMaxContracts({ side: 'BUY', reduceOnly: false, maxOpen: '100', long: null, short: h('40') })).toBe('140')
    expect(oneWayMaxContracts({ side: 'SELL', reduceOnly: false, maxOpen: '100', long: null, short: h('40') })).toBe('100')
  })
  it('reduce-only and resting close orders cap it at the closable size', () => {
    expect(oneWayMaxContracts({ side: 'BUY', reduceOnly: true, maxOpen: '100', long: null, short: h('40') })).toBe('40')
    expect(oneWayMaxContracts({ side: 'BUY', reduceOnly: false, maxOpen: '100', long: null, short: h('40', '25') })).toBe('25')
  })
})

describe('position mode preference', () => {
  beforeEach(() => localStorage.clear())
  // 2026-09-30: Hedge stays the default for existing users (Binance defaults new accounts to One-way; see the module doc).
  it('defaults to Hedge and is stored per uid', () => {
    expect(readPositionMode(10001)).toBe('hedge')
    savePositionMode(10001, 'oneWay')
    expect(readPositionMode(10001)).toBe('oneWay')
    expect(readPositionMode(10002)).toBe('hedge')
  })
  it('usePositionMode follows saves and never stores without a uid', () => {
    let uid: number | undefined
    const { mode, setMode } = usePositionMode(() => uid)
    expect(setMode('oneWay')).toBe(false)
    expect(mode.value).toBe('hedge')
    uid = 7
    expect(setMode('oneWay')).toBe(true)
    expect(mode.value).toBe('oneWay')
    expect(localStorage.getItem('picat.futures.positionMode')).toBeNull()
  })
})

describe('holdingsOf', () => {
  const row = (orderSide: 'BUY' | 'SELL', positionType: 1 | 2, positionVolume: string, canCloseVolume = positionVolume) => ({ orderSide, positionType, positionVolume, canCloseVolume })
  it('maps long/short, preferring the ticket margin mode', () => {
    expect(holdingsOf([row('BUY', 2, '5'), row('BUY', 1, '9', '4'), row('SELL', 2, '3')], 1)).toEqual({ long: { volume: '9', canClose: '4' }, short: { volume: '3', canClose: '3' } })
    expect(holdingsOf([], 1)).toEqual({ long: null, short: null })
  })
})

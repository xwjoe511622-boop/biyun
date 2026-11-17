import { describe, expect, it } from 'vitest'
import { accountMarginRatio, breakEvenPrice, crossMaintenance, estimatedFunding, positionMarginColumns } from '@/modules/futures/position-metrics'
import { Decimal } from '@/modules/finance/decimal'

describe('损益两平价', () => {
  it('long: entry × (1 + fOpen) / (1 − fClose)', () => {
    // 83000 × 1.00075 / 0.99925 = 83124.59…
    expect(breakEvenPrice({ side: 'BUY', entry: '83000', openFee: '0.00075', closeFee: '0.00075', dp: 2 })).toBe('83124.59')
  })
  it('short: entry × (1 − fOpen) / (1 + fClose)', () => {
    expect(breakEvenPrice({ side: 'SELL', entry: '2716.77', openFee: '0.00075', closeFee: '0.00075', dp: 2 })).toBe('2712.70')
  })
  it('unknown fees or entry → empty', () => {
    expect(breakEvenPrice({ side: 'BUY', entry: '83000', openFee: '', closeFee: '0.00075', dp: 2 })).toBe('')
  })
})

describe('预估资金费用', () => {
  it('long pays a positive rate, short receives it', () => {
    // 120 × 0.0001 × 83400 × 0.0001 = 0.10008
    expect(estimatedFunding({ side: 'BUY', volume: '120', multiplier: '0.0001', mark: '83400', rate: '0.0001', dp: 4 })).toBe('-0.1001')
    expect(estimatedFunding({ side: 'SELL', volume: '120', multiplier: '0.0001', mark: '83400', rate: '0.0001', dp: 4 })).toBe('0.1001')
  })
  it('negative rate flips the sign', () => {
    expect(estimatedFunding({ side: 'BUY', volume: '40', multiplier: '0.001', mark: '2713.47', rate: '-0.0002', dp: 4 })).toBe('0.0217')
  })
})

describe('保证金比率 box', () => {
  it('uses exact server maintenance from the risk group, without a rounded keep-rate or independent public mark', () => {
    const positions = [
      { volume: '1', multiplier: '1', mark: '9007199254740993.1234567890123456', keepRate: '0.9', maintenanceMargin: '0.1' },
      { volume: '1', multiplier: '1', mark: '1', keepRate: '0.9', maintenanceMargin: '0.2' },
    ]
    expect(accountMarginRatio({ positions, balance: '1', dp: 16 })).toEqual({ maintenance: '0.3000000000000000', ratio: '0.3' })
    expect(crossMaintenance(positions.map(row => ({ notional: row.mark, keepRate: row.keepRate, maintenanceMargin: row.maintenanceMargin })))).toBe('0.3')
    expect(accountMarginRatio({ positions: [{ ...positions[0]!, maintenanceMargin: '' }], balance: '1', dp: 4 }).maintenance).toBe('')
    expect(accountMarginRatio({ positions: [{ ...positions[0]!, maintenanceMargin: '0' }], balance: '0', dp: 4 })).toEqual({ maintenance: '0.0000', ratio: '' })
    const exact = positionMarginColumns({ isolated: true, notional: '1000', leverage: 10, keepRate: '0.9', maintenanceMargin: '0.0251', holdAmount: '1', crossMaintenance: '', crossBalance: '', style: 'binance', dp: 4 })
    expect(exact.ratio).toBe('0.0251')
  })
  it('维持保证金 = Σ qty × mark × keepRate, ratio = 维持保证金 ÷ 保证金余额', () => {
    // 120 × 0.0001 × 83400 × 0.004 = 4.0032 ; 40 × 0.001 × 2713.47 × 0.004 = 0.43415520
    const result = accountMarginRatio({
      positions: [
        { volume: '120', multiplier: '0.0001', mark: '83400', keepRate: '0.004' },
        { volume: '40', multiplier: '0.001', mark: '2713.47', keepRate: '0.004' },
      ],
      balance: '1000',
      dp: 4,
    })
    expect(result.maintenance).toBe('4.4374')
    expect(result.ratio.startsWith('0.00443735')).toBe(true)
  })
  it('no positions → 0 maintenance, 0 ratio', () => {
    expect(accountMarginRatio({ positions: [], balance: '19.99', dp: 4 })).toEqual({ maintenance: '0.0000', ratio: '0' })
  })
})

describe('持仓表 保证金 / 保证金比率 (owner 10-23 screenshot)', () => {
  // Hedge-mode cross 20x: long 98,501.62 / short 187,172.68 USDT notional, equity 99,772.21, keepRate 0.004.
  const maint = crossMaintenance([{ notional: '98501.62', keepRate: '0.004' }, { notional: '187172.68', keepRate: '0.004' }])
  it('cross maintenance = Σ notional × keepRate', () => {
    expect(maint).toBe('1142.6972')
  })
  it('cross 保证金 = notional ÷ leverage (not the account balance)', () => {
    const long = positionMarginColumns({ isolated: false, notional: '98501.62', leverage: 20, keepRate: '0.004', holdAmount: '99772.21', crossMaintenance: maint, crossBalance: '99772.21', style: 'binance', dp: 2 })
    const short = positionMarginColumns({ isolated: false, notional: '187172.68', leverage: 20, keepRate: '0.004', holdAmount: '99772.21', crossMaintenance: maint, crossBalance: '99772.21', style: 'binance', dp: 2 })
    expect(long.margin).toBe('4925.08')
    expect(short.margin).toBe('9358.63')
  })
  it('Binance 保证金比率 = maintenance ÷ balance (small = safe), shared by cross rows', () => {
    const row = positionMarginColumns({ isolated: false, notional: '98501.62', leverage: 20, keepRate: '0.004', holdAmount: '', crossMaintenance: maint, crossBalance: '99772.21', style: 'binance', dp: 2 })
    expect(new Decimal(row.ratio).toFixed(6)).toBe('0.011453')
    expect(row.risk).toBe('safe')
  })
  it('OKX 保证金率 = balance ÷ maintenance (large = safe)', () => {
    const row = positionMarginColumns({ isolated: false, notional: '98501.62', leverage: 20, keepRate: '0.004', holdAmount: '', crossMaintenance: maint, crossBalance: '99772.21', style: 'okx', dp: 2 })
    expect(new Decimal(row.ratio).toFixed(4)).toBe('87.3129')
    expect(row.risk).toBe('safe')
  })
  it('isolated uses its own margin and maintenance; risk rises near liquidation', () => {
    const near = positionMarginColumns({ isolated: true, notional: '10000', leverage: 20, keepRate: '0.004', holdAmount: '45', crossMaintenance: '', crossBalance: '', style: 'binance', dp: 2 })
    expect(near.margin).toBe('45.00')
    expect(new Decimal(near.ratio).toFixed(4)).toBe('0.8888')
    expect(near.risk).toBe('danger')
  })
  it('unknown inputs → empty, never a fake number', () => {
    expect(positionMarginColumns({ isolated: false, notional: '', leverage: 20, keepRate: '0.004', holdAmount: '', crossMaintenance: '', crossBalance: '', style: 'binance', dp: 2 }).ratio).toBe('')
  })
})

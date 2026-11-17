import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isolatedLiqAfterTopUp, leverageErrorKey, planLeverageChange, tierCeiling, type LeveragePosition } from '@/modules/futures/leverage-change'
import { Decimal } from '@/modules/finance/decimal'
import type { FuturesContract } from '@/modules/futures/contracts'

const editLeverage = vi.fn<(contractId: number, level: number) => Promise<{ serverTopUp: boolean }>>()
const changePositionMargin = vi.fn<(positionId: number, amount: string) => Promise<void>>()
vi.mock('@/modules/futures/api', async (original) => ({ ...(await original<typeof import('@/modules/futures/api')>()), editLeverage, changePositionMargin }))

const { useFuturesAccountStore } = await import('@/stores/futures-account')
const { useFuturesMarketStore } = await import('@/stores/futures-market')
const { ApiError } = await import('@/core/errors')

// Numbers from the live test on 2026-09-29 (docs 调整杠杆的规则): NVDA cross 11,678 cont, BTC cross, TSLA isolated 1 cont.
function position(extra: Partial<LeveragePosition>): LeveragePosition {
  return {
    id: 1, positionType: 1, orderSide: 'BUY', positionVolume: '1', positionBalance: '0', holdAmount: '0', realizedAmount: '0',
    unRealizedAmount: '0', reducePrice: '0', keepRate: '0.02', maxFeeRate: '0.00075', leverageLevel: 5, ...extra,
  }
}
const base = { available: '170000', restingOrders: 0, multiplier: '0.01', ceiling: {}, precision: 2 }
const tslaIsolated = position({ id: 694, positionType: 2, positionBalance: '3.5816', holdAmount: '0.71643', unRealizedAmount: '-0.00008', reducePrice: '292.58' })

describe('planLeverageChange', () => {
  it('no position: only the saved leverage changes, nothing to show or refuse', () => {
    const plan = planLeverageChange({ ...base, current: 5, next: 10, positions: [] })
    expect(plan).toMatchObject({ hasPositions: false, block: null, crossMarginDelta: '0', isolatedTopUps: [] })
  })

  it('cross raise frees initial margin; liquidation price is reported unchanged', () => {
    const plan = planLeverageChange({ ...base, current: 5, next: 10, positions: [position({ positionBalance: '26890', reducePrice: '-1351' })] })
    expect(plan.direction).toBe('up')
    expect(plan.block).toBeNull()
    expect(Number(plan.crossMarginDelta)).toBeCloseTo(-2689, 6)
    expect(plan.crossLiq).toEqual([{ side: 'BUY', price: '-1351' }])
  })

  it('cross lower with enough 可用 takes the extra initial margin from 可用', () => {
    const plan = planLeverageChange({ ...base, current: 10, next: 3, positions: [position({ positionBalance: '26886', leverageLevel: 10 })] })
    expect(plan.block).toBeNull()
    expect(Number(plan.crossMarginDelta)).toBeCloseTo(26886 / 3 - 2688.6, 6)
    expect(Number(plan.availableAfter)).toBeCloseTo(170000 - (26886 / 3 - 2688.6), 6)
  })

  it('cross lower beyond 可用 is refused (the server would accept it and leave 可用 at 0) and names the lowest possible leverage', () => {
    const btc = [position({ positionBalance: '190430', leverageLevel: 3 }), position({ id: 2, orderSide: 'SELL', positionBalance: '3506', leverageLevel: 3 })]
    const plan = planLeverageChange({ ...base, available: '108004', current: 3, next: 1, positions: btc })
    expect(plan.block?.key).toBe('insufficientCross')
    expect(plan.block?.params).toMatchObject({ lever: 1, available: '108004', minLever: 2 })
    expect(Number((plan.block?.params as { need: string }).need)).toBeCloseTo(193936 - 193936 / 3, 4)
  })

  it('isolated lower adds the missing margin (rounded up) and moves the liquidation price away', () => {
    const plan = planLeverageChange({ ...base, current: 5, next: 3, positions: [tslaIsolated] })
    expect(plan.block).toBeNull()
    expect(plan.isolatedTopUps).toHaveLength(1)
    const topUp = plan.isolatedTopUps[0]!
    expect(topUp.amount).toBe('0.48') // 3.5816 / 3 - 0.71643 = 0.47744 -> 0.48
    expect(Number(topUp.liqAfter)).toBeCloseTo(292.58 - 0.48 / (0.01 * (1 - 0.02075)), 6)
    expect(Number(topUp.liqAfter)).toBeLessThan(292.58)
    expect(plan.topUpTotal).toBe('0.48')
  })

  it('isolated raise moves no margin', () => {
    const plan = planLeverageChange({ ...base, current: 5, next: 10, positions: [tslaIsolated] })
    expect(plan).toMatchObject({ direction: 'up', block: null, isolatedTopUps: [], topUpTotal: '0' })
  })

  it('isolated lower without enough 可用 is refused', () => {
    const plan = planLeverageChange({ ...base, available: '0.1', current: 5, next: 1, positions: [tslaIsolated] })
    expect(plan.block?.key).toBe('insufficientIsolated')
    expect(plan.block?.params).toMatchObject({ lever: 1, minLever: null })
  })

  it('profits do not count as isolated margin, losses do (same as canSubMarginAmount)', () => {
    const winning = position({ positionType: 2, positionBalance: '100', holdAmount: '30', unRealizedAmount: '10' })
    // stored margin 20; 1x needs 100 -> add 80, not 70
    expect(planLeverageChange({ ...base, current: 5, next: 1, positions: [winning] }).isolatedTopUps[0]?.amount).toBe('80')
  })

  it('resting orders block any change (server: 10023 with a position; deferred leverage without one)', () => {
    expect(planLeverageChange({ ...base, restingOrders: 2, current: 5, next: 10, positions: [] }).block).toEqual({ key: 'restingOrders', params: { n: 2 } })
    expect(planLeverageChange({ ...base, restingOrders: null, current: 5, next: 10, positions: [] }).block).toBeNull()
    expect(planLeverageChange({ ...base, restingOrders: 3, current: 5, next: 5, positions: [] }).block).toBeNull()
  })

  it('raising above the tier ceiling for the position value is refused', () => {
    const ceiling = { '10': '20000000', '20': '5000000', '50': '1000000', '100': '250000', '125': '50000' }
    expect(tierCeiling(ceiling, 101)).toBe('50000')
    expect(tierCeiling(ceiling, 100)).toBe('250000')
    const plan = planLeverageChange({ ...base, ceiling, current: 100, next: 125, positions: [position({ positionBalance: '190430', leverageLevel: 100 })] })
    expect(plan.block).toMatchObject({ key: 'tierLimit', params: { lever: 125, limit: '50000' } })
  })

  it('ignores closed (zero-volume) rows', () => {
    const plan = planLeverageChange({ ...base, current: 5, next: 1, positions: [position({ positionVolume: '0', positionBalance: '999999' })] })
    expect(plan.hasPositions).toBe(false)
  })
})

describe('isolatedLiqAfterTopUp', () => {
  it('short liquidation moves up by amount / (qty × (1 + keep + fee))', () => {
    const short = position({ positionType: 2, orderSide: 'SELL', reducePrice: '400', positionVolume: '2' })
    expect(Number(isolatedLiqAfterTopUp(short, new Decimal('1'), '0.01'))).toBeCloseTo(400 + 1 / (0.02 * 1.02075), 8)
  })
})

describe('leverage error codes', () => {
  it('maps the codes level_edit / order_create use', () => {
    expect(leverageErrorKey('10023')).toBe('fut.lev.err10023')
    expect(leverageErrorKey('10012')).toBe('fut.lev.err10012')
    // backend guards (levguard-20260929)
    for (const code of ['10067', '10068', '10069', '10070']) expect(leverageErrorKey(code)).toBe(`fut.lev.err${code}`)
    expect(leverageErrorKey('10001')).toBeNull()
  })
})

describe('futures-account setLeverage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    editLeverage.mockReset()
    changePositionMargin.mockReset()
    const market = useFuturesMarketStore()
    market.contracts = [{ id: 5, contractName: 'E-TSLA-USDT', marginCoin: 'USDT' } as FuturesContract]
    market.selectedName = 'E-TSLA-USDT'
  })

  it('changes the leverage first, then adds the isolated margin', async () => {
    editLeverage.mockResolvedValue({ serverTopUp: false })
    changePositionMargin.mockResolvedValue()
    expect(await useFuturesAccountStore().setLeverage(3, [{ positionId: 694, amount: '0.48' }])).toBeNull()
    expect(editLeverage).toHaveBeenCalledWith(5, 3)
    expect(changePositionMargin).toHaveBeenCalledWith(694, '0.48')
    expect(editLeverage.mock.invocationCallOrder[0]).toBeLessThan(changePositionMargin.mock.invocationCallOrder[0]!)
  })

  it('shows Chinese text for the remaining generic 10023 instead of the server text', async () => {
    editLeverage.mockRejectedValue(new ApiError({ kind: 'api', code: '10023', message: 'Switch leverage level failed' }))
    const result = await useFuturesAccountStore().setLeverage(5)
    expect(result).toContain('调整杠杆失败')
    expect(changePositionMargin).not.toHaveBeenCalled()
  })

  it('does not add the isolated margin again when the server already moved it (levguard-20260929)', async () => {
    editLeverage.mockResolvedValue({ serverTopUp: true })
    expect(await useFuturesAccountStore().setLeverage(1, [{ positionId: 695, amount: '2.87' }])).toBeNull()
    expect(editLeverage).toHaveBeenCalledWith(5, 1)
    expect(changePositionMargin).not.toHaveBeenCalled()
  })

  it.each([
    ['10067', '未成交委托'],
    ['10068', '可用保证金不足'],
    ['10069', '超出允许范围'],
    ['10070', '逐仓调低杠杆需要从可用追加保证金'],
  ])('shows the Chinese reason for guard code %s', async (code, text) => {
    editLeverage.mockRejectedValue(new ApiError({ kind: 'api', code, message: 'server text' }))
    const result = await useFuturesAccountStore().setLeverage(3)
    expect(result).toContain(text)
    expect(result).not.toContain('server text')
    expect(changePositionMargin).not.toHaveBeenCalled()
  })

  it('reports a failed top-up after the leverage was changed', async () => {
    editLeverage.mockResolvedValue({ serverTopUp: false })
    changePositionMargin.mockRejectedValue(new ApiError({ kind: 'api', code: '10001', message: '余额不足', product: 'futures' }))
    const result = await useFuturesAccountStore().setLeverage(3, [{ positionId: 694, amount: '0.48' }])
    expect(result).toContain('3x')
    expect(result).toContain('余额不足')
  })
})

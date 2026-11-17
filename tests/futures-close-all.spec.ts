import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { normalizePublicInfo, type FuturesPosition } from '@/modules/futures/types'
import { buildContracts } from '@/modules/futures/contracts'

const marketClosePosition = vi.fn<(position: { contractId: number; orderSide: 'BUY' | 'SELL'; positionType: 1 | 2 }) => Promise<void>>()
const transferFunds = vi.fn<() => Promise<void>>()
vi.mock('@/modules/futures/api', async (original) => ({ ...(await original<typeof import('@/modules/futures/api')>()), marketClosePosition, transferFunds }))

const { TRANSFER_PENDING, useFuturesAccountStore } = await import('@/stores/futures-account')
const { ApiError } = await import('@/core/errors')
const { useFuturesMarketStore } = await import('@/stores/futures-market')

function position(id: number, contractId: number, orderSide: 'BUY' | 'SELL', positionType: 1 | 2): FuturesPosition {
  return { id, contractId, contractName: `C${contractId}`, orderSide, positionType } as unknown as FuturesPosition
}

describe('一键平仓', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    marketClosePosition.mockReset()
  })

  it('market-closes every position across contracts with the opposite side', async () => {
    marketClosePosition.mockResolvedValue()
    const account = useFuturesAccountStore()
    account.positions = [position(1, 1, 'BUY', 1), position(2, 2, 'SELL', 2)]
    expect(await account.closeAllAtMarket()).toEqual({ closed: 2, failures: [], busy: false })
    // A real MARKET close per position (never light_close, a LIMIT refused past the liquidation price).
    expect(marketClosePosition.mock.calls.map(([p]) => [p.contractId, p.orderSide, p.positionType])).toEqual([[1, 'BUY', 1], [2, 'SELL', 2]])
  })

  it('keeps closing the rest when one position is rejected and reports the failure', async () => {
    marketClosePosition.mockRejectedValueOnce(new Error('rejected')).mockResolvedValue()
    const account = useFuturesAccountStore()
    account.positions = [position(1, 1, 'BUY', 1), position(2, 2, 'SELL', 1)]
    const result = await account.closeAllAtMarket()
    expect(marketClosePosition).toHaveBeenCalledTimes(2)
    expect(result.closed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('C1')
    expect(result.failures[0]).toContain('rejected')
  })

  it('reports busy (nothing sent) instead of a false success when another action runs', async () => {
    const account = useFuturesAccountStore()
    account.positions = [position(1, 1, 'BUY', 1)]
    account.busy = 'order'
    expect(await account.closeAllAtMarket()).toEqual({ closed: 0, failures: [], busy: true })
    expect(marketClosePosition).not.toHaveBeenCalled()
  })
})

describe('划转处理中 (105000)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    transferFunds.mockReset()
    const market = useFuturesMarketStore()
    market.contracts = buildContracts(normalizePublicInfo({ contractList: [{ id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', marginCoin: 'USDT', coinResultVo: { fundsInStatus: 1, fundsOutStatus: 1 } }] }).contractList)
    vi.spyOn(market, 'refreshPublicInfo').mockResolvedValue()
  })

  it('reports a transfer the server settles asynchronously as pending, not as a failure', async () => {
    transferFunds.mockRejectedValue(new ApiError({ kind: 'api', code: '105000', message: '杠杆资金划转失败！' }))
    expect(await useFuturesAccountStore().transfer('contract_to_wallet', '1', 'USDT')).toBe(TRANSFER_PENDING)
  })

  it('rejects a transfer after the current configuration disables it, without sending or reporting success', async () => {
    const market = useFuturesMarketStore()
    vi.mocked(market.refreshPublicInfo).mockImplementation(async () => {
      market.contracts = market.contracts.map(contract => ({ ...contract, fundsOut: false }))
    })
    expect(await useFuturesAccountStore().transfer('contract_to_wallet', '1', 'USDT')).toContain('暂未开放划转')
    expect(transferFunds).not.toHaveBeenCalled()
  })

  it('still surfaces a definite rejection as an error', async () => {
    transferFunds.mockRejectedValue(new ApiError({ kind: 'api', code: '101000', message: '余额不足' }))
    expect(await useFuturesAccountStore().transfer('contract_to_wallet', '1', 'USDT')).toBe('余额不足')
  })
})

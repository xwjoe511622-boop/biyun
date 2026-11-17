import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FuturesPosition } from '@/modules/futures/types'

/**
 * 10-01 audit: the futures store's `run()` returned null (= success) when another action was running, so transfer,
 * adjust margin, TP/SL, leverage and margin mode reported success with nothing sent. A refused start is a message.
 */
const transferFunds = vi.fn<() => Promise<void>>()
const changePositionMargin = vi.fn<() => Promise<void>>()
const editLeverage = vi.fn<() => Promise<{ serverTopUp: boolean }>>()
const editMarginModel = vi.fn<() => Promise<void>>()
const createTpsl = vi.fn<() => Promise<void>>()
vi.mock('@/modules/futures/api', async (original) => ({ ...(await original<typeof import('@/modules/futures/api')>()), transferFunds, changePositionMargin, editLeverage, editMarginModel, createTpsl }))

const { useFuturesAccountStore } = await import('@/stores/futures-account')
const { useFuturesMarketStore } = await import('@/stores/futures-market')
const { useFuturesOrdersStore } = await import('@/stores/futures-orders')

const POS = { id: 7, contractId: 1, contractName: 'E-BTC-USDT', orderSide: 'BUY', positionType: 1, positionVolume: '10', canCloseVolume: '10', leverageLevel: 20 } as unknown as FuturesPosition

describe('a busy futures store never reports success', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useFuturesMarketStore().contracts = [{ id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', pricePrecision: 1, marginCoinPrecision: 6, marginCoin: 'USDT' } as never]
    useFuturesMarketStore().selectedName = 'E-BTC-USDT'
  })

  it('transfer, adjust margin, TP/SL, leverage, margin mode and close all say 另一操作进行中 and send nothing', async () => {
    const account = useFuturesAccountStore()
    account.busy = 'order'
    expect(await account.transfer('wallet_to_contract', '1', 'USDT')).toBe('另一操作进行中')
    expect(await account.adjustMargin(POS, '1')).toBe('另一操作进行中')
    expect(await account.createTpsl(POS, [{ triggerType: 2, triggerPrice: '90000', price: '0', type: 2, volume: '10' }])).toBe('另一操作进行中')
    expect(await account.setLeverage(10)).toBe('另一操作进行中')
    expect(await account.setMarginModel(2)).toBe('另一操作进行中')
    expect(await account.closeAtMarket(POS)).toBe('另一操作进行中')
    for (const fn of [transferFunds, changePositionMargin, editLeverage, editMarginModel, createTpsl]) expect(fn).not.toHaveBeenCalled()
  })

  it('incomplete inputs and pending cancels are messages too', async () => {
    const account = useFuturesAccountStore()
    expect(await account.createTpsl({ ...POS, positionType: null } as unknown as FuturesPosition, [])).toContain('无法执行')
    expect(await account.closeAtMarket({ ...POS, orderSide: '' } as unknown as FuturesPosition)).toContain('无法执行')
    const orders = useFuturesOrdersStore()
    expect(await orders.cancel({ id: 'pending-1', contractId: 1 }, false)).toContain('还在提交中')
  })
})

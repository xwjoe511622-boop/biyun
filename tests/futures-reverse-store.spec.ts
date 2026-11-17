import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FuturesContract } from '@/modules/futures/contracts'
import type { CreateOrderPayload } from '@/modules/futures/api'
import type { FuturesPosition } from '@/modules/futures/types'

/** 反手 (2026-09-30): light_close, then a market OPEN of the other side sized by value for contracts + ½. */
const marketClosePosition = vi.fn<(position: { contractId: number; orderSide: 'BUY' | 'SELL'; positionType: 1 | 2 }, wire?: { type: 2 | 3; price: string }) => Promise<void>>()
const createOrder = vi.fn<(payload: CreateOrderPayload) => Promise<string[]>>()
vi.mock('@/modules/futures/api', async (original) => ({ ...(await original<typeof import('@/modules/futures/api')>()), marketClosePosition, createOrder }))
// Short settle window so a test never waits the real 5 s.
vi.mock('@/modules/futures/reverse', () => ({ REVERSE_SETTLE_MS: 600, REVERSE_POLL_MS: 50 }))

const { useFuturesAccountStore } = await import('@/stores/futures-account')
const { useFuturesMarketStore } = await import('@/stores/futures-market')
const { ApiError } = await import('@/core/errors')
const { session } = await import('@/core/session')
const { FUTURES_API_PREFIX } = await import('@/modules/api/http')

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

const LONG = { id: 7, contractId: 1, contractName: 'E-BTC-USDT', orderSide: 'BUY', positionType: 2, positionVolume: '20', markPrice: '80000', leverageLevel: 20 } as unknown as FuturesPosition

describe('反手', () => {
  let assetsCalls = 0
  let shortAfter = Number.POSITIVE_INFINITY
  let longStays = false
  beforeEach(() => {
    setActivePinia(createPinia())
    assetsCalls = 0
    shortAfter = Number.POSITIVE_INFINITY
    longStays = false
    session.setToken('jwt')
    // 持仓 as the server answers it: the new short only from the `shortAfter`-th read on (the open fills asynchronously).
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
      if (path === 'position/get_assets_list') {
        assetsCalls += 1
        const positionList = longStays ? [{ ...LONG, canCloseVolume: '20' }]
          : assetsCalls >= shortAfter ? [{ ...LONG, id: 8, orderSide: 'SELL', positionVolume: '20', canCloseVolume: '20' }] : []
        return respond({ code: '0', data: { positionList, accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
      }
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 2 } })
      return respond({ code: '0', data: {} })
    }))
    marketClosePosition.mockReset().mockResolvedValue()
    createOrder.mockReset().mockResolvedValue(['9'])
    useFuturesMarketStore().contracts = [{ id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', pricePrecision: 2, marginCoinPrecision: 6, marginCoin: 'USDT' } as FuturesContract]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    session.clear()
  })

  it('closes the long, then opens a short of the same size with the same mode and leverage', async () => {
    const steps: number[] = []
    const result = await useFuturesAccountStore().reversePosition(LONG, (step) => steps.push(step))
    expect(result).toEqual({ ok: true, visible: false })
    expect(steps).toEqual([1, 2])
    expect(marketClosePosition).toHaveBeenCalledWith(expect.objectContaining({ contractId: 1, orderSide: 'BUY', positionType: 2, positionVolume: '20' }), { type: 2, price: '' }, expect.objectContaining({ create: expect.any(Function), cancel: expect.any(Function) }))
    // (20 + 0.5) x 0.0001 x 80000 = 164.00
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ contractId: 1, side: 'SELL', open: 'OPEN', type: 2, volume: '164.00', positionType: 2, leverageLevel: 20, contracts: '20' }))
    expect(marketClosePosition.mock.invocationCallOrder[0]).toBeLessThan(createOrder.mock.invocationCallOrder[0])
  })

  it('does not open when the close is refused', async () => {
    marketClosePosition.mockRejectedValue(new ApiError({ kind: 'api', code: '1', message: 'no' }))
    const result = await useFuturesAccountStore().reversePosition(LONG)
    expect(result).toMatchObject({ ok: false, step: 1, message: 'no' })
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('reports step 2 when the open is refused after the close', async () => {
    createOrder.mockRejectedValue(new ApiError({ kind: 'api', code: '2', message: 'margin' }))
    const result = await useFuturesAccountStore().reversePosition(LONG)
    expect(result).toMatchObject({ ok: false, step: 2, message: 'margin' })
  })

  it('prices the opening leg from the book of the POSITION contract passed by the dialog (page shows another, L640)', async () => {
    const levels = { asks: [], bids: [{ price: '83699.1', amount: '10' }, { price: '83680.6', amount: '100' }] }
    const result = await useFuturesAccountStore().reversePosition(LONG, undefined, { readLevels: async () => levels, last: () => '83705' })
    expect(result).toEqual({ ok: true, visible: false })
    // (10 x 83699.1 + 10 x 83680.6 + 0.5 x 83680.6) x 0.0001 = 171.56373 -> 171.56
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ contractId: 1, side: 'SELL', open: 'OPEN', volume: '171.56' }))
  })

  it('re-reads 持仓 after each step and keeps 2/2 up until the new short shows (09-30 live: short appeared late)', async () => {
    const account = useFuturesAccountStore()
    useFuturesMarketStore().selectedName = 'E-BTC-USDT'
    await account.refresh()
    assetsCalls = 0
    shortAfter = 3
    const steps: number[] = []
    const result = await account.reversePosition(LONG, (step) => steps.push(step))
    expect(result).toEqual({ ok: true, visible: true })
    expect(steps).toEqual([1, 2])
    // After step 1, after step 2, then polled until the short is there.
    expect(assetsCalls).toBeGreaterThanOrEqual(3)
    expect(account.positions.some((entry) => entry.orderSide === 'SELL' && entry.contractId === 1)).toBe(true)
  })

  it('stops polling after the settle window and still reports success (visible: false)', async () => {
    const started = Date.now()
    const result = await useFuturesAccountStore().reversePosition(LONG)
    expect(result).toEqual({ ok: true, visible: false })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops after step 1 when the close fills nothing (empty book): never opens the other side on top (10-01)', async () => {
    const account = useFuturesAccountStore()
    useFuturesMarketStore().selectedName = 'E-BTC-USDT'
    await account.refresh()
    longStays = true
    const result = await account.reversePosition(LONG)
    expect(result).toMatchObject({ ok: false, step: 1 })
    expect((result as { message: string }).message).toContain('市价平仓未成交')
    expect(createOrder).not.toHaveBeenCalled()
  }, 8000)
})

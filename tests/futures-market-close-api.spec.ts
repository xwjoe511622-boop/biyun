// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { marketClosePosition } from '@/modules/futures/api'

/**
 * 2026-09-30 owner bug: 市价 close refused with 10058 「预计成交价格低于强平价格，无法下单」 — light_close is a LIMIT at the
 * 10th opposite level and the server's liquidation-price check refuses it. A whole-position 市价 close is a real MARKET
 * CLOSE order (type 2), after cancelling the position's own resting close orders that hold part of it.
 */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let sent: { path: string; body: Record<string, unknown> }[] = []

beforeEach(() => {
  sent = []
  session.setToken('jwt')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    sent.push({ path, body })
    if (path === 'order/current_order_list') {
      return respond({ code: '0', data: { count: 3, orderList: [
        { id: 11, contractId: 1, side: 'SELL', open: 'CLOSE', type: 1, positionType: 1, price: '90000', volume: '15', dealVolume: '0', status: 0 },
        { id: 12, contractId: 1, side: 'BUY', open: 'OPEN', type: 1, positionType: 1, price: '70000', volume: '5', dealVolume: '0', status: 0 },
        { id: 13, contractId: 1, side: 'BUY', open: 'CLOSE', type: 1, positionType: 1, price: '70000', volume: '5', dealVolume: '0', status: 0 },
      ] } })
    }
    return respond({ code: '0', data: { ids: ['99'] } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  session.clear()
})

const LONG = { contractId: 1, orderSide: 'BUY' as const, positionType: 1 as const, positionVolume: '40', canCloseVolume: '40', leverageLevel: 20 }

describe('marketClosePosition', () => {
  it('sends one MARKET CLOSE order for the whole position (no light_close, no cancel when all is closable)', async () => {
    await marketClosePosition(LONG)
    expect(sent.map((entry) => entry.path)).toEqual(['order/order_create'])
    expect(sent[0].body).toMatchObject({ contractId: '1', side: 'SELL', open: 'CLOSE', type: '2', volume: '40', price: '' })
  })

  it('cancels only this position’s resting close orders first when they hold part of it', async () => {
    await marketClosePosition({ ...LONG, canCloseVolume: '25' })
    expect(sent.map((entry) => entry.path)).toEqual(['order/current_order_list', 'order/order_cancel', 'order/order_create'])
    expect(sent[1].body).toMatchObject({ contractId: '1', orderId: '11' })
    expect(sent[2].body).toMatchObject({ type: '2', open: 'CLOSE', side: 'SELL', volume: '40' })
  })
})
